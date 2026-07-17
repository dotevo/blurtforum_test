<script setup lang="ts">
import { ref } from 'vue';
import type { AuthUser } from '../../types';
import type { BFPlayerAPI } from '../../modules/player/types';
import NotifBell from '../layout/NotifBell.vue';
import UserAvatar from '../layout/UserAvatar.vue';
import SettingsSelectors from '../layout/SettingsSelectors.vue';

defineProps<{
  auth: { user: AuthUser | null };
  hasNewNotif: boolean;
  theme: string;
  themes: { id: string; label: string }[];
  lang: string;
  langs: string[];
  rpcMenuOpen: boolean;
  cinemaMode: boolean;
  /** Optional: lets app components (currently just the player, e.g.
   *  Playlists) contribute their own entries into this rail via
   *  player.registerRailItem() -- see modules/player/types.ts. Nothing
   *  else about CinemaRail needs to know what a given item does. */
  player?: BFPlayerAPI;
  t: (k: string) => string;
}>();

const emit = defineEmits<{
  goHome: [];
  openLoginModal: [];
  openNotifModal: [];
  openProfile: [username: string];
  logout: [];
  setTheme: [value: string];
  setLang: [value: string];
  'update:rpcMenuOpen': [value: boolean];
  setCinemaMode: [value: boolean];
}>();

// Desktop: expand on hover/focus. Mobile: expand via swipe-from-edge, same
// gesture as in the reference mock.
const expanded = ref(false);
let touchStartX: number | null = null;
let touchStartY: number | null = null;
const EDGE_ZONE = 24;
const SWIPE_THRESHOLD = 60;

function onTouchStart(e: TouchEvent) {
  const t = e.touches[0];
  touchStartX = t.clientX;
  touchStartY = t.clientY;
}
function onTouchEnd(e: TouchEvent) {
  if (touchStartX === null) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStartX;
  const dy = Math.abs(t.clientY - (touchStartY || 0));
  if (dy < 60) {
    if (!expanded.value && touchStartX <= EDGE_ZONE && dx > SWIPE_THRESHOLD) expanded.value = true;
    else if (expanded.value && dx < -SWIPE_THRESHOLD) expanded.value = false;
  }
  touchStartX = null;
  touchStartY = null;
}
</script>

<template>
<div
  class="rail-toggle-btn"
  @click="expanded = !expanded"
  :aria-label="expanded ? 'Close menu' : 'Open menu'"
>
  <i class="fa-solid" :class="expanded ? 'fa-xmark' : 'fa-bars'"></i>
</div>

<div class="cinema-rail-overlay" :class="{ visible: expanded }" @click="expanded = false"></div>

<div
  class="cinema-rail"
  :class="{ expanded }"
  @mouseenter="expanded = true"
  @mouseleave="expanded = false"
  @touchstart.passive="onTouchStart"
  @touchend.passive="onTouchEnd"
>
  <div class="rail-logo" @click="emit('goHome')">
    <i class="fa-solid fa-clapperboard"></i>
    <span class="rail-label">{{ t('siteTitle') || 'BlurtForum' }}</span>
  </div>

  <nav class="rail-nav">
    <a class="rail-item active" href="#" @click.prevent="emit('goHome')">
      <i class="fa-solid fa-film"></i>
      <span class="rail-label">{{ t('videos') || 'Wideo' }}</span>
    </a>
    <template v-if="player">
      <a v-for="item in player.getRailItems()" :key="item.id"
         v-show="!item.visible || item.visible()" class="rail-item" href="#" @click.prevent="item.onClick()">
        <i :class="item.icon"></i>
        <span class="rail-label">{{ item.label }}</span>
        <span v-if="item.badge && item.badge()" class="rail-badge rail-label">{{ item.badge() }}</span>
      </a>
    </template>
  </nav>

  <div class="rail-spacer"></div>

  <div class="rail-footer">
    <div class="rail-item rail-vp" v-if="auth.user" :title="'Voting Power: ' + auth.user.vp + '%'">
      <i class="fa-solid fa-bolt"></i>
      <div class="rail-vp-info rail-label">
        <span class="rail-vp-value">VP: {{ auth.user.vp }}%</span>
        <div class="rail-vp-track"><div class="rail-vp-fill" :style="{ width: auth.user.vp + '%' }"></div></div>
      </div>
    </div>

    <div class="rail-settings-wrap">
      <SettingsSelectors
        rail
        :theme="theme" :themes="themes" :lang="lang" :langs="langs"
        :cinema-mode="cinemaMode"
        :t="t"
        @set-theme="emit('setTheme', $event)"
        @set-lang="emit('setLang', $event)"
        @open-rpc="emit('update:rpcMenuOpen', true)"
        @set-cinema-mode="emit('setCinemaMode', $event)"
      />
    </div>

    <div class="rail-item" v-if="!auth.user" @click="emit('openLoginModal')">
      <i class="fa-solid fa-right-to-bracket"></i>
      <span class="rail-label">{{ t('login') }}</span>
    </div>
    <template v-else>
      <div class="rail-item" @click="emit('openNotifModal')">
        <NotifBell :has-new="hasNewNotif" size="sm" />
        <span class="rail-label">{{ t('notifications') || 'Powiadomienia' }}</span>
      </div>
      <div class="rail-item" @click="emit('openProfile', auth.user.username)">
        <UserAvatar :username="auth.user.username" size="xs" round />
        <span class="rail-label">@{{ auth.user.username }}</span>
      </div>
      <div class="rail-item" @click="emit('logout')">
        <i class="fa-solid fa-right-from-bracket"></i>
        <span class="rail-label">{{ t('logout') }}</span>
      </div>
    </template>
  </div>
