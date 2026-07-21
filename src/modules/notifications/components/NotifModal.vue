<script setup lang="ts">
import type { NotificationItem } from '../types';
import NotificationsList from './NotificationsList.vue';

defineProps<{
  notifModal: {
    show: boolean; loading: boolean;
    list: NotificationItem[];
    clickedIds: (number | string)[];
    pushSupported: boolean;
    pushEnabled: boolean;
  };
  auth: { user: any };
  t: (k: string) => string;
  timeAgo: (s: string) => string;
  getNotifIcon: (type: string) => string;
  isUnread: (item: NotificationItem) => boolean;
}>();

const emit = defineEmits<{
  close: [];
  openNotification: [notif: NotificationItem];
  openProfile: [username: string];
  togglePushNotifications: [];
}>();
</script>

<template>
<!-- NOTIFICATIONS MODAL -->
<div v-if="notifModal.show" class="modal-overlay" @click.self="emit('close')">
  <div class="modal-box" style="width: 500px;">
    <div class="modal-header">
      {{ t('notifications') }}
      <button class="modal-close" @click="emit('close')">✕</button>
    </div>
    <div class="modal-body" style="padding: 0;">
      <NotificationsList
        :notif-modal="notifModal"
        :auth="auth"
        :t="t"
        :time-ago="timeAgo"
        :get-notif-icon="getNotifIcon"
        :is-unread="isUnread"
        @open-notification="emit('openNotification', $event)"
        @open-profile="(u: string) => { emit('openProfile', u); emit('close'); }"
        @toggle-push-notifications="emit('togglePushNotifications')"
      />
    </div>
  </div>
</div>
</template>
