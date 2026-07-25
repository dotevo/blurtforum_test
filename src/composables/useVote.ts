import { reactive } from 'vue';
import { Blockchain } from '../modules/blockchain';
import type { Post, AuthUser, ActiveVote } from '../types';

/**
 * Composable for handling voting logic and state.
 *
 * Flow for paid-out posts (isPaid):
 *   submitVote → onOldPost(post)   (skips vote modal entirely)
 *
 * Flow for normal posts:
 *   submitVote → openVoteModal → submitVoteConfirmed → broadcast
 *
 * UX note: broadcasting a vote succeeds on-chain long before the RPC node
 * we read from reflects it (it polls for up to ~100s via waitAndReload).
 * To avoid the vote button looking "dead" during that window, we apply an
 * optimistic update to the post's active_votes/vote_count the moment the
 * broadcast is accepted, mark it with `_pendingVote`, and either let the
 * real data (fetched by waitAndReload) replace it, or roll it back if the
 * broadcast itself fails.
 */
export function useVote(
  client: any,
  auth: { user: AuthUser | null },
  broadcast: (ops: any[]) => Promise<void>,
  waitAndReload: any,
  t: (k: string) => string,
  onOldPost?: (post: Post) => Promise<void>
) {
  const voteModal = reactive({
    show: false,
    post: null as Post | null,
    weight: parseInt(localStorage.getItem('bf-vote-weight') || '100'),
    estimatedValue: null as null | { vpCostPct: string; vpAfter: string; voteValue: string; fee: string },
    estimating: false
  });

  const estimateVote = async (weight: number): Promise<void> => {
    if (!auth.user) return;
    voteModal.estimating = true;
    const est = await Blockchain.estimateVoteValue(client, auth.user.username, weight);
    if (est) voteModal.estimatedValue = est;
    voteModal.estimating = false;
  };

  const openVoteModal = (post: Post): void => {
    voteModal.post = post;
    voteModal.show = true;
    Blockchain.fetchFeeInfo(client).then(() => estimateVote(voteModal.weight));
  };

  const hasVoted = (post: Post): boolean => {
    return !!(auth.user && post.active_votes?.some(v => v.voter === auth.user!.username && v.percent > 0));
  };

  /**
   * Mutates `post` in place to reflect a vote/unvote before the chain data
   * catches up. Returns a snapshot so the caller can roll back on error.
   */
  const applyOptimisticVote = (post: Post, voter: string, percent: number) => {
    const snapshot = { active_votes: post.active_votes ? [...post.active_votes] : [], vote_count: post.vote_count };
    const wasVoted = hasVoted(post);
    const votes = snapshot.active_votes.filter(v => v.voter !== voter);
    if (percent > 0) {
      votes.push({ voter, percent } as ActiveVote);
      post.vote_count = (post.vote_count || 0) + (wasVoted ? 0 : 1);
    } else {
      post.vote_count = Math.max(0, (post.vote_count || 0) - 1);
    }
    post.active_votes = votes;
    post._pendingVote = true;
    return snapshot;
  };

  const rollbackVote = (post: Post, snapshot: { active_votes: ActiveVote[]; vote_count: number }) => {
    post.active_votes = snapshot.active_votes;
    post.vote_count = snapshot.vote_count;
    post._pendingVote = false;
  };

  const submitVoteConfirmed = async (): Promise<void> => {
    voteModal.show = false;
    if (!auth.user || !voteModal.post) return;

    const post = voteModal.post;
    const weight = Math.min(Math.max(Math.round(voteModal.weight), 1), 100) * 100;
    localStorage.setItem('bf-vote-weight', String(voteModal.weight));
    const voter = auth.user.username;

    const snapshot = applyOptimisticVote(post, voter, weight);
    try {
      await broadcast([['vote', { voter, author: post.author, permlink: post.permlink, weight }]]);
      await waitAndReload(
        true, post.author, post.permlink,
        (c: any) => (c.active_votes || []).some((v: any) => v.voter === voter && v.percent > 0),
        t('syncingWithBlockchain')
      );
    } catch (err) {
      console.error('Vote error:', err);
      rollbackVote(post, snapshot);
      throw err;
    }
  };

  const submitVote = async (
    post: Post | { author: string; permlink: string },
    getFullPost: (p: any) => Promise<Post>
  ): Promise<void> => {
    if (!auth.user) throw new Error('NOT_LOGGED_IN');

    let fullPost: Post;
    if (!('active_votes' in post)) {
      fullPost = await getFullPost(post);
    } else {
      fullPost = post as Post;
    }

    if (hasVoted(fullPost)) {
      if (!confirm(t('confirmUnvote'))) return;
      const voter = auth.user.username;
      const snapshot = applyOptimisticVote(fullPost, voter, 0);
      try {
        await broadcast([['vote', { voter, author: fullPost.author, permlink: fullPost.permlink, weight: 0 }]]);
        await waitAndReload(
          false, fullPost.author, fullPost.permlink,
          (c: any) => !(c.active_votes || []).some((v: any) => v.voter === voter && v.percent > 0),
          t('syncingWithBlockchain')
        );
      } catch (err) {
        console.error('Unvote error:', err);
        rollbackVote(fullPost, snapshot);
        throw err;
      }
      return;
    }

    // Paid-out post: skip vote modal, go directly to support flow
    if (fullPost.isPaid && onOldPost) {
      await onOldPost(fullPost);
      return;
    }

    openVoteModal(fullPost);
  };

  return {
    voteModal,
    estimateVote,
    openVoteModal,
    hasVoted,
    submitVoteConfirmed,
    submitVote
  };
}
