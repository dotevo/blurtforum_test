<script setup lang="ts">
/**
 * modules/player/components/WebtorrentAudioSubtitleMenu.vue
 *
 * Subtitle + alternate-audio-track selection, split out of WebtorrentVideo.vue
 * on purpose: everything in here depends only on `files` (the de-duped,
 * rarely-changing file list — see WebtorrentVideo.vue's `stableFiles`) and on
 * player.ts's audio-track state, NEVER on the live torrent stats object that
 * WebtorrentVideo.vue polls every second for peers/speed/progress.
 *
 * Real bug this structurally closes: a single shared component re-renders
 * its ENTIRE template on ANY reactive read inside it changing — so even
 * with a stable `files` array, keeping the subtitle/audio <select>s in the
 * same component as the peers/speed readout meant every second's poll tick
 * still re-ran the whole render function, regenerating vnodes for the
 * <select>s too. Vue's patching *should* no-op unchanged DOM in that case,
 * but a separate child component sidesteps the question entirely: this
 * component has no reactive dependency on the poll at all, so it simply
 * cannot be dragged into a re-render by it, full stop — independent of any
 * vnode-patching subtlety. That's what was behind the native <select>
 * picker still flickering/misbehaving while open even after de-duplicating
 * the file list.
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import {
  wtAudioTrackIndex, wtAudioMode, wtAudioOffsetMs, wtAudioOrigVolume, wtAudioTrackVolume,
  selectWebtorrentAudioTrack, setWebtorrentAudioMode, setWebtorrentAudioOffsetMs,
  setWebtorrentAudioOrigVolume, setWebtorrentAudioTrackVolume,
} from '../player';
import * as WTPool from '../webtorrent-pool';
import type { TorrentSnapshot } from '../webtorrent-pool';

const props = defineProps<{
  t: (k: string) => string;
  infoHash: string | null;
  files: TorrentSnapshot['files'];
  activeFileIndex: number | null;
  visible: boolean; // mirrors WebtorrentVideo.vue's auto-hide controlsVisible
}>();

// ── Subtitles (delegates entirely to torrent-lib.js's format conversion) ──
// IMPORTANT: we never remove <track> elements once added — see the original
// comment history in WebtorrentVideo.vue; removing/recreating a single
// <track> broke the browser's native CC menu in Chrome/Firefox. Same
// approach here, unchanged.
const subFiles = computed(() => props.files.filter(f => f.isSub));
const activeSubIdx = ref<string>('');
const subLoading = ref(false);
const subTrackEls = new Map<number, HTMLTrackElement>();
const subUrls = new Map<number, string>();

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

function selectSubtitle(): void {
  setActiveSubtitleTrack(activeSubIdx.value ? Number(activeSubIdx.value) : null);
}

/**
 * Real bug this fixes: <track> elements used to be fetched and mounted ONE
 * AT A TIME, only when picked from OUR OWN <select>. But the browser's
 * native CC/subtitles button (part of the <video controls> chrome) only
 * ever lists whichever <track> elements are ALREADY mounted on the video —
 * so on a browser/session where the user hadn't yet opened our dropdown,
 * the native CC button showed as unavailable or offered only "Off" plus
 * whichever single language had been picked before. Subtitle files are tiny
 * (typically tens of KB — nothing like the video itself), so fetching every
 * one of them up front is cheap and makes BOTH menus — ours and the native
 * one — show the complete list immediately, no "pick it once through our
 * UI first" workaround needed.
 */
async function prefetchAllSubtitles(): Promise<void> {
  const video = document.getElementById('bf-wt-player-video') as HTMLVideoElement | null;
  const hash = props.infoHash;
  if (!video || !hash) return;
  const toFetch = subFiles.value.filter(f => !subTrackEls.has(f.index));
  if (!toFetch.length) return;

  subLoading.value = true;
  await Promise.all(toFetch.map(async (f) => {
    try {
      const track = await WTPool.getSubtitleTrack(hash, f.index);
      // The torrent/track could have changed while this particular fetch
      // was in flight — don't attach a track for a file that's no longer
      // relevant, and don't leak its blob URL.
      if (props.infoHash !== hash || !subFiles.value.some(sf => sf.index === f.index)) {
        URL.revokeObjectURL(track.url);
        return;
      }
      subUrls.set(f.index, track.url);
      const el = document.createElement('track');
      el.kind = 'subtitles';
      el.label = track.name;
      el.srclang = track.srclang;
      el.src = track.url;
      video.appendChild(el);
      el.track.mode = 'disabled'; // mounted (so it's listed) but off until explicitly picked
      subTrackEls.set(f.index, el);
    } catch (err) {
      console.warn('[WebtorrentAudioSubtitleMenu] failed to prefetch subtitle', f.name, err);
    }
  }));
  subLoading.value = false;
}

