const { test, expect } = require('@playwright/test');
const path = require('path');

const indexUrl = `file://${path.resolve(__dirname, '../index.html')}`;

test.describe('SEO URL Cleanups (TDD)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(indexUrl);
  });

  test('should drop community parameter when active forum is a virtual/exploration forum', async ({ page }) => {
    // Navigate to a virtual forum (global-trending)
    const url = await page.evaluate(async () => {
      // Find the virtual forum for trending
      const vf = window.app.explorationForm.forums.find(f => f.id === 'global-trending');
      if (vf) {
        window.app.openForum(vf);
      }
      // Wait for next tick / async syncUrl
      await new Promise(r => setTimeout(r, 100));
      return window.location.search;
    });

    // It should not contain 'community='
    expect(url).not.toContain('community=');
    expect(url).toContain('view=forum');
    expect(url).toContain('forum=global-trending');
  });

  test('should drop community parameter when viewing a topic that does not belong to the selected community', async ({ page }) => {
    const url = await page.evaluate(async () => {
      // Simulate viewing a topic with category 'other-tag' which is not the community account 'blurt-140455'
      const mockPost = {
        author: 'someauthor',
        permlink: 'some-permlink',
        category: 'other-tag',
        title: 'Mock Title',
        body: 'Mock Body',
        tags: ['other-tag'],
        created: '2026-07-10T12:00:00Z',
        payout: '0.000',
        vote_count: 0,
        beneficiaries: []
      };
      
      await window.app.openTopic(mockPost);
      await new Promise(r => setTimeout(r, 100));
      return window.location.search;
    });

    // The topic URL should not have community parameter since the post is not in the community
    expect(url).not.toContain('community=');
    expect(url).toContain('view=topic');
    expect(url).toContain('author=someauthor');
  });

  test('should drop community parameter in profile links and view profile page', async ({ page }) => {
    const url = await page.evaluate(async () => {
      window.app.openProfile('someuser');
      await new Promise(r => setTimeout(r, 100));
      return window.location.search;
    });

    // Profile page URL should not have community parameter
    expect(url).not.toContain('community=');
    expect(url).toContain('view=profile');
    expect(url).toContain('user=someuser');
  });
});
