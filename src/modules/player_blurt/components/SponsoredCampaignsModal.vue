<script setup lang="ts">
/**
 * Shows every sponsored-ad transfer the sponsored-plugin has parsed in the
 * last 14 days, with its BPS (the weight used in the weighted-lottery
 * selection), so users/advertisers can see current "prices". The date field
 * lets you preview what would be active on a different day (e.g. tomorrow)
 * without waiting for it to actually be that day.
 */
import { ref, computed, onMounted } from 'vue';
import { getAllCampaigns, refreshCampaignsNow } from '../sponsored-campaigns';
import type { SponsoredCampaign } from '../sponsored-campaigns';
import MiniComboChart from '../../charts/MiniComboChart.vue';
import type { ComboSeriesInput } from '../../charts/mini-charts';

const props = defineProps<{
  client: any;
  t: (k: string) => string;
}>();

const emit = defineEmits<{ close: [] }>();

const todayIso = (): string => new Date().toISOString().slice(0, 10);

const previewDate = ref(todayIso());
const loading = ref(false);
const campaigns = ref<SponsoredCampaign[]>(getAllCampaigns());

type Status = 'active' | 'upcoming' | 'expired';

const previewTimestamp = computed<number>(() => {
  const ms = Date.parse(`${previewDate.value}T00:00:00Z`);
  return Number.isNaN(ms) ? Date.now() : ms;
});

const rows = computed<(SponsoredCampaign & { status: Status })[]>(() => {
  const now = previewTimestamp.value;
  const statusOrder: Record<Status, number> = { active: 0, upcoming: 1, expired: 2 };

  return campaigns.value
    .map(c => ({
      ...c,
      status: (now < c.start ? 'upcoming' : now > c.end ? 'expired' : 'active') as Status,
    }))
    .sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || b.bps - a.bps);
});

const fmtDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const handleRefresh = async (): Promise<void> => {
  loading.value = true;
  try {
    campaigns.value = await refreshCampaignsNow(props.client);
  } finally {
    loading.value = false;
  }
};

// ─── Chart: max BPS + ad count per day, 7 days back / 7 days ahead ────────
// (today fixed in the middle, regardless of which day is selected below)

const DAY_MS = 86_400_000;
const todayStartMs = (() => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
})();

interface DayStat {
  ms: number;
  iso: string;
  label: string;
  maxBps: number | null;
  count: number;
  isFuture: boolean;
  isToday: boolean;
}

