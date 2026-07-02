<script setup lang="ts">
/**
 * Thin, generic host around the core MediaPlayer. Knows nothing about
 * payouts, votes, or sponsored content — each plugin that cares about
 * track-actions UI registers its own component via player.registerTrackAction()
 * (see blurt-player-plugin.ts and sponsored-plugin.ts) and TrackActions.vue
 * renders whatever's registered for each zone. This file only wires the
 * generic 'openTopic' click-through and forwards any listeners plugins
 * might need down to their own contributions.
 */
import MediaPlayer from '../../player/components/MediaPlayer.vue';
import TrackActions from '../../player/components/TrackActions.vue';
import type { BFPlayerAPI, MediaTrack } from '../../player/types';

const props = defineProps<{
  player: BFPlayerAPI;
  t: (k: string) => string;
}>();

const emit = defineEmits<{
  openTopic: [post: { author: string; permlink: string }];
}>();

const onTrackClick = (track: MediaTrack) => {
  if (track.author && track.permlink) {
    emit('openTopic', { author: track.author, permlink: track.permlink });
  }
};
</script>

<template>
  <MediaPlayer :player="player" :t="t" @track-click="onTrackClick">
    <template #track-actions="{ track, zone }">
      <TrackActions :track="track" :zone="zone" :player="player" :t="t" v-bind="$attrs" />
    </template>
  </MediaPlayer>
</template>
