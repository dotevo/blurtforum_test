<script setup lang="ts">
/**
 * modules/player/components/WebtorrentVideo.vue
 *
 * Everything WebTorrent-specific about the video area lives here, separate
 * from MediaPlayer.vue — the video element itself, the small overlay control
 * bar (torrent info, subtitle picker), the piece-map progress bar, and the
 * info modal. MediaPlayer.vue just mounts this unconditionally and knows
 * nothing about torrents.
 *
 * Cinema mode: this component never needs to know cinema mode exists.
 * Instead of reimplementing (or Teleporting) its own overlay into
 * MediaPlayer.vue's DOM, it registers plain descriptions of its controls —
 * two simple buttons (info/download) and two widgets (peers/speed +
 * subtitle picker, and the piece-map bar) — with the player's generic
 * cinema-contribution registry (registerPlayerButton/registerPlayerWidget in
 * player.ts). The player decides where/how those render; this file only
 * ever renders its OWN inline `.wtv-controls` bar for the non-cinema (docked/
 * expanded) view. See types.ts's PlayerButtonContribution/
 * PlayerWidgetContribution doc comments for the full reasoning, including
 * why this replaced an earlier Teleport-based approach.
 *
 * IMPORTANT: this component must stay mounted for the lifetime of the player
 * (toggled via CSS, not v-if) — player.ts caches a single reference to
 * #bf-wt-player-video via getElementById and calls WTPool.attachPlayback()
 * on it directly; if this component were unmounted/remounted, that cached
 * reference would go stale and playback would silently break.
 */
import { ref, computed, onMounted, onUnmounted, watch, shallowRef } from 'vue';
import {
  currentSource, wtActiveFileIndex, state as playerState,
  showCinemaControls as showSharedCinemaControls, togglePlay,
  registerPlayerButton, unregisterPlayerButton,
  registerPlayerWidget, unregisterPlayerWidget,
  registerExpandedTab,
} from '../player';
import * as WTPool from '../webtorrent-pool';
import type { TorrentSnapshot } from '../webtorrent-pool';
import WebtorrentPieceMap from './WebtorrentPieceMap.vue';
import WebtorrentExtras from './WebtorrentExtras.vue';
import WebtorrentAudioSubtitlePanel from './WebtorrentAudioSubtitlePanel.vue';

const props = defineProps<{
  t: (k: string) => string;
}>();

const isWebtorrent = computed(() => currentSource.value?.type === 'webtorrent');
const infoHash = computed(() => {
  const id = currentSource.value?.type === 'webtorrent' ? currentSource.value.id : null;
  return id ? WTPool.parseInfoHash(id) : null;
});

// ── Live torrent polling (only while a webtorrent track is showing) ────────
// WTPool.getActiveTorrent() (an alias for getTorrent()) hands back a FRESH
// plain snapshot object every call — important for Vue's prop
// change-detection: a child component receiving a mutated-in-place object
// would never see its props "change" (Object.is() stays true), so a fresh
// object every poll is what makes WebtorrentInfoModal / WebtorrentPieceMap
// actually update instead of freezing on their first render.
const torrent = shallowRef<TorrentSnapshot | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ── Stable file list for the subtitle/audio <select>s ──────────────────────
// Real bug this likely caused: WTPool.getActiveTorrent() (called every
// second by the poll below) always returns a brand-new snapshot object with
// a brand-new `files` array — torrent-lib.js's _snapshot() rebuilds it from
// scratch every call, even when nothing about the file list actually
// changed. Since subFiles/audioFiles below used to derive straight from
// `torrent.value.files`, that meant the <option> children of the
// subtitle/audio <select>s were being re-diffed by Vue every single second,
// for as long as a webtorrent track was open — including while the user has
// Android's native picker for one of them open. Android/Chrome's native
// <select> picker is known to misbehave (spawning an extra overlapping
// picker instance instead of updating the existing one) if the underlying
// <select>'s children are touched while its native dropdown is mid-open —
// which lines up exactly with "dozens of native comboboxes stacking until
// the backdrop goes solid black" happening specifically while picking a
// language. `stableFiles` only gets reassigned when the actual set of files
// (by index/name/type) differs from before, so a normal stats-only poll
// tick no longer touches the <select>s at all.
//
// IMPORTANT: this must be declared before the `watch(isWebtorrent, ...,
// { immediate: true })` below — that watcher runs its callback SYNCHRONOUSLY
// during setup() (that's what `immediate: true` means), and its call chain
// (startPolling -> refreshTorrent -> syncStableFiles) reaches `stableFiles`
// right away. A `const` declared further down the file is in the temporal
// dead zone until its own declaration line runs, so reaching it early from
// that synchronous callback threw "can't access lexical declaration
// 'stableFiles' before initialization" — a real crash, not just a lint nit.
const stableFiles = shallowRef<TorrentSnapshot['files']>([]);
let stableFilesSig = '';
function syncStableFiles(): void {
  const files = torrent.value?.files || [];
  const sig = files.map(f => `${f.index}:${f.name}:${f.isSub ? 1 : 0}:${f.isAudio ? 1 : 0}`).join('|');
  if (sig !== stableFilesSig) {
    stableFilesSig = sig;
    stableFiles.value = files;
  }
}

