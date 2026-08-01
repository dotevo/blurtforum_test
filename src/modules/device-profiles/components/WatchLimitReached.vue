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
 *
 * Carries the `modal-overlay` class so dpad-nav.ts's MODAL zone drives
 * Enter/arrow-key focus on the single button here; no `.modal-close`
 * anywhere, so Escape correctly does nothing -- this can't be dismissed
 * except by actually switching profiles.
 */
import { onMounted, nextTick, ref, computed } from 'vue';
import { activeProfile, exitProfile } from '../device-profiles';
import { useBodyScrollLock } from '../body-scroll-lock';

const props = defineProps<{ t: (k: string) => string }>();

useBodyScrollLock();

const rootRef = ref<HTMLElement | null>(null);
onMounted(() => { void nextTick(() => rootRef.value?.querySelector<HTMLElement>('button')?.focus()); });

const minutes = computed(() => activeProfile.value?.dailyLimitMinutes ?? 0);

// t() has no parameterized-interpolation support, so this substitutes
// {min}/{name} placeholders directly -- keeps each language's own full
// sentence (and word order) intact instead of concatenating translated
// fragments around the numbers, which breaks for languages ordering things
// differently.
const limitText = computed(() =>
  (props.t('watchLimitText') || "Today's watch-time limit ({min} min) for profile {name} has been used up. Come back tomorrow or switch to a different profile.")
    .replace('{min}', String(minutes.value))
    .replace('{name}', activeProfile.value?.name ?? ''),
);
</script>

<template>
  <div ref="rootRef" class="watch-limit-gate modal-overlay">
    <i class="fa-solid fa-hourglass-end watch-limit-icon"></i>
    <h1 class="watch-limit-title">{{ t('watchLimitTitle') || "Time's up for today" }}</h1>
    <p class="watch-limit-text">{{ limitText }}</p>
    <button class="watch-limit-btn" @click="exitProfile">
      <i class="fa-solid fa-shuffle"></i> {{ t('profileSwitchProfile') || 'Switch profile' }}
    </button>
  </div>
</template>

<style scoped>
.watch-limit-gate {
  /* .modal-overlay (global) gives position:fixed/inset:0/z-index/centering;
     this scoped rule overrides only what needs to differ and wins
     automatically (scoped selectors are more specific). */
  z-index: 2200;
  flex-direction: column;
  gap: 16px;
  padding: 32px;
  text-align: center;
  background: var(--surface-1);
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