// Keep OUR <select> in sync when the user picks a subtitle from the
// browser's OWN native CC menu instead of ours — video.textTracks fires
// 'change' whenever ANY track's mode changes, regardless of which UI did it.
function onNativeTextTracksChange(): void {
  let found: number | null = null;
  subTrackEls.forEach((el, idx) => { if (el.track.mode === 'showing') found = idx; });
  activeSubIdx.value = found == null ? '' : String(found);
}

let ttVideoEl: HTMLVideoElement | null = null;
onMounted(() => {
  ttVideoEl = document.getElementById('bf-wt-player-video') as HTMLVideoElement | null;
  ttVideoEl?.textTracks.addEventListener('change', onNativeTextTracksChange);
});
onUnmounted(() => {
  ttVideoEl?.textTracks.removeEventListener('change', onNativeTextTracksChange);
  clearSubtitleTracks();
});

// A new torrent means the previous subtitle files no longer apply; either
// way, (re)prefetch whatever subtitle files exist right now. Combined into
// one watcher (rather than two separate ones) so clearing always runs
// before prefetching for the same change, instead of relying on Vue's
// watcher-ordering to get that right.
watch([() => props.infoHash, subFiles], ([hash], [prevHash]) => {
  if (hash !== prevHash) clearSubtitleTracks();
  void prefetchAllSubtitles();
}, { immediate: true });

// ── Alternate audio track (lektor/dub) ─────────────────────────────────────
const audioFiles = computed(() => props.files.filter(f => f.isAudio && f.index !== props.activeFileIndex));
const activeAudioIdx = computed<string>(() => wtAudioTrackIndex.value == null ? '' : String(wtAudioTrackIndex.value));

function selectAudioTrack(e: Event): void {
  const val = (e.target as HTMLSelectElement).value;
  selectWebtorrentAudioTrack(val === '' ? null : Number(val));
}

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

// ── Menu open/close ─────────────────────────────────────────────────────────
// Everything (subtitle picker, audio picker, audio settings) lives behind
// ONE "⋮" button now, per request — audio settings nests inline under its
// own gear row instead of floating as a separate panel, so it's all one
// scrollable list instead of two overlapping floating boxes.
const showMenu = ref(false);
const showAudioAdvanced = ref(false);
watch(activeAudioIdx, (idx) => { if (!idx) showAudioAdvanced.value = false; });
watch(() => props.visible, (v) => { if (!v) { showMenu.value = false; showAudioAdvanced.value = false; } });

// Real bug this avoids: the toggle button sits inside .wtv-controls (an
// absolutely-positioned bar), and this component's own wrapper needed
// `display: contents` so the button lays out inline with its siblings
// there. But `display: contents` means this wrapper generates no box of its
// own — so a `position: absolute` dropdown here would resolve its
// containing block to .wtv-controls (the nearest ancestor box that IS
// positioned), not to the full video area behind it, since CSS containing-
// block resolution walks up the real box tree and skips right past a
// `display: contents` node. .wtv-controls is only as tall as its row of
// buttons, so the dropdown would be constrained to that sliver instead of
// "the height of the video element" as requested — not a hypothetical, this
// is exactly what CSS containing-block rules do here.
//
// Sidestepping the whole question: measure the actual <video> element's
// on-screen box directly and position the dropdown with `position: fixed`
// (viewport-relative, no containing-block ambiguity at all) to match it.
// That's also literally the requested behavior — bounded to the video
// element's height, with internal scroll for whatever doesn't fit.
const menuStyle = ref<Record<string, string>>({});
function updateMenuStyle(): void {
  const video = document.getElementById('bf-wt-player-video') as HTMLVideoElement | null;
  if (!video) return;
  const r = video.getBoundingClientRect();
  menuStyle.value = {
    position: 'fixed',
    top: `${Math.round(r.top + 44)}px`,
    bottom: `${Math.round(window.innerHeight - r.bottom + 8)}px`,
    right: `${Math.round(window.innerWidth - r.right + 8)}px`,
  };
}
function onResize(): void { if (showMenu.value) updateMenuStyle(); }
watch(showMenu, (open) => {
  if (open) {
    updateMenuStyle();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
  } else {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
  }
});
onUnmounted(() => {
  window.removeEventListener('resize', onResize);
  window.removeEventListener('orientationchange', onResize);
});
</script>

