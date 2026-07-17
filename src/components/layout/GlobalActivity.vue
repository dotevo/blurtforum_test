<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import type { ActivityItem, AuthUser } from '../../types';
import ActivityFeed from './ActivityFeed.vue';

const props = defineProps<{
  auth: { user: AuthUser | null };
  globalActivity: ActivityItem[];
  activityTab: string;
  activityExpanded: boolean;
  activityFullList: boolean;
  updateGlobalActivity: () => void | Promise<void>;
  t: (k: string) => string;
  timeAgo: (s: string) => string;
}>();

const emit = defineEmits<{
  'update:activityTab': [value: string];
  'update:activityExpanded': [value: boolean];
  'update:activityFullList': [value: boolean];
  openActivity: [act: ActivityItem];
}>();

// Polling lives here on purpose: it should only run while this component is
// actually mounted. In cinema mode the parent simply doesn't render
// <GlobalActivity> (v-if="!cinemaMode"), which means these timers never get
// created in the first place — no extra cinemaMode plumbing needed.
let pollTimeout: ReturnType<typeof setTimeout> | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  pollTimeout = setTimeout(() => {
    props.updateGlobalActivity();
    pollInterval = setInterval(() => props.updateGlobalActivity(), 300000);
  }, 2000);
});

onUnmounted(() => {
  if (pollTimeout) clearTimeout(pollTimeout);
  if (pollInterval) clearInterval(pollInterval);
});
</script>

<template>
<!-- GLOBAL ACTIVITY FEED -->
<div v-if="auth.user && globalActivity.length > 0" class="global-activity-container">
  <div class="catHead activity-title">
    <i class="fa-solid fa-rss"></i> {{ t('globalActivity') }}
  </div>
  <ActivityFeed
    :global-activity="globalActivity"
    :activity-tab="activityTab"
    :activity-expanded="activityExpanded"
    :activity-full-list="activityFullList"
    :t="t"
    :time-ago="timeAgo"
    @update:activity-tab="emit('update:activityTab', $event)"
    @update:activity-expanded="emit('update:activityExpanded', $event)"
    @update:activity-full-list="emit('update:activityFullList', $event)"
    @open-activity="emit('openActivity', $event)"
  />
</div>
</template>

<style scoped>
.global-activity-container {
  margin: 0 15px 15px;
}

.activity-title {
  padding: 6px 12px;
  border-radius: 6px 6px 0 0;
  border: 1px solid var(--brand);
  border-bottom: none;
}
</style>
