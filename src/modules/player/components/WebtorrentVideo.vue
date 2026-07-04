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
import { currentSource, playWebtorrentFile } from '../player';
import * as WTPool from '../webtorrent-pool';
import type { TorrentSnapshot } from '../webtorrent-pool';
import WebtorrentInfoModal from './WebtorrentInfoModal.vue';
import WebtorrentPieceMap from './WebtorrentPieceMap.vue';

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

function refreshTorrent(): void {
  torrent.value = infoHash.value ? WTPool.getActiveTorrent(infoHash.value) : null;
}

function startPolling(): void {
  stopPolling();
  refreshTorrent();
  pollTimer = setInterval(refreshTorrent, 1000);
}
function stopPolling(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

watch(isWebtorrent, (active) => { if (active) startPolling(); else { stopPolling(); torrent.value = null; } }, { immediate: true });
watch(infoHash, refreshTorrent);
onUnmounted(stopPolling);

// ── Active file index (needed for the piece map + subtitle lookups) ───────
// torrent-lib.js only ever actively selects one non-subtitle file for
// playback at a time (see attachPlayback), so "the playable file with a
// progress figure" is a reliable way to recover which one that is from the
// plain snapshot, without player.ts needing to separately expose it.
const activeFileIndex = computed<number | null>(() => {
  const files = torrent.value?.files;
  if (!files) return null;
  const playable = files.find(f => f.isVideo || f.isAudio);
  return playable ? playable.index : null;
});

// ── Subtitles (delegates entirely to torrent-lib.js's format conversion) ──
// IMPORTANT: we never remove <track> elements once added. Removing and
// recreating a single <track> on every language switch (the previous
// approach) meant the browser's native CC menu only ever saw ONE subtitle
// option at a time (whichever was last selected) instead of the full list,
// and in Firefox specifically the native CC button could disappear
// altogether after the first switch and never come back — its captions UI
// doesn't reliably rebuild after a <track> is yanked out from under it
// mid-playback. Keeping every fetched track mounted (just toggling `.mode`
// between 'showing'/'disabled') sidesteps all of that and needs no
// browser-sniffing: every browser's native CC menu now lists every
// subtitle we've fetched, same as our own <select>, and stays in sync with it.
const subFiles = computed(() => (torrent.value?.files || []).filter(f => f.isSub));
const activeSubIdx = ref<string>('');
const subLoading = ref(false);
const subTrackEls = new Map<number, HTMLTrackElement>(); // file index -> mounted <track>
const subUrls = new Map<number, string>(); // file index -> blob URL, so we don't refetch/reconvert on re-selection

function setActiveSubtitleTrack(fileIdx: number | null): void {
  subTrackEls.forEach((el, idx) => {
    el.track.mode = idx === fileIdx ? 'showing' : 'disabled';
  });
}

function clearSubtitleTracks(): void {
  subTrackEls.forEach(el => el.remove());
  subTrackEls.clear();
  subUrls.forEach(url => URL.revokeObjectURL(url));
  subUrls.clear();
  activeSubIdx.value = '';
}

async function selectSubtitle(): Promise<void> {
  if (!activeSubIdx.value) {
    setActiveSubtitleTrack(null);
    return;
  }
  const fileIdx = Number(activeSubIdx.value);
  if (!infoHash.value) return;

  if (subTrackEls.has(fileIdx)) {
    setActiveSubtitleTrack(fileIdx);
    return;
  }

  const video = document.getElementById('bf-wt-player-video') as HTMLVideoElement | null;
  if (!video) return;

  subLoading.value = true;
  try {
    const track = await WTPool.getSubtitleTrack(infoHash.value, fileIdx);
    subUrls.set(fileIdx, track.url);
    const el = document.createElement('track');
    el.kind = 'subtitles';
    el.label = track.name;
    el.srclang = track.srclang;
    el.src = track.url;
    video.appendChild(el);
    subTrackEls.set(fileIdx, el);
    // Chrome (and, unreliably, Firefox) need the mode set explicitly after
    // the track's cues actually load to show it immediately.
    el.addEventListener('load', () => setActiveSubtitleTrack(fileIdx), { once: true });
  } catch (err) {
    console.warn('[WebtorrentVideo] subtitle not ready yet:', err);
  } finally {
    subLoading.value = false;
  }
}

// A new torrent/track means the previous subtitle files no longer apply —
// drop all mounted <track> elements and cached blob URLs.
watch(infoHash, clearSubtitleTracks);

onUnmounted(clearSubtitleTracks);

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
  if (hideTimer) clearTimeout(hideTimer);
  if (!isVideoPlaying()) return; // stay visible while paused/ended
  hideTimer = setTimeout(() => { controlsVisible.value = false; }, HIDE_DELAY_MS);
}

function showControls(): void {
  controlsVisible.value = true;
  scheduleHide();
}

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
    <div class="wtv-video-area" @mousemove="showControls" @mouseenter="showControls" @touchstart="showControls" @click="showControls">
      <!--
        WTPool.attachPlayback() (see loadWebtorrentSource in player.ts) assigns
        this element's src directly — a single persistent element, not
        recreated per track, since torrent-lib.js attaches/detaches its own
        stream to whatever element you hand it.
      -->
      <video id="bf-wt-player-video" class="bfp-video-iframe" controls playsinline controls-list="nodownload"></video>

      <div class="wtv-controls" v-if="isWebtorrent" :class="{ 'wtv-controls--hidden': !controlsVisible }">
        <button class="wtv-btn" @click="showInfo = true" :title="t('torrentInfo') || 'Torrent info'">
          <i class="fa-solid fa-circle-info"></i>
        </button>
        <select v-if="subFiles.length" v-model="activeSubIdx" @change="selectSubtitle" class="wtv-sub-select"
                :disabled="subLoading" :title="t('subtitles') || 'Subtitles'">
          <option value="">{{ t('subtitlesOff') || 'No subtitles' }}</option>
          <option v-for="f in subFiles" :key="f.index" :value="f.index">{{ f.name }}</option>
        </select>
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
      </div>
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
  display: flex;
  align-items: center;
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