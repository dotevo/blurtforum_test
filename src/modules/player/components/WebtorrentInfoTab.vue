<script setup lang="ts">
/**
 * modules/player/components/WebtorrentInfoTab.vue
 *
 * Read-only snapshot of the currently-playing torrent: progress, lifetime
 * up/down totals, ETA, live peers with their per-peer speeds and swarm
 * completion %, and the file list.
 *
 * Was WebtorrentInfoModal.vue — a modal overlay fed by torrent state that
 * lived inside WebtorrentVideo.vue and got passed down as a prop. As a panel
 * tab it has no parent to feed it that state, so it polls WTPool directly
 * (currentSource/WTPool are module-level singletons importable from
 * anywhere, exactly like WebtorrentVideo.vue's own polling does) rather than
 * needing one threaded through props. Mounted only while this tab is active
 * (MediaPlayer.vue's tab bodies are v-if'd), so onMounted/onUnmounted alone
 * are the right lifecycle for starting/stopping the poll — no `show` prop
 * needed the way the old modal needed one.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { currentSource, getPeerActions, playWebtorrentFile } from '../player';
import * as WTPool from '../webtorrent-pool';
import type { TorrentSnapshot } from '../webtorrent-pool';

defineProps<{ t: (k: string) => string }>();

// Plugin contributions to each peer row (e.g. a Blurt-identity badge) — see
// player.ts's registerPeerAction()/PeerActionContribution. This component
// has no idea what any of these render, or whether they render anything at
// all for a given peer; it just mounts whatever's registered, once per row.
const peerActions = getPeerActions();

const infoHash = computed(() => {
  const id = currentSource.value?.type === 'webtorrent' ? currentSource.value.id : null;
  return id ? WTPool.parseInfoHash(id) : null;
});

const torrent = ref<TorrentSnapshot | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;

function refresh(): void {
  torrent.value = infoHash.value ? WTPool.getActiveTorrent(infoHash.value) : null;
}

onMounted(() => {
  refresh();
  pollTimer = setInterval(refresh, 1000);
});
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer); });

function fmtBytes(b: number): string {
  if (!b || b <= 0) return '0 B';
  const k = 1024, units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(1) + ' ' + units[i];
}
const fmtSpeed = (b: number): string => fmtBytes(b) + '/s';

function fmtEta(sec: number | undefined): string {
  if (sec == null || !isFinite(sec) || sec <= 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

const progressPct = computed(() => torrent.value ? Math.round((torrent.value.progress || 0) * 100) : 0);
const wires = computed(() => torrent.value?.wires || []);
</script>

<template>
<div v-if="torrent">
  <div style="font-size:12px; font-weight:600; margin-bottom:4px; word-break:break-word;">{{ torrent.name }}</div>
  <div style="font-size:11px; color:var(--text-soft); margin-bottom:14px;">
    {{ fmtBytes(torrent.length) }} · {{ progressPct }}% · {{ torrent.numPeers }} {{ t('peers') || 'peers' }}
    <template v-if="!torrent.done"> · ETA {{ fmtEta(torrent.timeRemaining ? torrent.timeRemaining / 1000 : undefined) }}</template>
    <template v-else> · {{ t('done') || 'complete' }}</template>
  </div>

  <div style="height:6px; background:var(--surface-3); border-radius:4px; overflow:hidden; margin-bottom:16px;">
    <div :style="{ width: progressPct + '%', height: '100%', background: 'var(--accent)' }"></div>
  </div>

  <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:10px;">
    <div>
      <div style="font-size:10px; color:var(--text-soft); text-transform:uppercase;">{{ t('downloaded') || 'Downloaded' }}</div>
      <div style="font-size:14px; font-weight:700;">{{ fmtBytes(torrent.downloaded) }}</div>
      <div style="font-size:10px; color:var(--text-soft);">{{ fmtSpeed(torrent.downloadSpeed) }}</div>
    </div>
    <div>
      <div style="font-size:10px; color:var(--text-soft); text-transform:uppercase;">{{ t('uploaded') || 'Uploaded' }}</div>
      <div style="font-size:14px; font-weight:700;">{{ fmtBytes(torrent.uploaded) }}</div>
      <div style="font-size:10px; color:var(--text-soft);">{{ fmtSpeed(torrent.uploadSpeed) }}</div>
    </div>
  </div>

  <!-- Lifetime totals for this torrent specifically (survive reloads — see
       torrent-lib.js's PersistentState — as opposed to the session counters
       above, which reset whenever the Torrent object is recreated). -->
  <div style="display:flex; justify-content:space-between; font-size:10px; color:var(--text-soft); margin-bottom:16px; padding-top:6px; border-top:1px solid var(--surface-border);">
    <span>{{ t('lifetimeDownloaded') || 'Lifetime downloaded' }}: <b style="color:var(--text-strong,inherit);">{{ fmtBytes(torrent.allTime?.downloaded || 0) }}</b></span>
    <span>{{ t('lifetimeUploaded') || 'Lifetime uploaded' }}: <b style="color:var(--text-strong,inherit);">{{ fmtBytes(torrent.allTime?.uploaded || 0) }}</b></span>
  </div>

  <div style="font-size:11px; font-weight:600; margin-bottom:6px;">{{ t('files') || 'Files' }} ({{ torrent.files?.length || 0 }})</div>
  <div style="max-height:160px; overflow-y:auto; margin-bottom:16px;">
    <div v-for="f in torrent.files" :key="f.index" style="display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:11px; padding:4px 0; border-bottom:1px solid var(--surface-border);">
      <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;" :title="f.name">{{ f.name }}</span>
      <span style="color:var(--text-soft); flex-shrink:0;">
        {{ fmtBytes(f.length) }}
        <template v-if="f.progress != null"> · {{ Math.round(f.progress * 100) }}%</template>
        <template v-if="(f.isVideo || f.isAudio) && !f.nativePlayable"> · <span style="color:#ef4444;">{{ t('noNativePlayback') || 'no native playback' }}</span></template>
      </span>
      <button
        v-if="f.isVideo || f.isAudio"
        class="wtim-play-btn"
        :title="t('playThisFile') || 'Play this file'"
        @click="playWebtorrentFile(f.index)"
      ><i class="fa-solid fa-play"></i></button>
    </div>
  </div>

  <div style="font-size:11px; font-weight:600; margin-bottom:6px;">{{ t('peers') || 'Peers' }} ({{ wires.length }})</div>
  <div style="max-height:140px; overflow-y:auto;">
    <div v-if="!wires.length" style="font-size:11px; color:var(--text-soft);">{{ t('noPeersYet') || 'No peers connected yet…' }}</div>
    <div v-for="w in wires" :key="w.addr + (w.peerId || '')" style="display:flex; justify-content:space-between; align-items:center; gap:8px; font-size:11px; padding:4px 0; border-bottom:1px solid var(--surface-border); font-family:monospace;">
      <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">{{ w.addr }}</span>
      <component
        v-for="a in peerActions"
        :key="a.id"
        :is="a.component"
        :peer-id="w.peerId"
        :info-hash="torrent?.infoHash ?? null"
        :addr="w.addr"
        :t="t"
        v-bind="a.props"
      />
      <span style="color:var(--text-soft); flex-shrink:0;" :title="t('peerHasPct') || 'Has this % of the swarm'">{{ w.bitfieldPct }}%</span>
      <span style="color:#22c55e;">↓{{ fmtSpeed(w.downloadSpeed) }}</span>
      <span style="color:#f59e0b;">↑{{ fmtSpeed(w.uploadSpeed) }}</span>
      <span v-if="w.peerChoking" style="color:#ef4444;">choked</span>
    </div>
  </div>
</div>
<div v-else style="font-size:12px; color:var(--text-soft);">
  {{ t('loadingTorrentMetadata') || 'Waiting for torrent metadata…' }}
</div>
</template>

<style scoped>
.wtim-play-btn {
  flex-shrink: 0;
  background: rgba(0,229,204,.15);
  color: var(--accent);
  border: 1px solid rgba(0,229,204,.3);
  border-radius: 5px;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 10px;
}
.wtim-play-btn:hover { background: rgba(0,229,204,.3); }
</style>