function refreshTorrent(): void {
  torrent.value = infoHash.value ? WTPool.getActiveTorrent(infoHash.value) : null;
  syncStableFiles();
}

function startPolling(): void {
  stopPolling();
  refreshTorrent();
  pollTimer = setInterval(refreshTorrent, 1000);
}
function stopPolling(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

watch(isWebtorrent, (active) => {
  if (active) startPolling();
  else { stopPolling(); torrent.value = null; stableFiles.value = []; stableFilesSig = ''; }
}, { immediate: true });
watch(infoHash, refreshTorrent);
onUnmounted(stopPolling);

// ── Active file index (needed for the piece map + subtitle lookups) ───────
// Real bug this fixed: this used to GUESS which file was playing via
// `files.find(f => f.isVideo || f.isAudio)` — the first video/audio file in
// the torrent, full stop. That's only right by accident for a single-video
// torrent; for anything with more than one video/audio file (multiple
// quality versions, or an alternate audio track sitting right alongside the
// video) it silently showed the WRONG file's download progress. player.ts
// now tracks the actually-attached file index directly (set right after a
// successful attachPlayback), so we just read that instead of re-deriving it.
const activeFileIndex = computed<number | null>(() => wtActiveFileIndex.value);

// ── "Download whole torrent" (offline playback later) ─────────────────────
// Streaming only ever fetches a lookahead window around the current
// position — this lets the user explicitly ask us to keep pulling every
// file until the whole torrent is local, so it can be replayed later with
// no network at all (see WTPool.downloadEntireTorrent's own comment for why
// this matters for a future offline-capable mobile app).
const fullDownload = ref(false);
watch(infoHash, (hash) => { fullDownload.value = hash ? WTPool.isFullDownload(hash) : false; }, { immediate: true });

function toggleFullDownload(): void {
  if (!infoHash.value) return;
  if (fullDownload.value) {
    WTPool.cancelFullDownload(infoHash.value);
    fullDownload.value = false;
  } else {
    WTPool.downloadEntireTorrent(infoHash.value);
    fullDownload.value = true;
  }
}

// ── Cinema-mode contributions ───────────────────────────────────────────
// The generic mechanism (see registerPlayerButton/registerPlayerWidget in
// player.ts) that replaced Teleporting `.wtv-controls`/WebtorrentPieceMap
// into MediaPlayer.vue's DOM. Registered once, unconditionally, right here
// -- the player itself only ever shows these while a webtorrent source is
// actually playing (each contribution's `sourceTypes: ['webtorrent']` is
// matched against whatever's current), so nothing in this component has to
// check `playerState.cinema`, or even know cinema mode exists, to make that
// happen.
registerPlayerButton({
  id: 'webtorrent-info',
  sourceTypes: ['webtorrent'],
  zone: 'cinema',
  icon: 'fa-solid fa-circle-info',
  label: 'Torrent info',
  onClick: () => { playerState.expanded = true; playerState.expandedTab = 'webtorrent-info'; },
});
registerPlayerButton({
  id: 'webtorrent-download',
  sourceTypes: ['webtorrent'],
  zone: 'cinema',
  icon: 'fa-solid fa-download',
  label: 'Download entire torrent for offline playback later',
  onClick: toggleFullDownload,
  active: () => fullDownload.value,
  badge: () => (fullDownload.value && torrent.value && !torrent.value.done)
    ? `${Math.round((torrent.value.progress || 0) * 100)}%`
    : null,
});
registerPlayerWidget({
  id: 'webtorrent-extras',
  sourceTypes: ['webtorrent'],
  zone: 'cinema-left',
  component: WebtorrentExtras,
  props: () => ({
    t: props.t,
    torrent: torrent.value,
    infoHash: infoHash.value,
    files: stableFiles.value,
    activeFileIndex: activeFileIndex.value,
    visible: effectiveControlsVisible.value,
    // The audio/subtitle ⋮ dropdown is deliberately left out of the cinema
    // widget below (see 'webtorrent-audio-subs' registerExpandedTab call
    // right after this) -- it's now a proper panel tab there instead. This
    // widget still contributes the peers/speed readout to the cinema-left
    // cluster same as before.
    showAudioMenu: false,
  }),
});

// Registered once, unconditionally, same as registerPlayerButton/Widget
// above (this component stays mounted for the player's whole lifetime, see
// this file's own top-of-file comment) -- there's no unregisterExpandedTab
// counterpart because registerExpandedTab is meant for exactly this kind of
// permanent-for-the-session contribution (same shape as a plugin's
// "Comments" tab), not something tied to a shorter-lived mount/unmount.
// `visible` hides it whenever a webtorrent source isn't the one playing,
// mirroring how MediaPlayer.vue's own hardcoded 'webtorrent-info' tab button
// is gated by `currentSource?.type === 'webtorrent'`.
//
// See WebtorrentAudioSubtitlePanel.vue's own comment for the real bug this
// fixes: the ⋮ dropdown (still used for the docked/expanded non-cinema
// overlay, see WebtorrentExtras.vue) is Teleported to <body> as a loose
// `position: fixed` box, which modules/cinema/dpad-nav.ts's zone-based D-pad
// navigation doesn't recognize as "a panel is open" at all -- so a TV
// remote/keyboard user could open it but never actually navigate or
// activate anything inside it, with arrows instead falling through to the
// PLAYER zone underneath (seeking/pausing the video). Registering this as a
// genuine expanded tab makes `player.state.expandedTab` equal this tab's own
// id while it's open, which is exactly the condition dpad-nav.ts's
// getOpenPanel() checks for -- Up/Down roving focus and Left/Right/Escape-
// to-close all work the same as they already do for Queue/Playlists/
// Settings/Torrent info, with no changes needed in dpad-nav.ts itself.
registerExpandedTab({
  id: 'webtorrent-audio-subs',
  label: props.t('audioSubtitleSettings') || 'Audio & subtitles',
  icon: 'fa-solid fa-closed-captioning',
  component: WebtorrentAudioSubtitlePanel,
  visible: () => isWebtorrent.value,
});

// The piece-map widget needs a resolved infoHash + attached file index to
// render anything meaningful (WebtorrentPieceMap's own props are both
// required, non-nullable) -- registered/unregistered as those become
// available/unavailable instead of unconditionally, mirroring the `v-if`
// this used to be gated behind before it was a Teleport target.
let pieceMapRegistered = false;
watch([infoHash, activeFileIndex], ([ih, fi]) => {
  const ready = ih != null && fi != null;
  if (ready && !pieceMapRegistered) {
    registerPlayerWidget({
      id: 'webtorrent-piece-map',
      sourceTypes: ['webtorrent'],
      zone: 'cinema-progress',
      component: WebtorrentPieceMap,
      props: () => ({
        infoHash: infoHash.value,
        fileIndex: activeFileIndex.value,
        t: props.t,
      }),
    });
    pieceMapRegistered = true;
  } else if (!ready && pieceMapRegistered) {
    unregisterPlayerWidget('webtorrent-piece-map');
    pieceMapRegistered = false;
  }
}, { immediate: true });

onUnmounted(() => {
  unregisterPlayerButton('webtorrent-info');
  unregisterPlayerButton('webtorrent-download');
  unregisterPlayerWidget('webtorrent-extras');
  if (pieceMapRegistered) unregisterPlayerWidget('webtorrent-piece-map');
});

// ── Seek-by-clicking-the-piece-map ─────────────────────────────────────────
function seekToFraction(frac: number): void {
  const video = document.getElementById('bf-wt-player-video') as HTMLVideoElement | null;
  if (!video || !video.duration || !isFinite(video.duration)) return;
  video.currentTime = frac * video.duration;
}

// ── Auto-hide overlay controls ─────────────────────────────────────────────
// The browser's own <video controls> chrome fades out after a few idle
// seconds and reappears on hover/tap — our overlay (info button, subtitle
// picker, peers/speed readout) didn't, so it just sat there permanently on
// top of the video. Mirror the native behavior: visible while paused or
// while the cursor/touch is active over the video, fading out a few
// seconds after the last interaction while playing.
const controlsVisible = ref(true);
let hideTimer: ReturnType<typeof setTimeout> | null = null;
const HIDE_DELAY_MS = 2500;

function isVideoPlaying(): boolean {
  const video = document.getElementById('bf-wt-player-video') as HTMLVideoElement | null;
  return !!video && !video.paused && !video.ended;
}

function scheduleHide(): void {
  if (playerState.cinema) return; // shared timer owns this in cinema mode
  if (hideTimer) clearTimeout(hideTimer);
  if (!isVideoPlaying()) return; // stay visible while paused/ended
  // WebtorrentAudioSubtitleMenu closes its own dropdown/panel on its own —
  // it watches the `visible` prop we pass it below, so nothing else to do here.
  hideTimer = setTimeout(() => { controlsVisible.value = false; }, HIDE_DELAY_MS);
}

function showControls(): void {
  if (playerState.cinema) { showSharedCinemaControls(); return; }
  controlsVisible.value = true;
  scheduleHide();
}

// What the template actually shows/hides: the shared cinema flag while in
// cinema mode (so this stays in lockstep with the top bar / side icons /
// anything else contributing to the same fullscreen chrome), our own local
// flag otherwise (normal forum usage, unchanged from before).
const effectiveControlsVisible = computed(() => playerState.cinema ? playerState.cinemaControlsVisible : controlsVisible.value);

onMounted(() => {
  const video = document.getElementById('bf-wt-player-video') as HTMLVideoElement | null;
  video?.addEventListener('play', scheduleHide);
  video?.addEventListener('pause', showControls);
});
onUnmounted(() => {
  if (hideTimer) clearTimeout(hideTimer);
  const video = document.getElementById('bf-wt-player-video') as HTMLVideoElement | null;
  video?.removeEventListener('play', scheduleHide);
  video?.removeEventListener('pause', showControls);
});

// ── Fullscreen ───────────────────────────────────────────────────────────
// Real bug this fixes: the native fullscreen button (part of <video
// controls>) calls requestFullscreen() on the <video> element ITSELF. Our
// overlay controls are a SIBLING of <video> (both children of
// .wtv-video-area), not a descendant of it — so native fullscreen doesn't
// just hide our overlay, it's not even part of the fullscreened subtree at
// all. Fullscreening .wtv-video-area instead (video + overlay together)
// fixes that: same element, same mousemove/touchstart/click listeners
// already wired up above, so show/hide-on-tap keeps working completely
// unchanged once inside fullscreen.
//
// Platform limits, being upfront about them:
// - `nofullscreen` in controls-list (added on the <video> tag below) hides
//   Chromium's native fullscreen button, so ours is the only one there.
//   Firefox does not support hiding it via controlsList — its own native
//   button remains and still does the old (overlay-less) per-<video>
//   fullscreen; ours is simply an extra button alongside it.
// - iOS Safari's video fullscreen is a completely separate native player
//   (AVPlayerViewController-style UI, not part of the page's DOM at all) —
//   there is no way to inject any custom overlay into it. Hard platform
//   limit, not something any web-side fix can work around.
const videoAreaEl = ref<HTMLElement | null>(null);
const isFullscreen = ref(false);

function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    videoAreaEl.value?.requestFullscreen?.().catch((err: unknown) => {
      console.warn('[WebtorrentVideo] fullscreen request failed:', err);
    });
  }
}

