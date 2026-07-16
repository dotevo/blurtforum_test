<script setup lang="ts">
/**
 * modules/player/components/WebtorrentPieceMap.vue
 *
 * The "downloaded pieces / to-download" progress bar from the standalone
 * torrent-lib.js PoC (index.html), ported as its own component so it can be
 * dropped under the video without disturbing the rest of the existing
 * player UI. Three stacked layers, exactly like the PoC:
 *
 *  1. piece map itself — per-bucket "how much of this bucket is downloaded"
 *     gradient (teal = have, dark = missing).
 *  2. window overlay — the CURRENT position-aware download window
 *     (PlaybackBuffer's t.select(start,end) range), in amber. This is the
 *     ground-truth throttle: computed every second and on every seek.
 *  3. overrange overlay — in red, any bucket the Service Worker has
 *     actually seen an HTTP Range request for that falls OUTSIDE the
 *     current window above. If this ever lights up it means the SW/browser
 *     is fetching bytes the piece-selector never asked for — a genuine bug
 *     signal, not just cosmetic — so it's kept even outside of debug UIs.
 *
 * Purely a view over webtorrent-pool.ts (torrent-lib.js) — no state of its
 * own beyond what's needed to render, no torrent/file selection logic.
 */
import { ref, onMounted, onUnmounted, watch } from 'vue';
import * as WTPool from '../webtorrent-pool';
import type { PieceMap } from '../webtorrent-pool';

const props = defineProps<{
  infoHash: string;
  fileIndex: number;
  t: (k: string) => string;
}>();

const emit = defineEmits<{ seek: [frac: number] }>();

const wrapEl = ref<HTMLDivElement | null>(null);
const mapGradient = ref('linear-gradient(to right, var(--bfp-bg4, #22222e), var(--bfp-bg4, #22222e))');
const windowGradient = ref('transparent');
const overrangeGradient = ref('transparent');
const debugLine = ref('');
const markerPct = ref<number | null>(null);

let lastPieceMap: PieceMap | null = null;
let lastBufferWindow: { start: number; end: number; curTime?: number } | null = null;
let requestedRanges: Array<{ startPiece: number; endPiece: number; ts: number }> = [];
const REQUEST_FADE_MS = 6000;

let unsubBufferWindow: (() => void) | null = null;
let unsubRangeRequested: (() => void) | null = null;
let pieceMapTimer: ReturnType<typeof setInterval> | null = null;
let overlayTimer: ReturnType<typeof setInterval> | null = null;
let markerTimer: ReturnType<typeof setInterval> | null = null;

