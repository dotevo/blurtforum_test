/**
 * LocalStorage-backed drafts for post creation and replies.
 * Pure storage logic — no Vue reactivity assumptions beyond plain object mutation.
 */
export function useDrafts() {

  // ── New post drafts (one per forum/community) ────────────────────────────
  const getDraftKey = (communityAccount: string, forumId: string | undefined) =>
    `bf-draft-${communityAccount}-${forumId || 'x'}`;

  const saveDraft = (
    communityAccount: string,
    forumId: string | undefined,
    postForm: { title: string; body: string; selectedTag: string; customTags: string; hasDraft: boolean },
    data?: { title: string; body: string; selectedTag?: string; customTags?: string }
  ) => {
    if (data) {
      postForm.title = data.title;
      postForm.body = data.body;
      if (data.selectedTag) postForm.selectedTag = data.selectedTag;
      if (data.customTags !== undefined) postForm.customTags = data.customTags;
    }
    if (!postForm.title && !postForm.body) return;
    localStorage.setItem(
      getDraftKey(communityAccount, forumId),
      JSON.stringify({ title: postForm.title, body: postForm.body, selectedTag: postForm.selectedTag, customTags: postForm.customTags, ts: Date.now() })
    );
  };

  const loadDraft = (
    communityAccount: string,
    forumId: string | undefined,
    postForm: { title: string; body: string; selectedTag: string; customTags: string; hasDraft: boolean }
  ) => {
    try {
      const d = localStorage.getItem(getDraftKey(communityAccount, forumId));
      if (d) {
        const p = JSON.parse(d);
        postForm.title = p.title || '';
        postForm.body = p.body || '';
        if (p.selectedTag) postForm.selectedTag = p.selectedTag;
        if (p.customTags) postForm.customTags = p.customTags;
        postForm.hasDraft = true;
      }
    } catch { /* ignore */ }
  };

  const clearDraft = (
    communityAccount: string,
    forumId: string | undefined,
    postForm: { hasDraft: boolean }
  ) => {
    localStorage.removeItem(getDraftKey(communityAccount, forumId));
    postForm.hasDraft = false;
  };

  // ── Reply drafts (one per author/permlink being replied to) ──────────────
  const getReplyDraftKey = (author: string, permlink: string) => `bf-reply-draft-${author}-${permlink}`;

  const cleanupDrafts = () => {
    const now = Date.now();
    const month = 30 * 24 * 60 * 60 * 1000;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith('bf-reply-draft-')) {
          const d = JSON.parse(localStorage.getItem(key)!);
          if (now - (d.ts || 0) > month) { localStorage.removeItem(key); i--; }
        }
      }
    } catch { /* ignore */ }
  };

  const saveReplyDraft = (author: string, permlink: string, body: string) => {
    if (!body) { localStorage.removeItem(getReplyDraftKey(author, permlink)); return; }
    localStorage.setItem(getReplyDraftKey(author, permlink), JSON.stringify({ body, ts: Date.now() }));
    if (Math.random() < 0.1) cleanupDrafts();
  };

  const loadReplyDraft = (author: string, permlink: string): string => {
    try {
      const d = localStorage.getItem(getReplyDraftKey(author, permlink));
      if (d) return JSON.parse(d).body;
    } catch { /* ignore */ }
    return '';
  };

  const clearReplyDraft = (author: string, permlink: string) =>
    localStorage.removeItem(getReplyDraftKey(author, permlink));

  return {
    saveDraft,
    loadDraft,
    clearDraft,
    saveReplyDraft,
    loadReplyDraft,
    clearReplyDraft,
    cleanupDrafts,
  };
}
