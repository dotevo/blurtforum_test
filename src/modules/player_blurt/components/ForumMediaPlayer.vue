<script setup lang="ts">
/**
 * Blurt-aware wrapper around the generic MediaPlayer.
 * Renders the payout badge and vote button via the player's track-actions
 * slot, using the meta written there by BlurtPlayerPlugin. The generic
 * player core never needs to know these exist.
 *
 * Also renders the sponsored-ads "market info" button in the same slot —
 * unlike the payout badge, it isn't gated on track.permlink, since it's not
 * about the current track at all, it's a general "what's currently
 * sponsoring the player, and at what price" view.
 */
import { ref } from 'vue';
import MediaPlayer from '../../player/components/MediaPlayer.vue';
import PayoutBadge from '../../../components/layout/PayoutBadge.vue';
import VoteButton from '../../../components/layout/VoteButton.vue';
import SponsoredCampaignsModal from './SponsoredCampaignsModal.vue';
import type { BFPlayerAPI, MediaTrack } from '../../player/types';

const props = defineProps<{
  player: BFPlayerAPI;
  client: any;
  t: (k: string) => string;
}>();

const emit = defineEmits<{
  openProfile: [username: string];
  openTopic: [post: { author: string; permlink: string }];
  submitVote: [post: { author: string; permlink: string }];
  openPayoutModal: [post: { author: string; permlink: string; payout?: number }];
}>();

const onTrackClick = (track: MediaTrack) => {
  if (track.author && track.permlink) {
    emit('openTopic', { author: track.author, permlink: track.permlink });
  }
};

const onPayoutClick = (track: MediaTrack) => {
  if (track.author && track.permlink) {
    emit('openPayoutModal', { author: track.author, permlink: track.permlink, payout: track.meta?.payout as number | undefined });
  }
};

const onVote = (track: MediaTrack) => {
  if (track.author && track.permlink) {
    emit('submitVote', { author: track.author, permlink: track.permlink });
  }
};

const showSponsoredModal = ref(false);
</script>

<template>
  <MediaPlayer :player="player" :t="t" @track-click="onTrackClick">
    <template #track-actions="{ track }">
      <template v-if="track.permlink">
        <PayoutBadge
          :post="{ payout: track.meta?.payout as number, isPaid: (track.meta?.payout as number || 0) > 0 }"
          @click="onPayoutClick(track)"
        />
        <VoteButton
          :voted="!!track.meta?.voted"
          :count="(track.meta?.voteCount as number) || 0"
          @vote="onVote(track)"
        />
      </template>

      <button
        type="button"
        class="sp-ads-toggle"
        :title="t('sponsoredAds') || 'Sponsored ads / current prices'"
        @click.stop="showSponsoredModal = true"
      >
        <i class="fa-solid fa-bullhorn"></i>
      </button>
    </template>
  </MediaPlayer>

  <SponsoredCampaignsModal
    v-if="showSponsoredModal"
    :client="client"
    :t="t"
    @close="showSponsoredModal = false"
  />
</template>

<style scoped>
.sp-ads-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--primary, #006699);
  opacity: 0.7;
  cursor: pointer;
  font-size: 13px;
  transition: opacity 0.2s;
}
.sp-ads-toggle:hover { opacity: 1; }
</style>
