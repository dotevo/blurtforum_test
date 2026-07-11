import { PostProcessor } from '../post-processor';
import { Blockchain } from '../blockchain';
import BlurtTrackActions from './components/BlurtTrackActions.vue';
import BlurtPeerBadge from './components/BlurtPeerBadge.vue';
import { createBlurtWireExtension } from './blurt-peer-handshake';
import type { BFPlayerAPI, MediaTrack } from '../player/types';

/**
 * Player Plugin that fetches and updates Blurt-specific metadata
 * (payout, votes) when a track is loaded or changed.
 *
 * Blurt data is stored under track.meta (opaque to the player core).
 * The payout badge / vote button UI is its own independent component
 * (BlurtTrackActions.vue), registered below via registerTrackAction —
 * it doesn't need to know about, or be bundled with, any other plugin's UI.
 *
 * Also registers the webtorrent peer-identity handshake (stage 1 of the
 * "reward seeders" plan — see blurt-peer-handshake.ts for the protocol):
 * peers announce their Blurt account directly over the BitTorrent wire,
 * signed when possible, and peers get a badge in the existing peer list via
 * registerPeerAction() — verified (green check) or merely claimed (grey
 * question mark) depending on whether signing succeeded. Both use only the
 * player core's generic, protocol-agnostic `player.webtorrent.*` hooks —
 * the core has no idea any of this is Blurt-specific.
 *
 * `signMessage` — deliberately injected from outside, NOT implemented here.
 * This plugin has no business knowing whether the current account is a
 * local encrypted key (needing a PIN to unlock), a WhaleVault-backed
 * account (needing an interactive confirmation popup), or anything else —
 * exactly the same delegation as however image upload / voting already
 * sign things elsewhere in the app. Wire in that existing helper when
 * constructing this plugin; see blurt-peer-handshake.ts's top-of-file
 * comment for the exact contract (`(message: string) => Promise<string |
 * null>`, resolve `null` — don't throw — for "couldn't/declined to sign
 * right now", which the handshake gracefully degrades to an unverified
 * announcement instead of failing over).
 */
export const BlurtPlayerPlugin = (client: any, auth: any, signMessage: (message: string) => Promise<string | null>) => ({
  name: 'BlurtMetadata',

  install(player: BFPlayerAPI) {
    player.registerTrackAction({
      id: 'blurt-payout-vote',
      zone: 'both',
      component: BlurtTrackActions,
    });

    // `() => auth.user` (not `auth.user` captured once) so every new peer
    // connection picks up whoever is logged in right now, including
    // logging in/switching accounts after some connections are already
    // open.
    player.webtorrent.registerWireExtension(createBlurtWireExtension(client, () => auth.user, signMessage));
    player.webtorrent.registerPeerAction({
      id: 'blurt-peer-badge',
      component: BlurtPeerBadge,
    });
    console.log('[BlurtPlayerPlugin] peer-identity handshake + badge registered');
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