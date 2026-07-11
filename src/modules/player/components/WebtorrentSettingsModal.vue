<script setup lang="ts">
/**
 * modules/player/components/WebtorrentSettingsModal.vue
 *
 * Global (not per-track) WebTorrent management: lifetime up/down stats,
 * disk usage against the configured quota, the seeding on/off switch, the
 * list of persisted torrents, and a way to wipe it all. Everything here
 * reads/writes through webtorrent-pool.ts's public API — this component
 * has no storage logic of its own.
 */
import { ref, computed, watch, onUnmounted } from 'vue';
import * as WTPool from '../webtorrent-pool';
import { playTrack } from '../player';
import type { MediaTrack } from '../types';

const props = defineProps<{
  show: boolean;
  t: (k: string) => string;
}>();
const emit = defineEmits<{ close: [] }>();

function fmtBytes(b: number): string {
  if (!b || b <= 0) return '0 B';
  const k = 1024, units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(1) + ' ' + units[i];
}

const stats = ref(WTPool.getStats());
const manifest = ref(WTPool.getManifest());
const seeding = ref(WTPool.isSeedingEnabled());
const quotaBytes = ref(WTPool.getMaxStorageBytes());
const usageBytes = ref(0);
const browserEstimate = ref<{ usage: number; quota: number } | null>(null);
const clearing = ref(false);

async function refresh(): Promise<void> {
  // Real bug this closes: getStats()/getManifest() both read from the
  // shared TorrentLibrary instance (`lib` inside webtorrent-pool.ts), which
  // is only ever constructed lazily, the first time something actually
  // tries to play a webtorrent track. Opening this modal before that ever
  // happened meant `lib` was still null, so both calls silently returned
  // empty results FOREVER (nothing in here ever triggers init on its own) —
  // "nothing shown in WebTorrent settings, so previously-downloaded movies
  // can't be replayed" even though they're sitting on disk the whole time.
  // initWebtorrent() itself resumes any persisted torrents from a previous
  // session as part of its own init() (see torrent-lib.js's
  // _restoreFromStorage), so awaiting it here is exactly what's needed to
  // make that list show up, with no other changes required.
  await WTPool.initWebtorrent();
  stats.value = WTPool.getStats();
  manifest.value = WTPool.getManifest();
  // Actual on-disk usage per torrent-lib.js's own QuotaManager bookkeeping
  // (async — it reads the usage IndexedDB store), rather than summing
  // whole-torrent lengths, which would overstate partially-downloaded ones.
  usageBytes.value = await WTPool.getManifestUsageBytes();
  browserEstimate.value = await WTPool.getStorageEstimate();
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
watch(() => props.show, (visible) => {
  if (visible) {
    refresh();
    pollTimer = setInterval(refresh, 2000);
  } else if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}, { immediate: true });
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer); });

function toggleSeeding(): void {
  seeding.value = !seeding.value;
  WTPool.setSeedingEnabled(seeding.value);
}

const quotaGB = computed({
  get: () => +(quotaBytes.value / (1024 ** 3)).toFixed(1),
  set: (gb: number) => {
    quotaBytes.value = Math.max(1, gb) * 1024 ** 3;
    WTPool.setMaxStorageBytes(quotaBytes.value);
  },
});

const usagePct = computed(() => quotaBytes.value > 0 ? Math.min(100, Math.round((usageBytes.value / quotaBytes.value) * 100)) : 0);

async function handleClearAll(): Promise<void> {
  if (!confirm(props.t('confirmClearWebtorrentData') || 'Delete all downloaded torrent data from this device? This cannot be undone.')) return;
  clearing.value = true;
  try {
    await WTPool.clearAllSeedData();
    await refresh();
  } finally {
    clearing.value = false;
  }
}

/**
 * Plays a torrent straight from what's already stored on this device — no
 * forum post needed. This is the point of persisting the whole magnetURI +
 * cached .torrent metadata: the user should be able to resume something
 * they've already fully downloaded (or start it going for the first time)
 * purely from this "what's taking up space" list, exactly the way a future
 * offline-capable mobile app would need to, without depending on ever
 * revisiting the original post/link.
 */
function playStored(e: WTPool.SeedManifestEntry): void {
  const track: MediaTrack = {
    author: '',
    permlink: '',
    subId: `wt-manifest:${e.infoHash}`,
    title: e.title,
    pending: false,
    sources: [{ type: 'webtorrent', id: e.magnetURI }],
    activeSourceIndex: 0,
  };
  playTrack(track, true);
  emit('close');
}

function toggleEntryFullDownload(e: WTPool.SeedManifestEntry): void {
  if (e.fullDownload) WTPool.cancelFullDownload(e.infoHash);
  else WTPool.downloadEntireTorrent(e.infoHash);
  refresh();
}
</script>

<template>
<!--
  Teleported straight to <body>: without this, the overlay renders wherever
  this component happens to sit in the page's DOM tree. If any ancestor
  (including MediaPlayer.vue itself, which uses position:fixed with its own
  z-index for the mini bar / expanded panel) establishes a CSS stacking
  context, this overlay's z-index is only ever compared against its OWN
  siblings inside that context — it can end up rendered *behind* unrelated
  page elements that have a higher z-index in a different stacking context,
  no matter how high a z-index we give it here. Teleporting to <body> plus a
  deliberately very high z-index sidesteps that entirely.
