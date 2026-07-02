<script setup lang="ts">
/**
 * modules/player_blurt/components/BlurtTrackActions.vue
 *
 * Registered by blurt-player-plugin.ts via player.registerTrackAction()
 * with zone: 'both' — shows in the mini bar and the expanded panel, same
 * as before. Reads payout/vote data from track.meta, which
 * BlurtPlayerPlugin's onTrackChange() populates. Hidden entirely for
 * tracks with no real post behind them (author/permlink undefined), e.g.
 * sponsored tracks.
 */
import PayoutBadge from '../../../components/layout/PayoutBadge.vue';
import VoteButton from '../../../components/layout/VoteButton.vue';
import type { MediaTrack } from '../../player/types';

const props = defineProps<{
  track: MediaTrack;
  t?: (k: string) => string; // unused here, declared only to absorb the fallthrough from TrackActions.vue
}>();

const emit = defineEmits<{
  openPayoutModal: [post: { author: string; permlink: string; payout?: number }];
  submitVote: [post: { author: string; permlink: string }];
}>();

const onPayoutClick = () => {
  if (props.track.author && props.track.permlink) {
    emit('openPayoutModal', {
      author: props.track.author,
      permlink: props.track.permlink,
      payout: props.track.meta?.payout as number | undefined,
    });
  }
};

const onVote = () => {
  if (props.track.author && props.track.permlink) {
    emit('submitVote', { author: props.track.author, permlink: props.track.permlink });
  }
};
</script>

<template>
  <template v-if="track.permlink">
    <PayoutBadge
      :post="{ payout: track.meta?.payout as number, isPaid: (track.meta?.payout as number || 0) > 0 }"
      @click="onPayoutClick"
    />
    <VoteButton
      :voted="!!track.meta?.voted"
      :count="(track.meta?.voteCount as number) || 0"
      @vote="onVote"
    />
  </template>
</template>
