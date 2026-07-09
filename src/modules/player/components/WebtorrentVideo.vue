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
import {
  currentSource, playWebtorrentFile, wtActiveFileIndex,
  wtAudioTrackIndex, wtAudioMode, wtAudioOffsetMs, wtAudioOrigVolume, wtAudioTrackVolume,
  selectWebtorrentAudioTrack, setWebtorrentAudioMode, setWebtorrentAudioOffsetMs,
  setWebtorrentAudioOrigVolume, setWebtorrentAudioTrackVolume,
} from '../player';
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
const subFiles = computed(() => stableFiles.value.filter(f => f.isSub));
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

// ── Alternate audio track (lektor/dub) ─────────────────────────────────────
// Candidate files: audio-typed, and not whatever the main video/audio file
// currently is (so a torrent whose "video" file is itself audio-only, e.g. a
// pure-audio torrent, doesn't offer itself as its own alternate track).
const audioFiles = computed(() => stableFiles.value.filter(f => f.isAudio && f.index !== activeFileIndex.value));
const activeAudioIdx = computed<string>(() => wtAudioTrackIndex.value == null ? '' : String(wtAudioTrackIndex.value));

function selectAudioTrack(e: Event): void {
  const val = (e.target as HTMLSelectElement).value;
  selectWebtorrentAudioTrack(val === '' ? null : Number(val));
}

// Advanced audio panel (offset + the two independent volume sliders) — only
// meaningful once a track is actually selected, so the gear only shows then.
const showAudioAdvanced = ref(false);
watch(activeAudioIdx, (idx) => { if (!idx) showAudioAdvanced.value = false; });

const offsetSecDisplay = computed(() => (wtAudioOffsetMs.value / 1000).toFixed(1));
function onOffsetInput(e: Event): void {
  setWebtorrentAudioOffsetMs(Number((e.target as HTMLInputElement).value));
}
function onOrigVolumeInput(e: Event): void {
  setWebtorrentAudioOrigVolume(Number((e.target as HTMLInputElement).value));
}
function onTrackVolumeInput(e: Event): void {
  setWebtorrentAudioTrackVolume(Number((e.target as HTMLInputElement).value));
}
function onAudioModeChange(e: Event): void {
  setWebtorrentAudioMode((e.target as HTMLSelectElement).value as 'lektor' | 'dub');
}

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