-->
<Teleport to="body">
<div v-if="show" class="modal-overlay" style="z-index: 99999;" @click.self="emit('close')">
  <div class="modal-box" style="width: 480px; max-width: 92vw;">
    <div class="modal-header">
      <span style="display:flex; align-items:center; gap:8px;">
        <i class="fa-solid fa-magnet"></i> {{ t('webtorrentSettings') || 'WebTorrent storage & stats' }}
      </span>
      <button class="modal-close" @click="emit('close')">×</button>
    </div>
    <div class="modal-body">

      <!-- Lifetime totals -->
      <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-bottom:18px;">
        <div>
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase;">{{ t('downloaded') || 'Downloaded' }}</div>
          <div style="font-size:15px; font-weight:700;">{{ fmtBytes(stats.totalDownloaded) }}</div>
        </div>
        <div>
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase;">{{ t('uploaded') || 'Uploaded' }}</div>
          <div style="font-size:15px; font-weight:700;">{{ fmtBytes(stats.totalUploaded) }}</div>
        </div>
        <div>
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase;">{{ t('ratio') || 'Ratio' }}</div>
          <div style="font-size:15px; font-weight:700;">
            {{ stats.totalDownloaded > 0 ? (stats.totalUploaded / stats.totalDownloaded).toFixed(2) : '—' }}
          </div>
        </div>
      </div>

      <!-- Disk usage -->
      <div style="margin-bottom:18px;">
        <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:5px;">
          <span>{{ t('diskUsage') || 'Disk usage' }}</span>
          <span style="color:var(--text-muted);">{{ fmtBytes(usageBytes) }} / {{ fmtBytes(quotaBytes) }}</span>
        </div>
        <div style="height:6px; background:var(--bg-r2); border-radius:4px; overflow:hidden;">
          <div :style="{ width: usagePct + '%', height: '100%', background: usagePct > 90 ? '#ef4444' : 'var(--accent)' }"></div>
        </div>
        <div v-if="browserEstimate" style="font-size:10px; color:var(--text-muted); margin-top:4px;">
          {{ t('browserQuotaAvailable') || 'Browser quota available' }}: {{ fmtBytes(browserEstimate.quota - browserEstimate.usage) }}
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-top:8px;">
          <label style="font-size:11px; color:var(--text-muted);">{{ t('storageLimit') || 'Storage limit (GB)' }}</label>
          <input type="number" min="1" step="1" v-model.number="quotaGB" style="width:70px; padding:3px 6px; font-size:11px;" />
        </div>
      </div>

      <!-- Seeding toggle -->
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:18px; padding:10px 12px; background:var(--bg-r2); border-radius:6px;">
        <div>
          <div style="font-size:12px; font-weight:600;">{{ t('seeding') || 'Seed downloaded torrents' }}</div>
          <div style="font-size:10px; color:var(--text-muted);">{{ t('seedingHint') || 'Help others download by uploading what you already have' }}</div>
        </div>
        <button class="btn" :class="seeding ? 'btn-primary' : 'btn-ghost'" style="padding:6px 14px;" @click="toggleSeeding">
          {{ seeding ? (t('on') || 'On') : (t('off') || 'Off') }}
        </button>
      </div>

      <!-- Per-torrent manifest -->
      <div style="font-size:11px; font-weight:600; margin-bottom:6px;">
        {{ t('storedTorrents') || 'Stored torrents' }} ({{ manifest.length }})
      </div>
      <div style="max-height:220px; overflow-y:auto; margin-bottom:18px;">
        <div v-if="!manifest.length" style="font-size:11px; color:var(--text-muted);">{{ t('noStoredTorrents') || 'Nothing stored yet.' }}</div>
        <div v-for="e in manifest" :key="e.infoHash" style="padding:7px 0; border-bottom:1px solid var(--border-main);">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; font-size:11px;">
            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px;" :title="e.title">{{ e.title }}</span>
            <span style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
              <span style="color:var(--text-muted);">{{ fmtBytes(e.sizeBytes) }}</span>
              <button class="btn btn-ghost" style="padding:3px 8px; font-size:10px;"
                      :title="t('playStoredTorrent') || 'Play'" @click="playStored(e)">
                <i class="fa-solid fa-play"></i>
              </button>
              <button class="btn" style="padding:3px 8px; font-size:10px;" :class="e.fullDownload ? 'btn-primary' : 'btn-ghost'"
                      :title="t('downloadWholeTorrent') || 'Download entire torrent for offline playback later'"
                      @click="toggleEntryFullDownload(e)">
                <i v-if="e.done" class="fa-solid fa-check"></i>
                <i v-else class="fa-solid fa-download"></i>
              </button>
            </span>
          </div>
          <div v-if="e.fullDownload && !e.done" style="height:4px; background:var(--bg-r2); border-radius:3px; overflow:hidden; margin-top:5px;">
            <div :style="{ width: Math.round(e.progress * 100) + '%', height: '100%', background: 'var(--accent)' }"></div>
          </div>
        </div>
      </div>

      <button class="btn btn-danger" style="width:100%; padding:9px;" :disabled="clearing || !manifest.length" @click="handleClearAll">
        <i class="fa-solid fa-trash"></i> {{ clearing ? (t('clearing') || 'Clearing…') : (t('clearAllWebtorrentData') || 'Clear all downloaded torrent data') }}
      </button>
    </div>
  </div>
</div>
</Teleport>
</template>