<script setup lang="ts">
/**
 * modules/notifications/components/NotificationsList.vue
 *
 * Just the list -- no modal box, no overlay, no panel chrome. Notifications
 * themselves don't (and shouldn't) know or care where they end up on
 * screen: NotifModal.vue wraps this in a modal for the classic forum UI,
 * and cinema mode renders it directly in a rail-anchored panel (see
 * modules/cinema/CinemaRail.vue). Exactly one place owns the actual list
 * markup/logic either way.
 */
import type { NotificationItem } from '../types';

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
  openNotification: [notif: NotificationItem];
  openProfile: [username: string];
  togglePushNotifications: [];
}>();
</script>

<template>
<div class="notif-list-wrap">
  <div v-if="notifModal.pushSupported" class="notif-settings-row">
    <span>{{ t('browserNotifications') }}</span>
    <label class="switch">
      <input type="checkbox" :checked="notifModal.pushEnabled" @change="emit('togglePushNotifications')">
      <span class="slider-toggle"></span>
    </label>
  </div>

  <div v-if="notifModal.loading" class="loader"><span class="spin"></span>{{ t('loading') }}</div>
  <div v-else>
    <div v-for="n in notifModal.list" :key="n.id" class="notif-item row-hover" tabindex="0"
         @click="emit('openNotification', n)"
         @keydown.enter.space.prevent="emit('openNotification', n)"
         :style="{ 
            padding: '10px 15px', 
            borderBottom: '1px solid var(--surface-border)',
            background: isUnread(n) ? 'var(--surface-4)' : (notifModal.clickedIds.includes(`${n.account}-${n.id}`) ? 'transparent' : 'var(--surface-3)'),
            fontWeight: notifModal.clickedIds.includes(`${n.account}-${n.id}`) ? 'normal' : 'bold',
            opacity: notifModal.clickedIds.includes(`${n.account}-${n.id}`) ? 0.7 : 1
         }">
      <div style="display:flex; gap:10px; align-items:center;">
         <span style="font-size: 18px;">{{ getNotifIcon(n.type) }}</span>
         <div style="flex:1">
           <div style="display:flex; align-items:center; gap:5px; flex-wrap:wrap;">
             <template v-if="n.msg"> {{ n.msg }}</template>
             <template v-else>
               <b v-if="n.author" tabindex="0" @click.stop="emit('openProfile', n.author)" @keydown.enter.space.stop.prevent="emit('openProfile', n.author!)">@{{ n.author }}</b> 
               <span v-if="n.type==='reply'"> {{ t('repliedToYou') }}</span>
               <span v-else-if="n.type==='mention'"> {{ t('mentionedYou') }}</span>
               <span v-else-if="n.type==='vote'"> {{ t('votedYourPost') }}</span>
               <span v-else> {{ n.type }}</span>
             </template>
             <span v-if="n.account && auth.user?.username !== n.account" 
                   style="font-size:10px; background:var(--surface-2); padding:1px 4px; border-radius:3px; color:var(--text-soft); border:1px solid var(--surface-border);">
               → @{{ n.account }}
             </span>
           </div>
           <div class="gs" style="margin-top:2px;">{{ timeAgo(n.date) }}</div>
         </div>
         <span v-if="isUnread(n)" style="width:8px; height:8px; background:#ff4400; border-radius:50%; flex-shrink:0;"></span>
      </div>
    </div>
    <div v-if="notifModal.list.length===0" style="padding: 20px; text-align: center; color:var(--text-soft);">{{ t('noNotifications') }}</div>
  </div>
</div>
</template>

<style scoped>
.notif-list-wrap { height: 100%; overflow-y: auto; }

.notif-settings-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 15px;
  border-bottom: 1px solid var(--surface-border);
  background: var(--surface-2);
  font-size: 13px;
}

.switch { position: relative; display: inline-block; width: 34px; height: 20px; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider-toggle {
  position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
  background-color: var(--surface-4); transition: .4s; border-radius: 20px; border: 1px solid var(--surface-border);
}
.slider-toggle:before {
  position: absolute; content: ""; height: 14px; width: 14px; left: 2px; bottom: 2px;
  background-color: var(--text-soft); transition: .4s; border-radius: 50%;
}
input:checked + .slider-toggle { background-color: var(--brand); border-color: var(--brand); }
input:checked + .slider-toggle:before { transform: translateX(14px); background-color: white; }

.notif-item { font-size: 13px; color: var(--notif-text); cursor: pointer; }
.notif-item:last-child { border-bottom: none !important; }
.notif-item .gs { display: block; margin-top: 3px; }
.notif-item:focus-visible, .notif-item b:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }
</style>