function onFullscreenChange(): void {
  isFullscreen.value = document.fullscreenElement === videoAreaEl.value;
}

onMounted(() => { document.addEventListener('fullscreenchange', onFullscreenChange); });
onUnmounted(() => { document.removeEventListener('fullscreenchange', onFullscreenChange); });

// Re-show whenever a fresh webtorrent track starts playing.
watch(isWebtorrent, (active) => { if (active) showControls(); });
</script>

<template>
  <div :class="{ 'bfp-media-hidden': !isWebtorrent }" class="bfp-video-iframe-wrap wtv-wrap">
    <!--
      Layout fix: this used to be a flat stack of children inside a
      plain `position:relative` div, but the global
      `.bfp-video-iframe-wrap, .bfp-video-iframe { height: 100% !important }`
      rule (shared with the YouTube/PeerTube panes, which only ever contain
      ONE full-bleed child) made the <video> itself fill 100% of wtv-wrap.
      The piece-map bar below it then had nowhere left to go and overflowed
      past the bottom of the panel, off-screen. wtv-wrap is now a column
      flexbox: `.wtv-video-area` is the ONLY flexible (flex:1) child, so
      "100%" for the <video> inside it now means 100% of that shrunk area,
      not 100% of the whole tab — leaving room for the fixed-height piece
      map + legend below it, all still fitting inside the tab's 100%.
    -->
    <div class="wtv-video-area" ref="videoAreaEl" @mousemove="showControls" @mouseenter="showControls" @touchstart="showControls" @click="showControls(); if (playerState.cinema) { if (playerState.expandedTab !== 'video') { playerState.expandedTab = 'video'; } else { togglePlay(); } }">
      <!--
        WTPool.attachPlayback() (see loadWebtorrentSource in player.ts) assigns
        this element's src directly — a single persistent element, not
        recreated per track, since torrent-lib.js attaches/detaches its own
        stream to whatever element you hand it.

        `:controls` is off while in cinema mode: MediaPlayer.vue's own
        transport row (play/pause/prev/next/volume/seek) plus this file's own
        piece-map/subtitle-picker widgets are a full replacement there (same
        principle as CINEMA_HIDE_NATIVE_CONTROLS for YouTube/PeerTube), so
        leaving the browser's native video chrome on top of all that just
        meant two independent control layers visually overlapping at the
        bottom of the screen. Outside cinema mode nothing else provides
        play/pause/seek for the docked/expanded view, so native controls
        stay on there.
      -->
      <video id="bf-wt-player-video" class="bfp-video-iframe" :controls="!playerState.cinema" playsinline controls-list="nodownload nofullscreen"></video>

      <div class="wtv-controls" v-if="isWebtorrent && !playerState.cinema" :class="{ 'wtv-controls--hidden': !effectiveControlsVisible }">
        <button class="wtv-btn" @click="playerState.expanded = true; playerState.expandedTab = 'webtorrent-info'" :title="t('torrentInfo') || 'Torrent info'">
          <i class="fa-solid fa-circle-info"></i>
        </button>
        <button class="wtv-btn" :class="{ 'wtv-btn--active': fullDownload }" @click="toggleFullDownload"
                :title="t('downloadWholeTorrent') || 'Download entire torrent for offline playback later'">
          <i v-if="fullDownload && torrent?.done" class="fa-solid fa-check"></i>
          <i v-else class="fa-solid fa-download"></i>
          <span v-if="fullDownload && torrent && !torrent.done" class="wtv-dl-pct">{{ Math.round((torrent.progress || 0) * 100) }}%</span>
        </button>
        <WebtorrentExtras
          :t="t"
          :torrent="torrent"
          :info-hash="infoHash"
          :files="stableFiles"
          :active-file-index="activeFileIndex"
          :visible="effectiveControlsVisible"
        />
        <button class="wtv-btn" @click="toggleFullscreen" :title="t('fullscreen') || 'Fullscreen'">
          <i class="fa-solid" :class="isFullscreen ? 'fa-compress' : 'fa-expand'"></i>
        </button>
      </div>
    </div>

    <!-- Downloaded/to-download piece map — the bar the user liked from the
         standalone PoC, now wired into the real player's UI. Only rendered
         inline here for the docked/expanded (non-cinema) layout, where it's
         a fixed-height sibling of .wtv-video-area; cinema mode gets the same
         component mounted by MediaPlayer.vue itself via the
         'webtorrent-piece-map' widget contribution registered above (cinema
         mode's video fills the whole screen, leaving no room for a sibling
         bar below it — same reason .wtv-controls above doesn't render there
         either). -->
    <WebtorrentPieceMap
      v-if="isWebtorrent && !playerState.cinema && infoHash != null && activeFileIndex != null"
      :info-hash="infoHash"
      :file-index="activeFileIndex"
      :t="props.t"
      @seek="seekToFraction"
    />
  </div>
</template>

<style scoped>
.wtv-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.wtv-video-area {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}
.wtv-video-area .bfp-video-iframe { height: 100% !important; }
.wtv-controls {
  position: absolute;
  top: 8px;
  right: 8px;
  left: 8px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 6px;
  z-index: 5;
  opacity: 1;
  transition: opacity 0.25s ease;
}
.wtv-controls--hidden {
  opacity: 0;
  pointer-events: none;
}
.wtv-btn {
  position: relative;
  background: rgba(0,0,0,.55);
  color: #fff;
  border: 1px solid rgba(255,255,255,.15);
  border-radius: 6px;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 13px;
}
.wtv-btn:hover { background: rgba(0,0,0,.75); }
.wtv-btn--active {
  background: rgba(35,130,90,.75);
  border-color: rgba(126,232,201,.5);
}
.wtv-btn--active:hover { background: rgba(35,150,100,.85); }
.wtv-dl-pct {
  position: absolute;
  bottom: -6px;
  right: -6px;
  background: #1b8a5a;
  color: #fff;
  border-radius: 8px;
  font-size: 9px;
  line-height: 1;
  padding: 2px 4px;
}
</style>