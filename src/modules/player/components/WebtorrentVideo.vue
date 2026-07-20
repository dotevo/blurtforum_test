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
 * IMPORTANT: this component must stay mounted for the lifetime of the player
 * (toggled via CSS, not v-if) — player.ts caches a single reference to
 * #bf-wt-player-video via getElementById and calls WTPool.attachPlayback()
 * on it directly; if this component were unmounted/remounted, that cached
 * reference would go stale and playback would silently break.
 */
import { ref, computed, onMounted, onUnmounted, watch, shallowRef } from 'vue';
import { currentSource, playWebtorrentFile, wtActiveFileIndex, state as playerState, showCinemaControls as showSharedCinemaControls, togglePlay } from '../player';
import * as WTPool from '../webtorrent-pool';
import type { TorrentSnapshot } from '../webtorrent-pool';
import WebtorrentInfoModal from './WebtorrentInfoModal.vue';
import WebtorrentPieceMap from './WebtorrentPieceMap.vue';
import WebtorrentAudioSubtitleMenu from './WebtorrentAudioSubtitleMenu.vue';

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

// ── Seek-by-clicking-the-piece-map ─────────────────────────────────────────
function seekToFraction(frac: number): void {
  const video = document.getElementById('bf-wt-player-video') as HTMLVideoElement | null;
  if (!video || !video.duration || !isFinite(video.duration)) return;
  video.currentTime = frac * video.duration;
}

// ── Manual file selection (per user request: let them click Play on any
// file in the list, the same sanity-check workflow the working PoC
// supported) ────────────────────────────────────────────────────────────
function onPlayFile(fileIndex: number): void {
  console.log('[WebtorrentVideo] Manual file selection requested — file index', fileIndex);
  playWebtorrentFile(fileIndex);
}

// ── Info modal ───────────────────────────────────────────────────────────
const showInfo = ref(false);

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
      -->
      <video id="bf-wt-player-video" class="bfp-video-iframe" controls playsinline controls-list="nodownload nofullscreen"></video>

      <Teleport to="#bfp-cinema-extra-controls" :disabled="!playerState.cinema">
        <div class="wtv-controls" v-if="isWebtorrent" :class="{ 'wtv-controls--hidden': !effectiveControlsVisible, 'wtv-controls--cinema': playerState.cinema }">
          <button class="wtv-btn" @click="showInfo = true" :title="t('torrentInfo') || 'Torrent info'">
            <i class="fa-solid fa-circle-info"></i>
          </button>
          <button class="wtv-btn" :class="{ 'wtv-btn--active': fullDownload }" @click="toggleFullDownload"
                  :title="t('downloadWholeTorrent') || 'Download entire torrent for offline playback later'">
            <i v-if="fullDownload && torrent?.done" class="fa-solid fa-check"></i>
            <i v-else class="fa-solid fa-download"></i>
            <span v-if="fullDownload && torrent && !torrent.done" class="wtv-dl-pct">{{ Math.round((torrent.progress || 0) * 100) }}%</span>
          </button>
          <span v-if="torrent" class="wtv-peers" :title="t('peers') || 'Peers'">
            <i class="fa-solid fa-users"></i> {{ torrent.numPeers }}
          </span>
          <span v-if="torrent" class="wtv-speed" :title="t('downloadSpeed') || 'Download speed'">
            <i class="fa-solid fa-arrow-down"></i> {{ (torrent.downloadSpeed / 1024).toFixed(0) }} KB/s
          </span>
          <button v-if="!playerState.cinema" class="wtv-btn" @click="toggleFullscreen"
                  :title="t('fullscreen') || 'Fullscreen'">
            <i class="fa-solid" :class="isFullscreen ? 'fa-compress' : 'fa-expand'"></i>
          </button>
          <!--
            Subtitles + alternate audio track, entirely self-contained — see
            WebtorrentAudioSubtitleMenu.vue's own top-of-file comment for why
            this had to be its own component rather than inline markup here:
            it must have ZERO reactive dependency on `torrent` (updated every
            second above) so a stats poll tick can never touch it, even
            indirectly through a shared render pass. `files`/`activeFileIndex`
            only actually change when the file list or the attached file index
            change — not every second — so this only re-renders when something
            real changes.
          -->
          <WebtorrentAudioSubtitleMenu
            :t="t"
            :info-hash="infoHash"
            :files="stableFiles"
            :active-file-index="activeFileIndex"
            :visible="effectiveControlsVisible"
          />
        </div>
      </Teleport>
    </div>

    <!-- Downloaded/to-download piece map — the bar the user liked from the
         standalone PoC, now wired into the real player's UI. Fixed-height
         sibling of .wtv-video-area (not stacked on top of it), so it's
         always visible under the video instead of overflowing off-screen. -->
    <WebtorrentPieceMap
      v-if="isWebtorrent && infoHash != null && activeFileIndex != null"
      :info-hash="infoHash"
      :file-index="activeFileIndex"
      :t="props.t"
      @seek="seekToFraction"
    />

    <WebtorrentInfoModal :show="showInfo" :torrent="torrent" :t="props.t" @close="showInfo = false" @play-file="onPlayFile" />
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
.wtv-controls--cinema {
  position: static;
  top: auto; left: auto; right: auto;
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
.wtv-sub-select {
  background: rgba(0,0,0,.55);
  color: #fff;
  border: 1px solid rgba(255,255,255,.15);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 11px;
  max-width: 160px;
}
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