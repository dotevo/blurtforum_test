<script setup lang="ts">
/**
 * modules/player/components/WebtorrentExtras.vue
 *
 * Peers/download-speed readout + the subtitle/audio-track picker, factored
 * out of what used to be a single `.wtv-controls` block inline in
 * WebtorrentVideo.vue. Pulled into its own file for one reason: this exact
 * markup now needs to be mounted in two different places at once --
 *
 *  - inline, absolutely positioned over the video (the normal docked/
 *    expanded view, unchanged from before);
 *  - as a single PlayerWidgetContribution registered with the player for
 *    cinema mode's bottom bar (see WebtorrentVideo.vue's onMounted) --
 *    mounted directly by MediaPlayer.vue in its own template, never
 *    Teleported. That's what actually fixes "present but unclickable /
 *    overlapping" in cinema mode: a Teleported node can end up nested
 *    inside an ancestor with `backdrop-filter` (which creates a new
 *    containing block for `position: fixed` descendants -- see
 *    WebtorrentAudioSubtitleMenu.vue's own comment for the full story of
 *    what that broke), whereas a component the player mounts itself, in
 *    its own template, at a zone of its own choosing, never has that
 *    problem in the first place.
 *
 * No knowledge of cinema mode lives here at all -- this component just
 * renders whatever props it's handed. Whether that happens inline or via
 * the registry, and how the result is styled/positioned, is entirely up to
 * whoever mounts it.
 */
import type { TorrentSnapshot } from '../webtorrent-pool';
import WebtorrentAudioSubtitleMenu from './WebtorrentAudioSubtitleMenu.vue';

withDefaults(defineProps<{
  t: (k: string) => string;
  torrent: TorrentSnapshot | null;
  infoHash: string | null;
  files: TorrentSnapshot['files'];
  activeFileIndex: number | null;
  visible: boolean;
  /** The docked/expanded (non-cinema) inline mounting of this component
   *  (see WebtorrentVideo.vue's template) leaves this at its default of
   *  true -- the ⋮ dropdown is the only UI for subtitles/audio track there.
   *  The cinema-left widget mounting passes false: in cinema mode the same
   *  picker is a proper panel tab instead (registerExpandedTab'd
   *  'webtorrent-audio-subs', see WebtorrentVideo.vue and
   *  WebtorrentAudioSubtitlePanel.vue's own comment for why), so showing
   *  the dropdown there too would just be the same picker twice -- once
   *  reachable by D-pad, once not. */
  showAudioMenu?: boolean;
}>(), {
  showAudioMenu: true,
});
</script>

<template>
  <span v-if="torrent" class="wtv-peers" :title="t('peers') || 'Peers'">
    <i class="fa-solid fa-users"></i> {{ torrent.numPeers }}
  </span>
  <span v-if="torrent" class="wtv-speed" :title="t('downloadSpeed') || 'Download speed'">
    <i class="fa-solid fa-arrow-down"></i> {{ (torrent.downloadSpeed / 1024).toFixed(0) }} KB/s
  </span>
  <WebtorrentAudioSubtitleMenu
    v-if="showAudioMenu"
    :t="t"
    :info-hash="infoHash"
    :files="files"
    :active-file-index="activeFileIndex"
    :visible="visible"
  />
</template>

<style scoped>
.wtv-peers, .wtv-speed {
  background: rgba(0,0,0,.55);
  color: #fff;
  border: 1px solid rgba(255,255,255,.15);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 5px;
}
.wtv-speed { color: #7ee8c9; }
</style>
