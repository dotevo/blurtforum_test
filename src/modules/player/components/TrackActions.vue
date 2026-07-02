<script setup lang="ts">
/**
 * modules/player/components/TrackActions.vue
 *
 * Generic renderer for the track-action UI registry (see registerTrackAction
 * in player.ts). Knows nothing about Blurt, payouts, votes, or sponsored
 * content — it just mounts whatever's registered for the given zone, each
 * with its own props and each independent of the others. This is what lets
 * two unrelated plugins (e.g. BlurtMetadata and SponsoredContent) both
 * contribute to the track-actions area without importing each other or
 * being merged into one host component.
 *
 * Listeners passed to <TrackActions @foo="..."> are NOT declared here, so
 * they land in $attrs and get forwarded to every mounted contribution via
 * v-bind="$attrs" — each contribution simply emits whatever event names it
 * needs; contributions that don't emit a given event are unaffected.
 */
import { computed } from 'vue';
import type { BFPlayerAPI, MediaTrack, TrackActionZone } from '../types';

const props = defineProps<{
  track: MediaTrack;
  zone: Exclude<TrackActionZone, 'both'>;
  player: BFPlayerAPI;
  t?: (k: string) => string;
}>();

const actions = computed(() => props.player.getTrackActions(props.zone));
</script>

<template>
  <component
    v-for="action in actions"
    :key="action.id"
    :is="action.component"
    :track="track"
    :player="player"
    :t="t"
    v-bind="{ ...(action.props || {}), ...$attrs }"
  />
</template>
