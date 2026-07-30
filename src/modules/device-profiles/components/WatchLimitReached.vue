<script setup lang="ts">
/**
 * modules/device-profiles/components/WatchLimitReached.vue
 *
 * Mounted by App.vue whenever watch-time.ts's limitReached flips true for
 * the active TV profile. Deliberately offers only one way forward --
 * switching profiles (exitProfile(), same action as CinemaRail's "Przełącz
 * profil") -- not a snooze/override button, since the entire point of the
 * daily limit is that the profile itself can't talk its way past it. An
 * admin can still raise or clear the limit from ManageProfiles.vue after
 * switching to their own profile.
 */
import { computed } from 'vue';
import { activeProfile, exitProfile } from '../device-profiles';
import { useBodyScrollLock } from '../body-scroll-lock';

useBodyScrollLock();

const minutes = computed(() => activeProfile.value?.dailyLimitMinutes ?? 0);
</script>

<template>
  <div class="watch-limit-gate">
    <i class="fa-solid fa-hourglass-end watch-limit-icon"></i>
    <h1 class="watch-limit-title">Koniec czasu na dziś</h1>
    <p class="watch-limit-text">
      Dzienny limit oglądania ({{ minutes }} min) dla profilu <strong>{{ activeProfile?.name }}</strong> został wykorzystany.
      Wróć jutro albo przełącz się na inny profil.
    </p>
    <button class="watch-limit-btn" @click="exitProfile">
      <i class="fa-solid fa-shuffle"></i> Przełącz profil
    </button>
  </div>
</template>

<style scoped>
.watch-limit-gate {
  position: fixed;
  inset: 0;
  z-index: 2200;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 32px;
  text-align: center;
  background: radial-gradient(ellipse at top, #1a1d24 0%, #0b0d12 60%);
  color: var(--text-strong);
  overflow-y: auto;
}
.watch-limit-icon { font-size: 3.2rem; color: var(--brand); }
.watch-limit-title { font-size: 1.6rem; font-weight: 700; margin: 0; }
.watch-limit-text { max-width: 420px; color: var(--text-soft); line-height: 1.5; }
.watch-limit-btn {
  margin-top: 12px;
  background: var(--brand);
  color: #fff;
  border: none;
  padding: 12px 22px;
  border-radius: 8px;
  font-weight: 700;
  font-size: 0.95rem;
  display: flex;
  align-items: center;
  gap: 10px;
}
.watch-limit-btn:focus-visible { outline: none; box-shadow: 0 0 0 4px #fff; }
</style>
