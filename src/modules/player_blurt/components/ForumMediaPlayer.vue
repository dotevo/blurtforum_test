<script setup lang="ts">
/**
 * Blurt-aware wrapper around the generic MediaPlayer.
 * Renders the payout badge and vote button via the player's track-actions
 * slot, using the meta written there by BlurtPlayerPlugin. The generic
 * player core never needs to know these exist.
 */
import MediaPlayer from '../../player/components/MediaPlayer.vue';
import PayoutBadge from '../../../components/layout/PayoutBadge.vue';
import VoteButton from '../../../components/layout/VoteButton.vue';
import type { BFPlayerAPI, MediaTrack } from '../../player/types';

defineProps<{
  player: BFPlayerAPI;
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
    </template>
  </MediaPlayer>
</template>
