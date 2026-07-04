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
import type { BFPlayerAPI, MediaTrack } from '../../player/types';

const props = defineProps<{
  track: MediaTrack;
  t?: (k: string) => string; // unused here, declared only to absorb the fallthrough from TrackActions.vue
  // player/client are forwarded to every registered track-action by
  // TrackActions.vue/ForumMediaPlayer.vue's blanket v-bind="$attrs", even
  // though this component doesn't need them. Declaring them (even unused)
  // turns them into real props instead of $attrs, so Vue stops warning
  // about "extraneous non-props attributes" on this fragment-root component.
  player?: BFPlayerAPI;
  client?: unknown;
}>();

const emit = defineEmits<{
  openPayoutModal: [post: { author: string; permlink: string; payout?: number }];
  submitVote: [post: { author: string; permlink: string }];
  // Not used by this component, but forwarded by the same blanket $attrs
  // mechanism above — declaring it absorbs the listener instead of leaving
  // it as an "extraneous non-emits event listener".
  openProfile: [payload: unknown];
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