// ── Mobile "more" overflow menu ─────────────────────────────────────────────
// On a narrow screen there isn't room to show the subtitle picker, audio
// picker, audio-settings gear, download button and peers/speed readout all
// inline at once (see .wtv-controls-collapsible media query below) — they
// collapse into a single "⋮" button, same idea as YouTube's mobile overflow
// menu. Desktop is unaffected (CSS keeps everything inline there and hides
// the "⋮" button entirely).
const showMoreMenu = ref(false);

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
  hideTimer = setTimeout(() => { controlsVisible.value = false; showMoreMenu.value = false; showAudioAdvanced.value = false; }, HIDE_DELAY_MS);
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
        <button class="wtv-btn wtv-more-btn" :class="{ 'wtv-btn--active': showMoreMenu }"
                @click="showMoreMenu = !showMoreMenu" :title="t('moreOptions') || 'More options'">
          <i class="fa-solid fa-ellipsis-vertical"></i>
        </button>
        <div class="wtv-controls-collapsible" :class="{ 'wtv-controls-collapsible--open': showMoreMenu }">
          <select v-if="subFiles.length" v-model="activeSubIdx" @change="selectSubtitle" class="wtv-sub-select"
                  :disabled="subLoading" :title="t('subtitles') || 'Subtitles'">
            <option value="">{{ t('subtitlesOff') || 'No subtitles' }}</option>
            <option v-for="f in subFiles" :key="f.index" :value="f.index">{{ f.name }}</option>
          </select>
          <select v-if="audioFiles.length" :value="activeAudioIdx" @change="selectAudioTrack" class="wtv-sub-select"
                  :title="t('audioTrack') || 'Audio track'">
            <option value="">{{ t('audioTrackOriginal') || 'Original audio' }}</option>
            <option v-for="f in audioFiles" :key="f.index" :value="f.index">{{ f.name }}</option>
          </select>
          <button v-if="activeAudioIdx" class="wtv-btn" :class="{ 'wtv-btn--active': showAudioAdvanced }"
                  @click="showAudioAdvanced = !showAudioAdvanced"
                  :title="t('audioTrackSettings') || 'Audio track settings (sync, volume)'">
            <i class="fa-solid fa-sliders"></i>
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
        </div>
      </div>

      <div v-if="isWebtorrent && showAudioAdvanced && activeAudioIdx" class="wtv-audio-panel" @click.stop @mousemove.stop>
        <div class="wtv-audio-panel-row">
          <label>{{ t('audioTrackMode') || 'Mode' }}</label>
          <select :value="wtAudioMode" @change="onAudioModeChange">
            <option value="dub">{{ t('audioTrackModeDub') || 'Replace original (dubbing)' }}</option>
            <option value="lektor">{{ t('audioTrackModeLektor') || 'Alongside original (lektor)' }}</option>
          </select>
        </div>
        <div class="wtv-audio-panel-row">
          <label>{{ t('audioTrackOffset') || 'Sync offset' }} ({{ offsetSecDisplay }}s)</label>
          <input type="range" min="-10000" max="10000" step="100" :value="wtAudioOffsetMs" @input="onOffsetInput" />
        </div>
        <div class="wtv-audio-panel-row">
          <label>{{ t('audioTrackOrigVolume') || 'Original volume' }}</label>
          <input type="range" min="0" max="1" step="0.05" :value="wtAudioOrigVolume" @input="onOrigVolumeInput" />
        </div>
        <div class="wtv-audio-panel-row">
          <label>{{ t('audioTrackVolume') || 'Track volume' }}</label>
          <input type="range" min="0" max="1" step="0.05" :value="wtAudioTrackVolume" @input="onTrackVolumeInput" />
        </div>
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
.wtv-more-btn {
  display: none; /* only shown on narrow screens, see media query below */
}
.wtv-controls-collapsible {
  display: flex;
  align-items: center;
  gap: 6px;
}
.wtv-speed { color: #7ee8c9; }
.wtv-audio-panel {
  position: absolute;
  top: 44px;
  right: 8px;
  z-index: 7;
  background: rgba(0,0,0,.85);
  border: 1px solid rgba(255,255,255,.15);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 220px;
}
.wtv-audio-panel-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.wtv-audio-panel-row label {
  color: #fff;
  font-size: 10px;
  opacity: .85;
}
.wtv-audio-panel-row select {
  background: rgba(255,255,255,.08);
  color: #fff;
  border: 1px solid rgba(255,255,255,.15);
  border-radius: 5px;
  padding: 4px 6px;
  font-size: 11px;
}
.wtv-audio-panel-row input[type="range"] {
  width: 100%;
}

/* Mobile: too many controls to show inline at once (this is what was
   crowding out the language/subtitle pickers) — collapse everything except
   the info button behind a single "⋮" overflow button, same pattern as
   YouTube's mobile settings menu. */
@media (max-width: 640px) {
  .wtv-more-btn { display: flex; }
  .wtv-controls-collapsible {
    display: none;
  }
  .wtv-controls-collapsible--open {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    position: absolute;
    top: 44px;
    right: 8px;
    z-index: 6;
    background: rgba(0,0,0,.85);
    border: 1px solid rgba(255,255,255,.15);
    border-radius: 8px;
    padding: 8px;
    gap: 8px;
    max-width: 220px;
  }
  .wtv-controls-collapsible--open .wtv-sub-select { max-width: none; }
  .wtv-controls-collapsible--open .wtv-peers,
  .wtv-controls-collapsible--open .wtv-speed { justify-content: center; }
  .wtv-audio-panel {
    position: fixed;
    top: auto;
    bottom: 12px;
    left: 12px;
    right: 12px;
    min-width: 0;
  }
}
</style>