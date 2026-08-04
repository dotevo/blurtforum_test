import { reactive } from 'vue';
import { Blockchain } from '../modules/blockchain';
import { BFUtils } from '../modules/utils';
import type { Post, Beneficiary, AuthUser } from '../types';

/**
 * Composable handling "support old content" logic.
 *
 * Flow when user clicks vote on a paid-out post:
 * 1. Scan direct children for existing support comment (matching beneficiaries)
 * 2a. Found  → vote on it directly with chosen weight
 * 2b. Not found → open modal (user writes body + picks weight) → create comment → vote
 * 3. Either way, also (best-effort, separately) vote on the ORIGINAL post
 *    itself -- see voteOnOriginalPost()'s own comment for why that's a
 *    second broadcast rather than bundled into step 2's.
 */
export function useSupport(
  client: any,
  auth: { user: AuthUser | null },
  broadcast: (ops: any[]) => Promise<void>,
  checkLock: (fn: () => any) => boolean,
  t: (k: string) => string
) {
  const modal = reactive({
    show: false,
    author: '',
    permlink: '',
    beneficiaries: [] as Beneficiary[],
    weight: parseInt(localStorage.getItem('bf-vote-weight') || '100'),
    body: '',
    status: '',
    loading: false,
    // When an existing support comment is found we store it here and skip creation
    existingPermlink: null as string | null,
    existingAuthor: null as string | null,
  });

  /**
   * Best-effort vote on the ORIGINAL paid-out post, in addition to the
   * support-comment vote both call sites below already do. Deliberately a
   * separate broadcast, not bundled into the same transaction as the
   * support-comment vote: Steem-family chains validate every op in a
   * transaction together and reject the whole transaction if any one op
   * fails, so if this chain rejects votes past a post's cashout window (the
   * whole reason the support-comment flow exists in the first place —
   * see this file's top-of-file comment), bundling it with the
   * support-comment vote would take that reliably-working vote down with
   * it. Kept independent so a rejection here (if the chain does still
   * reject it) can never break the part of the flow that already works.
   * Silently best-effort for the same reason -- this is a bonus, not the
   * point of the flow, so it doesn't get its own status message or thrown
   * error the user has to deal with.
   */
  const voteOnOriginalPost = async (weight: number): Promise<void> => {
    if (!auth.user) return;
    try {
      await broadcast([['vote', { voter: auth.user.username, author: modal.author, permlink: modal.permlink, weight }]]);
    } catch (err) {
      console.warn('Support: vote on original post failed (may be past its own cashout window on top of the support-comment path, or already voted):', err);
    }
  };

  const submitSupportComment = async (): Promise<void> => {
    if (checkLock(submitSupportComment)) return;
    if (!auth.user || !modal.author) return;

    const weight = Math.min(Math.max(Math.round(modal.weight), 1), 100) * 100;
    localStorage.setItem('bf-vote-weight', String(modal.weight));

    // If existing support comment found earlier, just vote on it
    if (modal.existingAuthor && modal.existingPermlink) {
      modal.loading = true;
      modal.status = t('votingOnSupport');
      try {
        await broadcast([['vote', {
          voter: auth.user.username,
          author: modal.existingAuthor,
          permlink: modal.existingPermlink,
          weight,
        }]]);
        void voteOnOriginalPost(weight);
        modal.status = t('supportSuccess');
        setTimeout(() => { modal.show = false; }, 1500);
      } catch (err: any) {
        console.error('Support vote error:', err);
        modal.status = 'Error: ' + err.message;
      }
      modal.loading = false;
      return;
    }

    modal.loading = true;
    modal.status = t('supporting');

    const permlink = BFUtils.genPermlink('support-' + modal.author);
    const beneficiaries = modal.beneficiaries.length
      ? [...modal.beneficiaries].sort((a, b) => a.account.localeCompare(b.account))
      : [{ account: modal.author, weight: 10000 }];

    const op = ['comment', {
      parent_author: modal.author,
      parent_permlink: modal.permlink,
      author: auth.user.username,
      permlink,
      title: '',
      body: `Supporting original content by @${modal.author}

${modal.body}`.trim(),
      json_metadata: JSON.stringify({ app: 'blurtforum/1.0', tags: ['blurt-140455'] }),
    }];
    const options = ['comment_options', {
      author: auth.user.username,
      permlink,
      max_accepted_payout: '1000000.000 BLURT',
      percent_steem_dollars: 10000,
      allow_votes: true,
      allow_curation_rewards: true,
      extensions: [[0, { beneficiaries }]],
    }];

    try {
      await broadcast([op, options]);
      modal.status = t('waitingForBlock');
      await new Promise(r => setTimeout(r, 5000));
      modal.status = t('votingOnSupport');
      await broadcast([['vote', {
        voter: auth.user.username,
        author: auth.user.username,
        permlink,
        weight,
      }]]);
      void voteOnOriginalPost(weight);
      modal.status = t('supportSuccess');
      setTimeout(() => { modal.show = false; }, 1500);
    } catch (err: any) {
      console.error('Support error:', err);
      modal.status = 'Error: ' + err.message;
    }
    modal.loading = false;
  };

  /**
   * Entry point called by useVote when user clicks vote on a paid-out post.
   * Scans children, then either opens modal (always) with pre-filled state.
   */
  const triggerSupport = async (post: Post): Promise<void> => {
    const user = auth.user?.username;
    if (!user) return;

    let children: any[] = [];
    try {
      children = await Blockchain.getContentReplies(client, post.author, post.permlink);
    } catch (e) {
      console.warn('Support scan failed:', e);
    }

    // Find existing support comment: posted by current user with matching beneficiaries
    const existing = children.find(c => {
      if (c.author !== user) return false;
      const cBens: Beneficiary[] = c.beneficiaries || [];
      const pBens: Beneficiary[] = post.beneficiaries || [];
      if (pBens.length === 0) {
        return cBens.length === 1 && cBens[0].account === post.author && cBens[0].weight === 10000;
      }
      if (cBens.length !== pBens.length) return false;
      const sorted = [...cBens].sort((a, b) => a.account.localeCompare(b.account));
      const orig   = [...pBens].sort((a, b) => a.account.localeCompare(b.account));
      return sorted.every((b, i) => b.account === orig[i].account && b.weight === orig[i].weight);
    });

    modal.author           = post.author;
    modal.permlink         = post.permlink;
    modal.beneficiaries    = post.beneficiaries || [];
    modal.weight           = parseInt(localStorage.getItem('bf-vote-weight') || '100');
    modal.body             = '';
    modal.status           = '';
    modal.loading          = false;
    modal.existingAuthor   = existing?.author ?? null;
    modal.existingPermlink = existing?.permlink ?? null;
    modal.show             = true;
  };

  return {
    supportModal: modal,
    submitSupportComment,
    triggerSupport,
  };
}