function fmtBytes(b: number): string {
  if (!b || b <= 0) return '0 B';
  const k = 1024, units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(1) + ' ' + units[i];
}
function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}:${String(rs).padStart(2, '0')}`;
}

function mixPieceColor(v: number, parity: number): string {
  const c0 = [0x22, 0x22, 0x2e], c1 = [0x00, 0xe5, 0xcc];
  let r = c0[0] + (c1[0] - c0[0]) * v;
  let g = c0[1] + (c1[1] - c0[1]) * v;
  let b = c0[2] + (c1[2] - c0[2]) * v;
  if (parity) g += 9; else b += 9;
  r = Math.max(0, Math.min(255, Math.round(r)));
  g = Math.max(0, Math.min(255, Math.round(g)));
  b = Math.max(0, Math.min(255, Math.round(b)));
  return `rgb(${r},${g},${b})`;
}

function renderPieceMap(map: PieceMap | null): void {
  if (!map || !map.buckets.length) {
    mapGradient.value = 'linear-gradient(to right, var(--bfp-bg4, #22222e), var(--bfp-bg4, #22222e))';
    debugLine.value = '';
    return;
  }
  const n = map.buckets.length;
  const stops: string[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = (i / n * 100).toFixed(3);
    const p1 = ((i + 1) / n * 100).toFixed(3);
    const color = mixPieceColor(map.buckets[i].h, map.buckets[i].parity);
    stops.push(`${color} ${p0}%`, `${color} ${p1}%`);
  }
  mapGradient.value = `linear-gradient(to right, ${stops.join(',')})`;

  const win = lastBufferWindow;
  const winTxt = win
    ? ` • bufor: fragmenty ${win.start}–${win.end} (~${fmtTime((win.curTime || 0) * 1000)} w materiale)`
    : '';
  debugLine.value = map.pieceLength
    ? `rozmiar fragmentu: ${fmtBytes(map.pieceLength)} • fragmentów w pliku: ${map.totalPieces}${winTxt}`
    : '';
}

function pruneRequestedRanges(): void {
  const cutoff = Date.now() - REQUEST_FADE_MS;
  requestedRanges = requestedRanges.filter(r => r.ts >= cutoff);
}

// Solid, reliable layer: the REAL throttle mechanism (t.select(start,end)),
// already recomputed every second and on every seek by torrent-lib.js's
// PlaybackBuffer — guaranteed to render as soon as anything is playing.
function renderWindowOverlay(map: PieceMap | null): void {
  const win = lastBufferWindow;
  if (!map || !map.totalPieces || !win) { windowGradient.value = 'transparent'; return; }

  const { startPiece, endPiece } = map;
  const total = endPiece - startPiece + 1;
  const n = map.buckets.length;
  const stops: string[] = [];
  for (let i = 0; i < n; i++) {
    const from = startPiece + Math.floor((i / n) * total);
    const to = startPiece + Math.max(Math.floor((i / n) * total) + 1, Math.floor(((i + 1) / n) * total)) - 1;
    const inWindow = to >= win.start && from <= win.end;
    const p0 = (i / n * 100).toFixed(3);
    const p1 = ((i + 1) / n * 100).toFixed(3);
    const color = inWindow ? 'rgba(245,197,24,0.32)' : 'rgba(0,0,0,0)';
    stops.push(`${color} ${p0}%`, `${color} ${p1}%`);
  }
  windowGradient.value = `linear-gradient(to right, ${stops.join(',')})`;
}

// Secondary layer: highlights, in red, any bucket the Service Worker has
// literally seen an HTTP Range request for that falls OUTSIDE the current
// select() window — the concrete "downloading more than intended" signal.
function renderOverrangeOverlay(map: PieceMap | null): void {
  pruneRequestedRanges();
  const win = lastBufferWindow;
  if (!map || !map.totalPieces || !requestedRanges.length || !win) { overrangeGradient.value = 'transparent'; return; }

  const { startPiece, endPiece } = map;
  const total = endPiece - startPiece + 1;
  const n = map.buckets.length;
  const now = Date.now();
  const stops: string[] = [];
  for (let i = 0; i < n; i++) {
    const from = startPiece + Math.floor((i / n) * total);
    const to = startPiece + Math.max(Math.floor((i / n) * total) + 1, Math.floor(((i + 1) / n) * total)) - 1;
    let bestAlpha = 0;
    for (const r of requestedRanges) {
      const outOfWindow = (r.endPiece > win.end) || (r.startPiece < win.start);
      if (!outOfWindow) continue;
      if (to < r.startPiece || from > r.endPiece) continue;
      if (to <= win.end && from >= win.start) continue;
      const alpha = Math.max(0, 1 - (now - r.ts) / REQUEST_FADE_MS);
      if (alpha > bestAlpha) bestAlpha = alpha;
    }
    const p0 = (i / n * 100).toFixed(3);
    const p1 = ((i + 1) / n * 100).toFixed(3);
    const color = bestAlpha > 0 ? `rgba(239,68,68,${(0.35 + 0.55 * bestAlpha).toFixed(3)})` : 'rgba(0,0,0,0)';
    stops.push(`${color} ${p0}%`, `${color} ${p1}%`);
  }
  overrangeGradient.value = `linear-gradient(to right, ${stops.join(',')})`;
}

function tick(): void {
  lastPieceMap = WTPool.getFilePieceMap(props.infoHash, props.fileIndex, 150);
  renderPieceMap(lastPieceMap);
  renderWindowOverlay(lastPieceMap);
  renderOverrangeOverlay(lastPieceMap);
}

function updateMarker(): void {
  const video = document.getElementById('bf-wt-player-video') as HTMLVideoElement | null;
  if (!video || !video.duration || !isFinite(video.duration)) { markerPct.value = null; return; }
  markerPct.value = Math.min(100, Math.max(0, (video.currentTime / video.duration) * 100));
}

function onClick(e: MouseEvent): void {
  if (!wrapEl.value) return;
  const rect = wrapEl.value.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  emit('seek', frac);
}

function startSubscriptions(): void {
  stopSubscriptions();
  lastBufferWindow = null;
  requestedRanges = [];

  unsubBufferWindow = WTPool.on('buffer-window', (win: { infoHash: string; fileIndex: number; start: number; end: number; curTime?: number }) => {
    if (win.infoHash !== props.infoHash || win.fileIndex !== props.fileIndex) return;
    lastBufferWindow = win;
    renderWindowOverlay(lastPieceMap);
    renderOverrangeOverlay(lastPieceMap);
  });
  unsubRangeRequested = WTPool.on('range-requested', (r: { infoHash: string; fileIndex: number; startPiece: number; endPiece: number; ts?: number }) => {
    if (r.infoHash !== props.infoHash || r.fileIndex !== props.fileIndex) return;
    requestedRanges.push({ startPiece: r.startPiece, endPiece: r.endPiece, ts: r.ts || Date.now() });
    if (requestedRanges.length > 300) requestedRanges.splice(0, requestedRanges.length - 300);
    renderOverrangeOverlay(lastPieceMap);
  });

  tick();
  pieceMapTimer = setInterval(tick, 1000);
  // Faster cadence just for the overlays so the window snaps on seek and the
  // overrange fade-out reads as "live" rather than jumping once a second.
  overlayTimer = setInterval(() => {
    renderWindowOverlay(lastPieceMap);
    renderOverrangeOverlay(lastPieceMap);
  }, 250);
  markerTimer = setInterval(updateMarker, 250);
}

function stopSubscriptions(): void {
  if (pieceMapTimer) { clearInterval(pieceMapTimer); pieceMapTimer = null; }
  if (overlayTimer) { clearInterval(overlayTimer); overlayTimer = null; }
  if (markerTimer) { clearInterval(markerTimer); markerTimer = null; }
  unsubBufferWindow?.(); unsubBufferWindow = null;
  unsubRangeRequested?.(); unsubRangeRequested = null;
}

onMounted(startSubscriptions);
onUnmounted(stopSubscriptions);
watch(() => [props.infoHash, props.fileIndex], startSubscriptions);
</script>

<template>
  <div class="wtpm-outer">
    <div
      ref="wrapEl"
      class="wtpm-wrap"
      :title="t('pieceMapHint') || 'Mapa pobranych fragmentów — kliknij, aby przewinąć'"
      @click="onClick"
    >
      <div class="wtpm-layer" :style="{ background: mapGradient }"></div>
      <div class="wtpm-layer wtpm-layer--window" :style="{ background: windowGradient }"></div>
      <div class="wtpm-layer wtpm-layer--overrange" :style="{ background: overrangeGradient }"></div>
      <div v-if="markerPct != null" class="wtpm-marker" :style="{ left: markerPct + '%' }"></div>
    </div>
    <div class="wtpm-legend">
      <span class="wtpm-sw" style="background:#00e5cc"></span> {{ t('pieceMapDownloaded') || 'pobrane' }}
      <span class="wtpm-sw" style="background:#22222e;border:1px solid #2a2a38"></span> {{ t('pieceMapMissing') || 'brakujące' }}
      <span class="wtpm-sw" style="background:#f5c518"></span> {{ t('pieceMapWindow') || 'okno bufora' }}
      <span class="wtpm-sw" style="background:#ef4444"></span> {{ t('pieceMapOverrange') || 'poza oknem (SW)' }}
    </div>
    <div v-if="debugLine" class="wtpm-debug">{{ debugLine }}</div>
  </div>
</template>

<style scoped>
.wtpm-outer {
  padding: 6px 12px 8px;
  background: #000;
  border-top: 1px solid rgba(255,255,255,.08);
}
.wtpm-wrap {
  position: relative;
  height: 16px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--bfp-bg4, #22222e);
  border: 1px solid var(--bfp-border, #2a2a38);
  cursor: pointer;
}
.wtpm-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.wtpm-layer--window { transition: background .2s linear; }
.wtpm-layer--overrange { transition: background .25s linear; }
.wtpm-marker {
  position: absolute;
  top: -1px;
  bottom: -1px;
  width: 2px;
  background: #fff;
  pointer-events: none;
}
.wtpm-legend {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: .68em;
  color: var(--text-soft, #8888aa);
  margin-top: 5px;
  flex-wrap: wrap;
}
.wtpm-sw {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 2px;
}
.wtpm-debug {
  font-size: .66em;
  color: var(--text-soft, #8888aa);
  font-family: monospace;
  opacity: .75;
  margin-top: 3px;
}
</style>
