<script setup lang="ts">
/**
 * modules/player/components/WebtorrentAudioSubtitlePanel.vue
 *
 * Panel-tab version of the subtitle/alternate-audio-track picker, registered
 * via player.ts's registerExpandedTab() (see WebtorrentVideo.vue's onMounted)
 * so it renders as a normal .bfp-panel-body — the same slide-in right-hand
 * panel "Queue"/"Playlists"/"Torrent info" already use — instead of a
 * Teleported floating dropdown.
 *
 * Real bug this fixes: WebtorrentAudioSubtitleMenu.vue (the ⋮ dropdown,
 * still used for the docked/expanded non-cinema overlay, see
 * WebtorrentExtras.vue) is Teleported straight to <body> with its own
 * `position: fixed` box. modules/cinema/dpad-nav.ts's D-pad/keyboard
 * navigation is an explicit zone state machine (see its own file comment)
 * that only recognizes THREE things as "a panel is open": an element with
 * class `.cinema-side-panel`, or `.bfp-panel--cinema .bfp-panel-body` while
 * `player.state.expandedTab !== 'video'`. A Teleported div floating loose in
 * <body> matches neither, so opening it while a TV remote/keyboard is the
 * only input device leaves the D-pad still in the PLAYER zone underneath —
 * arrows do the play/pause/seek things they'd normally do, Enter can't reach
 * anything inside the dropdown at all, and there's no Escape-to-close. This
 * component sidesteps that category of bug entirely by being a genuine panel
 * tab: opening it already means `expandedTab` is this tab's own id, which is
 * exactly the condition getOpenPanel() in dpad-nav.ts checks for, so Up/Down
 * roving focus + Left/Right/Escape-to-close all work for free, no
 * special-casing needed here or in dpad-nav.ts.
 *
 * Deliberately NOT reused for the docked/expanded (non-cinema) overlay: the
 * D-pad zone system above is cinema-only (see App.vue's
 * installCinemaDpadNav(() => cinemaMode.value)) — outside cinema mode mouse/
 * touch works fine with a small anchored dropdown, so
 * WebtorrentAudioSubtitleMenu.vue stays exactly as-is there. Two components
 * sharing the underlying player.ts state (see below) rather than one
 * component trying to render two structurally different UIs is the same
 * split already applied elsewhere in this module (e.g.
 * WebtorrentInfoModal.vue -> WebtorrentInfoTab.vue's own comment).
 *
 * State/actions all come from player.ts's module-level audio/subtitle
 * exports — same singletons WebtorrentAudioSubtitleMenu.vue reads — so
 * switching between the cinema tab and the docked dropdown (toggling cinema
 * mode mid-playback) never loses the current selection or double-mounts
 * anything.
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import {
  currentSource, wtActiveFileIndex,
  wtSubtitleTrackIndex, wtSubtitleLoading, selectWebtorrentSubtitleTrack, prefetchWtSubtitleTracks,
  wtAudioTrackIndex, wtAudioMode, wtAudioOffsetMs, wtAudioOrigVolume, wtAudioTrackVolume,
  selectWebtorrentAudioTrack, setWebtorrentAudioMode, setWebtorrentAudioOffsetMs,
  setWebtorrentAudioOrigVolume, setWebtorrentAudioTrackVolume,
} from '../player';
import * as WTPool from '../webtorrent-pool';
import type { TorrentSnapshot } from '../webtorrent-pool';

defineProps<{ t: (k: string) => string }>();

const infoHash = computed(() => {
  const id = currentSource.value?.type === 'webtorrent' ? currentSource.value.id : null;
  return id ? WTPool.parseInfoHash(id) : null;
});
const activeFileIndex = computed<number | null>(() => wtActiveFileIndex.value);

// Same dedup as WebtorrentVideo.vue's `stableFiles` and for the same reason:
// this feeds the exact same native <select>s, so a poll tick rebuilding
// `files` from scratch every second (even when nothing actually changed)
// re-diffs their <option> children on every tick — which is what causes
// Android/Chrome's native picker to misbehave while open. See
// WebtorrentVideo.vue's own comment on `stableFiles` for the full story.
const files = ref<TorrentSnapshot['files']>([]);
let filesSig = '';
let pollTimer: ReturnType<typeof setInterval> | null = null;
function refresh(): void {
  const snap = infoHash.value ? WTPool.getActiveTorrent(infoHash.value) : null;
  const next = snap?.files || [];
  const sig = next.map(f => `${f.index}:${f.name}:${f.isSub ? 1 : 0}:${f.isAudio ? 1 : 0}`).join('|');
  if (sig !== filesSig) { filesSig = sig; files.value = next; }
}
onMounted(() => { refresh(); pollTimer = setInterval(refresh, 1000); });
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer); });

// ── Subtitles ────────────────────────────────────────────────────────────
const subFiles = computed(() => files.value.filter(f => f.isSub));
const activeSubIdx = computed<string>(() => wtSubtitleTrackIndex.value == null ? '' : String(wtSubtitleTrackIndex.value));
const subLoading = wtSubtitleLoading;

function selectSubtitle(e: Event): void {
  const val = (e.target as HTMLSelectElement).value;
  selectWebtorrentSubtitleTrack(val === '' ? null : Number(val));
}

watch([infoHash, files], ([hash, f]) => { if (hash) void prefetchWtSubtitleTracks(hash, f); }, { immediate: true });

// ── Alternate audio track (lektor/dub) ─────────────────────────────────────
const audioFiles = computed(() => files.value.filter(f => f.isAudio && f.index !== activeFileIndex.value));
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
</script>

<template>
  <div class="wasp-wrap">
    <div class="wasp-section">
      <div class="wasp-label">{{ t('subtitles') || 'Subtitles' }}</div>
      <select v-if="subFiles.length" :value="activeSubIdx" @change="selectSubtitle" class="wasp-select"
              :disabled="subLoading">
        <option value="">{{ t('subtitlesOff') || 'No subtitles' }}</option>
        <option v-for="f in subFiles" :key="f.index" :value="f.index">{{ f.name }}</option>
      </select>
      <div v-else class="wasp-empty">{{ t('subtitlesNone') || 'No subtitle files in this torrent' }}</div>
    </div>

    <div class="wasp-section">
      <div class="wasp-label">{{ t('audioTrack') || 'Audio track' }}</div>
      <select v-if="audioFiles.length" :value="activeAudioIdx" @change="selectAudioTrack" class="wasp-select">
        <option value="">{{ t('audioTrackOriginal') || 'Original audio' }}</option>
        <option v-for="f in audioFiles" :key="f.index" :value="f.index">{{ f.name }}</option>
      </select>
      <div v-else class="wasp-empty">{{ t('audioTrackNone') || 'No alternate audio files in this torrent' }}</div>
    </div>

    <div v-if="activeAudioIdx" class="wasp-section wasp-advanced">
      <div class="wasp-label wasp-advanced-title">
        <i class="fa-solid fa-sliders"></i> {{ t('audioTrackSettings') || 'Audio track settings (sync, volume)' }}
      </div>

      <div class="wasp-row">
        <label>{{ t('audioTrackMode') || 'Mode' }}</label>
        <select :value="wtAudioMode" @change="onAudioModeChange" class="wasp-select">
          <option value="dub">{{ t('audioTrackModeDub') || 'Replace original (dubbing)' }}</option>
          <option value="lektor">{{ t('audioTrackModeLektor') || 'Alongside original (lektor)' }}</option>
        </select>
      </div>
      <div class="wasp-row">
        <label>{{ t('audioTrackOffset') || 'Sync offset' }} ({{ offsetSecDisplay }}s)</label>
        <input type="range" min="-10000" max="10000" step="100" :value="wtAudioOffsetMs" @input="onOffsetInput" />
      </div>
      <div class="wasp-row">
        <label>{{ t('audioTrackOrigVolume') || 'Original volume' }}</label>
        <input type="range" min="0" max="1" step="0.05" :value="wtAudioOrigVolume" @input="onOrigVolumeInput" />
      </div>
      <div class="wasp-row">
        <label>{{ t('audioTrackVolume') || 'Track volume' }}</label>
        <input type="range" min="0" max="1" step="0.05" :value="wtAudioTrackVolume" @input="onTrackVolumeInput" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.wasp-wrap { display: flex; flex-direction: column; gap: 18px; }
.wasp-section { display: flex; flex-direction: column; gap: 6px; }
.wasp-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-soft);
  text-transform: uppercase;
  letter-spacing: .3px;
}
.wasp-empty { font-size: 12px; color: var(--text-soft); font-style: italic; }
.wasp-select {
  background: var(--surface-3);
  color: var(--text-strong, inherit);
  border: 1px solid var(--surface-border);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
  width: 100%;
}
.wasp-advanced {
  padding-top: 12px;
  border-top: 1px solid var(--surface-border);
  gap: 14px;
}
.wasp-advanced-title { display: flex; align-items: center; gap: 6px; text-transform: none; font-size: 12px; }
.wasp-row { display: flex; flex-direction: column; gap: 5px; }
.wasp-row label { font-size: 11px; color: var(--text-soft); }
.wasp-row input[type="range"] { width: 100%; }
</style>