<template>
  <div class="wasm-wrap">
    <button class="wtv-btn" :class="{ 'wtv-btn--active': showMenu }"
            @click="showMenu = !showMenu" :title="t('audioSubtitleSettings') || 'Audio & subtitles'">
      <i class="fa-solid fa-closed-captioning"></i>
    </button>

    <div v-if="showMenu" class="wasm-menu" :style="menuStyle" @click.stop @mousemove.stop>
      <div class="wasm-row">
        <label>{{ t('subtitles') || 'Subtitles' }}</label>
        <select v-if="subFiles.length" v-model="activeSubIdx" @change="selectSubtitle" class="wtv-sub-select"
                :disabled="subLoading">
          <option value="">{{ t('subtitlesOff') || 'No subtitles' }}</option>
          <option v-for="f in subFiles" :key="f.index" :value="f.index">{{ f.name }}</option>
        </select>
        <div v-else class="wasm-empty">{{ t('subtitlesNone') || 'No subtitle files in this torrent' }}</div>
      </div>

      <div class="wasm-row">
        <label>{{ t('audioTrack') || 'Audio track' }}</label>
        <select v-if="audioFiles.length" :value="activeAudioIdx" @change="selectAudioTrack" class="wtv-sub-select">
          <option value="">{{ t('audioTrackOriginal') || 'Original audio' }}</option>
          <option v-for="f in audioFiles" :key="f.index" :value="f.index">{{ f.name }}</option>
        </select>
        <div v-else class="wasm-empty">{{ t('audioTrackNone') || 'No alternate audio files in this torrent' }}</div>
      </div>

      <button v-if="activeAudioIdx" class="wtv-btn wasm-gear-btn" :class="{ 'wtv-btn--active': showAudioAdvanced }"
              @click="showAudioAdvanced = !showAudioAdvanced">
        <i class="fa-solid fa-sliders"></i> {{ t('audioTrackSettings') || 'Audio track settings (sync, volume)' }}
      </button>

      <div v-if="showAudioAdvanced && activeAudioIdx" class="wasm-advanced">
        <div class="wasm-row">
          <label>{{ t('audioTrackMode') || 'Mode' }}</label>
          <select :value="wtAudioMode" @change="onAudioModeChange">
            <option value="dub">{{ t('audioTrackModeDub') || 'Replace original (dubbing)' }}</option>
            <option value="lektor">{{ t('audioTrackModeLektor') || 'Alongside original (lektor)' }}</option>
          </select>
        </div>
        <div class="wasm-row">
          <label>{{ t('audioTrackOffset') || 'Sync offset' }} ({{ offsetSecDisplay }}s)</label>
          <input type="range" min="-10000" max="10000" step="100" :value="wtAudioOffsetMs" @input="onOffsetInput" />
        </div>
        <div class="wasm-row">
          <label>{{ t('audioTrackOrigVolume') || 'Original volume' }}</label>
          <input type="range" min="0" max="1" step="0.05" :value="wtAudioOrigVolume" @input="onOrigVolumeInput" />
        </div>
        <div class="wasm-row">
          <label>{{ t('audioTrackVolume') || 'Track volume' }}</label>
          <input type="range" min="0" max="1" step="0.05" :value="wtAudioTrackVolume" @input="onTrackVolumeInput" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wasm-wrap {
  display: contents; /* the button lays out inline in the parent's flex row; the dropdown is position:fixed, measured off the <video> element directly (see updateMenuStyle in <script>) */
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

/* position (top/right/bottom) comes from the inline :style binding —
   measured directly off the <video> element's on-screen box, see
   updateMenuStyle() in the script. That's what actually constrains this to
   "the height of the video element, with scroll for the rest" — a
   containing-block percentage/anchor here couldn't do that reliably
   because of the display:contents wrapper, see the comment in <script>. */
.wasm-menu {
  z-index: 50;
  width: 260px;
  max-width: calc(100vw - 16px);
  overflow-y: auto;
  background: rgba(0,0,0,.9);
  border: 1px solid rgba(255,255,255,.15);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wasm-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wasm-row label {
  color: #fff;
  font-size: 10px;
  opacity: .85;
}
.wasm-empty {
  color: rgba(255,255,255,.5);
  font-size: 10px;
  font-style: italic;
}
.wtv-sub-select, .wasm-row select {
  background: rgba(255,255,255,.08);
  color: #fff;
  border: 1px solid rgba(255,255,255,.15);
  border-radius: 5px;
  padding: 6px 8px;
  font-size: 11px;
  width: 100%;
}
.wasm-row input[type="range"] { width: 100%; }
.wasm-gear-btn {
  width: 100%;
  gap: 6px;
  font-size: 11px;
  padding: 6px 8px;
}
.wasm-advanced {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 6px;
  border-top: 1px solid rgba(255,255,255,.12);
}
</style>