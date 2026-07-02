import type { BFPlayerAPI, MediaTrack } from '../player/types';
import { Parser } from '../parser';
import SponsoredTrackAction from './components/SponsoredTrackAction.vue';
import {
  ensureCampaigns,
  startAutoRefresh,
  getActiveCampaigns,
  pickWeightedCampaign,
} from './sponsored-campaigns';
import type { SponsoredCampaign } from './sponsored-campaigns';

/**
 * module/player_blurt/sponsored-plugin.ts
 *
 * Injects sponsored tracks into the player's manual queue on 'next', per
 * module/player/README.md's documented extension point. Selection is a
 * two-stage random pick:
 *   1. roll whether this advance is sponsored at all (SPONSORED_RATIO cap) —
 *      skipped entirely if the track we're leaving was itself sponsored, so
 *      two ads can never play back-to-back regardless of how the user left it
 *      (manual skip, prev, or natural end).
 *   2. if so, weighted-random pick among active campaigns, weighted by BPS.
 *
 * The user can always skip manually (we never call lockSkip()). Instead we
 * force advancement after `sec` seconds via a plain timer armed right when
 * the track is queued (synchronous with playNext() draining the queue), and
 * disarmed the moment any other track becomes current for any reason.
 *
 * Sponsored tracks intentionally have author/permlink left undefined — there
 * is no real forum post behind them, and other Blurt-aware code already
 * treats a missing author/permlink as "nothing to show": BlurtPlayerPlugin
 * skips its payout/vote fetch, and ForumMediaPlayer's `v-if="track.permlink"`
 * hides the payout badge / vote button / "open thread" link. Because of that,
 * our own bookkeeping (which ad is currently armed) is keyed off
 * `track.meta.campaignId`, not author/permlink.
 */

const SPONSORED_RATIO = 0.2; // at most ~20% of eligible auto-advances may be sponsored
const SEC_MIN = 1;
const SEC_MAX = 120;

const clampSec = (sec: number): number => Math.min(SEC_MAX, Math.max(SEC_MIN, sec));

export const SponsoredPlayerPlugin = (client: any) => {
  let player: BFPlayerAPI | null = null;
  let armedCampaignId: string | null = null;
  let forcedTimer: ReturnType<typeof setTimeout> | null = null;

  const disarm = (): void => {
    if (forcedTimer) { clearTimeout(forcedTimer); forcedTimer = null; }
    armedCampaignId = null;
  };

  /**
   * Resolves the campaign's URL into a playable source using the same
   * Parser.detectMedia() the forum post parser uses, so behavior (and
   * supported host list) stays consistent with the rest of the app.
   * Returns null if unresolvable or of an unsupported type — the caller
   * treats that as "skip this round", not an error.
   */
  const buildSponsoredTrack = (campaign: SponsoredCampaign): MediaTrack | null => {
    const detected = Parser.detectMedia(campaign.url);
    if (!detected || !detected.type || !detected.id) {
      console.warn('[SponsoredPlugin] Could not resolve sponsored URL:', campaign.url);
      return null;
    }
    // MediaEntryMirror only supports these two for video ads; audio-only
    // sponsorship isn't meaningful here, and Rumble isn't wired into the
    // player core yet (would need a new source type + embed).
    if (detected.type !== 'youtube' && detected.type !== 'peertube') {
      console.warn('[SponsoredPlugin] Unsupported sponsored media type:', detected.type, campaign.url);
      return null;
    }

    return {
      // No real post backs a sponsored track — leaving these undefined is
      // what makes BlurtPlayerPlugin skip its payout/vote fetch and hides
      // the payout badge / vote button / "open thread" link in the UI.
      author: undefined,
      permlink: undefined,
      subId: `ad-${campaign.id}`,
      title: `🔸 Sponsored: ${campaign.from}`,
      sources: [{
        type: detected.type,
        id: detected.id,
        host: detected.host,
        thumb: detected.thumb,
      }],
      activeSourceIndex: 0,
      cover: detected.thumb,
      meta: { sponsored: true, campaignId: campaign.id, bps: campaign.bps },
    } as unknown as MediaTrack;
  };

  return {
    name: 'SponsoredContent',

    install(p: BFPlayerAPI) {
      player = p;

      ensureCampaigns(client).catch(e => console.warn('[SponsoredPlugin] initial fetch failed:', e));
      startAutoRefresh(client);

      // Own UI contribution, independent of any other plugin's — deliberately
      // 'expanded' only, so it never shows in the collapsed mini bar.
      p.registerTrackAction({
        id: 'sponsored-market-info',
        zone: 'expanded',
        component: SponsoredTrackAction,
        props: { client },
      });

      p.on('next', (outgoing) => {
        // Leaving any track — sponsored or not — cancels a previously armed
        // forced-skip. Do this unconditionally, first.
        disarm();

        // Never stack two sponsored tracks back-to-back: if the track we're
        // leaving was itself an ad, this round is guaranteed non-sponsored,
        // regardless of whether the user skipped it manually or it played
        // out naturally.
        const outgoingWasSponsored = (outgoing as MediaTrack | null)?.meta?.sponsored === true;
        if (outgoingWasSponsored) return;

        if (Math.random() > SPONSORED_RATIO) return;

        const active = getActiveCampaigns();
        if (!active.length) return;

        const chosen = pickWeightedCampaign(active);
        if (!chosen) return;

        const track = buildSponsoredTrack(chosen);
        if (!track) return; // unparseable/unsupported URL: just skip this round

        // Arm right here, synchronously — playNext() drains the manual queue
        // immediately after this handler returns, so the track we just
        // queued is guaranteed to become current before any other code runs.
        armedCampaignId = chosen.id;
        const sec = clampSec(chosen.sec);
        forcedTimer = setTimeout(() => { player?.playNext(true); }, sec * 1000);

        p.addToQueue(track, 'start');
      });
    },

    onTrackChange(track: MediaTrack) {
      // Only acts as a safety net for paths that bypass 'next' entirely
      // (e.g. a user directly clicking play on some other post's track).
      // If a different track becomes current for any such reason, disarm.
      const currentCampaignId = track?.meta?.campaignId as string | undefined;
      if (!armedCampaignId || currentCampaignId !== armedCampaignId) {
        disarm();
      }
    },
  };
};
