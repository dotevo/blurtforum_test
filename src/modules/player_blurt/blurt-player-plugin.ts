import { PostProcessor } from '../post-processor';
import { Blockchain } from '../blockchain';
import type { BFPlayerAPI, MediaTrack } from '../player/types';

/**
 * Player Plugin that fetches and updates Blurt-specific metadata
 * (payout, votes) when a track is loaded or changed.
 *
 * Blurt data is stored under track.meta (opaque to the player core) and
 * surfaced to the generic player UI via track.badge.
 */
export const BlurtPlayerPlugin = (client: any, auth: any) => ({
  name: 'BlurtMetadata',

  install(_player: BFPlayerAPI) {
    console.log('BlurtMetadataPlugin installed');
  },

  /**
   * Called automatically by BFPlayer when state.currentTrack changes
   */
  async onTrackChange(track: MediaTrack) {
    if (!track || !track.author || !track.permlink) return;

    try {
      // Fetch fresh content from blockchain
      const raw = await Blockchain.getContent(client, track.author, track.permlink);
      if (!raw || !raw.author) return;

      const normalized = PostProcessor.normalizePost(raw);
      const voted = !!(auth.user && normalized.active_votes.some(v => v.voter === auth.user.username && v.percent > 0));

      // Blurt-specific data lives in meta, opaque to the player core.
      // The UI for this (payout badge, vote button) is rendered by
      // ForumMediaPlayer via the player's track-actions slot, not by the player itself.
      track.meta = {
        ...track.meta,
        payout: normalized.payout,
        voteCount: normalized.vote_count,
        voted,
      };

      // If the track was pending metadata resolution (e.g. cover/title)
      if (track.pending) {
        track.title = normalized.title;
        track.cover = normalized.media?.cover || track.cover;
        track.pending = false;
      }
    } catch (e) {
      console.warn('BlurtMetadataPlugin: failed to fetch metadata', e);
    }
  }
});