</div>
</template>

<style scoped>
.cinema-rail {
  position: fixed;
  top: 0;
  left: 0;
  height: 100vh;
  width: 72px;
  background: var(--surface-1);
  border-right: 1px solid var(--surface-border);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 16px 0;
  z-index: 200;
  overflow: hidden;
  white-space: nowrap;
  transition: width 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}
.cinema-rail.expanded {
  width: 230px;
  box-shadow: 10px 0 30px rgba(0, 0, 0, 0.25);
}

.rail-logo {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 0 22px;
  margin-bottom: 30px;
  height: 32px;
  cursor: pointer;
  color: var(--brand);
  font-size: 22px;
}

.rail-nav { width: 100%; }

.rail-spacer { flex-grow: 1; }

.rail-footer {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px solid var(--surface-border);
  padding-top: 10px;
}

.rail-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 12px 22px;
  color: var(--text-soft);
  text-decoration: none;
  cursor: pointer;
  gap: 16px;
  font-size: 14px;
  font-weight: 500;
}
.rail-item:hover, .rail-item.active { color: var(--brand); background: var(--surface-2); }
.rail-item i { font-size: 18px; min-width: 20px; text-align: center; }
.rail-badge {
  margin-left: auto;
  background: var(--surface-2);
  color: var(--text-soft);
  font-size: 11px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 10px;
}

.rail-vp { cursor: default; }
.rail-vp:hover { background: transparent; color: var(--text-soft); }
.rail-vp-info { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.rail-vp-value { font-size: 12px; font-weight: 700; color: var(--text-strong); }
.rail-vp-track { width: 100%; height: 4px; background: var(--surface-2); border-radius: 2px; overflow: hidden; }
.rail-vp-fill { height: 100%; background: var(--brand); border-radius: 2px; }

.rail-label {
  opacity: 0;
  transition: opacity 0.2s;
}
.cinema-rail.expanded .rail-label { opacity: 1; }

.rail-settings {
  padding: 6px 14px 10px;
}
.rail-settings-wrap {
  width: 100%;
  opacity: 0;
  max-height: 0;
  overflow: hidden;
  transition: opacity 0.15s;
}
.cinema-rail.expanded .rail-settings-wrap {
  opacity: 1;
  max-height: 300px;
  overflow: visible;
}

.rail-toggle-btn {
  display: none;
}

.cinema-rail-overlay {
  position: fixed;
  inset: 0;
  z-index: 199;
  background: rgba(0,0,0,0.5);
  backdrop-filter: blur(4px);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s ease;
}
.cinema-rail-overlay.visible {
  opacity: 1;
  pointer-events: auto;
}
/* On desktop the rail only ever grows in place (no overlay needed behind it,
   matches the mock where hover-expand doesn't blur the page) -- the blur
   overlay is a mobile-only affordance for the swipe-open drawer. */
@media (min-width: 769px) {
  .cinema-rail-overlay { display: none; }
}

@media (max-width: 768px) {
  .rail-toggle-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    position: fixed;
    top: 14px;
    left: 14px;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: rgba(0,0,0,0.55);
    backdrop-filter: blur(4px);
    color: #fff;
    font-size: 16px;
    z-index: 201;
    cursor: pointer;
  }
  .cinema-rail { transform: translateX(-100%); transition: transform 0.28s cubic-bezier(0.4,0,0.2,1); width: 230px; }
  .cinema-rail.expanded { transform: translateX(0); width: 230px; box-shadow: 10px 0 30px rgba(0,0,0,0.35); }
  .cinema-rail:not(.expanded) .rail-label { opacity: 0; }
  .cinema-rail.expanded .rail-label { opacity: 1; }
}
</style>