const dayStats = computed<DayStat[]>(() => {
  const out: DayStat[] = [];
  for (let i = -7; i <= 7; i++) {
    const ms = todayStartMs + i * DAY_MS;
    const dayEnd = ms + DAY_MS - 1;
    const active = campaigns.value.filter(c => c.start <= dayEnd && c.end >= ms);
    const d = new Date(ms);
    out.push({
      ms,
      iso: fmtDate(ms),
      label: `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
      maxBps: active.length ? Math.max(...active.map(c => c.bps)) : null,
      count: active.length,
      isFuture: ms > todayStartMs,
      isToday: ms === todayStartMs,
    });
  }
  return out;
});

const bpsLabel = computed(() => props.t('bps') || 'Max BPS');
const futureBpsLabel = computed(() => `${bpsLabel.value} (${props.t('upcoming') || 'upcoming'})`);

const todayIdx = computed(() => dayStats.value.findIndex(d => d.isToday));
const selectedIdx = computed(() => dayStats.value.findIndex(d => d.iso === previewDate.value));

const chartCategories = computed(() => dayStats.value.map(d => d.label));

const chartSeries = computed<ComboSeriesInput[]>(() => {
  const stats = dayStats.value;
  const idx = todayIdx.value;
  return [
    {
      name: props.t('adsCount') || 'Ads',
      type: 'bar',
      axis: 'primary',
      color: '#98AAB1',
      data: stats.map(d => d.count),
    },
    {
      name: bpsLabel.value,
      type: 'line',
      axis: 'secondary',
      color: '#1a9b78',
      data: stats.map((d, i) => (i <= idx ? d.maxBps : null)),
    },
    {
      name: futureBpsLabel.value,
      type: 'line',
      axis: 'secondary',
      color: '#1a9b78',
      dashed: true,
      data: stats.map((d, i) => (i >= idx ? d.maxBps : null)),
    },
  ];
});

const chartTooltipHtml = (index: number): string => {
  const d = dayStats.value[index];
  if (!d) return '';
  const tag = d.isToday ? (props.t('today') || 'Today') : d.isFuture ? (props.t('upcoming') || 'Upcoming') : '';
  return `
    <div style="padding:8px 10px; font-size:11px; line-height:1.6; background:var(--modal-bg); border:1px solid var(--border-main); border-radius:6px; color:var(--text);">
      <div style="font-weight:700; margin-bottom:4px;">${d.iso}${tag ? ' · ' + tag : ''}</div>
      <div>${bpsLabel.value}: <b>${d.maxBps != null ? d.maxBps.toFixed(4) : '—'}</b></div>
      <div>${props.t('adsCount') || 'Ads'}: <b>${d.count}</b></div>
    </div>`;
};

const handleChartSelect = (index: number): void => {
  const stat = dayStats.value[index];
  if (stat) previewDate.value = stat.iso;
};

onMounted(() => {
  // First open might race the plugin's own initial fetch — make sure we
  // have something rather than showing an empty list forever.
  if (!campaigns.value.length) handleRefresh();
});
</script>

<template>
  <Teleport to="body">
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal-box" style="width: 620px; max-width: 94vw;">
      <div class="modal-header">
        <span style="display:flex; align-items:center; gap:8px;">
          <i class="fa-solid fa-bullhorn"></i> {{ t('sponsoredAds') || 'Sponsored Ads' }}
        </span>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="sp-ads-toolbar">
          <label class="form-label" style="margin:0;">{{ t('checkActiveOn') || 'Check active on' }}</label>
          <input type="date" v-model="previewDate" class="pl-create-input sp-ads-date" />
          <button class="bfp-btn" @click="previewDate = todayIso()">{{ t('today') || 'Today' }}</button>
          <button class="bfp-btn sp-ads-refresh" @click="handleRefresh" :disabled="loading" title="Refresh from chain">
            <i class="fa-solid fa-arrows-rotate" :class="{ 'fa-spin': loading }"></i>
          </button>
        </div>

        <MiniComboChart
          class="sp-ads-chart"
          :categories="chartCategories"
          :series="chartSeries"
          :height="210"
          :selected-index="selectedIdx"
          :highlight-index="todayIdx"
          :primary-axis-label="t('adsCount') || 'Ads'"
          :secondary-axis-label="'BPS'"
          :tooltip-html="chartTooltipHtml"
          @select="handleChartSelect"
        />

        <div v-if="!rows.length" class="sp-ads-empty">
          {{ t('noSponsoredAds') || 'No sponsored transfers found in the last 14 days.' }}
        </div>

        <div v-else class="sp-ads-table">
          <div class="sp-ads-row sp-ads-row--head">
            <span>{{ t('sponsor') || 'Sponsor' }}</span>
            <span>{{ t('bps') || 'BPS' }}</span>
            <span>{{ t('amount') || 'Amount' }}</span>
            <span>{{ t('window') || 'Window' }}</span>
            <span>{{ t('status') || 'Status' }}</span>
          </div>
          <div v-for="c in rows" :key="c.id" class="sp-ads-row" :class="`sp-ads-row--${c.status}`">
            <span class="sp-ads-sender" :title="c.url">
              <a :href="c.url" target="_blank" rel="noopener noreferrer">@{{ c.from }}</a>
            </span>
            <span>{{ c.bps.toFixed(4) }}</span>
            <span>{{ c.amount.toFixed(3) }} BLURT <small>/ {{ c.days }}d, {{ c.sec }}s</small></span>
            <span>{{ fmtDate(c.start) }} → {{ fmtDate(c.end) }}</span>
            <span class="sp-ads-status">{{ t(c.status) || c.status }}</span>
          </div>
        </div>

        <div class="sp-ads-hint">
          {{ t('sponsoredHint') || 'Higher BPS = higher chance of being picked, never a guarantee — selection is a weighted lottery.' }}
        </div>
      </div>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.sp-ads-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.sp-ads-date { height: 32px; width: auto; }
.sp-ads-refresh { margin-left: auto; }

.sp-ads-chart { margin-bottom: 16px; }
.sp-ads-chart { cursor: default; }

.sp-ads-empty { font-size: 12px; color: var(--text-muted); padding: 24px 0; text-align: center; }

.sp-ads-table { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
.sp-ads-row {
  display: grid;
  grid-template-columns: 1.4fr 0.7fr 1.5fr 1.4fr 0.8fr;
  gap: 8px;
  padding: 6px 4px;
  align-items: center;
}
.sp-ads-row--head {
  font-weight: 700;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-main, #98AAB1);
  padding-bottom: 8px;
}
.sp-ads-row:not(.sp-ads-row--head) { border-bottom: 1px solid rgba(128, 128, 128, 0.15); }
.sp-ads-row--expired { opacity: 0.5; }
.sp-ads-status { text-transform: capitalize; }
.sp-ads-row--active .sp-ads-status { color: var(--bfp-accent, #1a9b78); font-weight: 700; }
.sp-ads-row--upcoming .sp-ads-status { color: #f5a623; font-weight: 700; }
.sp-ads-sender a { color: inherit; text-decoration: none; }
.sp-ads-sender a:hover { text-decoration: underline; }

.sp-ads-hint { font-size: 11px; color: var(--text-muted); margin-top: 14px; }

@media (max-width: 560px) {
  .sp-ads-row { grid-template-columns: 1fr 1fr; }
  .sp-ads-row--head { display: none; }
  .sp-ads-sender { grid-column: 1 / -1; font-weight: 700; }
}
</style>
