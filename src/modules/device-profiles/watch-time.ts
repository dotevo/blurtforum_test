import { ref, watch } from 'vue';
import { state as playerState } from '../player/player';
import { activeProfile } from './device-profiles';

/**
 * modules/device-profiles/watch-time.ts
 *
 * Ticks once a second, but only counts seconds where BOTH are true: a
 * device profile is active, and something is actually playing
 * (playerState.playing) -- sitting on the picker, browsing menus, or
 * paused doesn't burn down the daily budget, only real watch time does.
 *
 * Storage is deliberately plain localStorage, not the Keystore-backed
 * device-profile-store.ts -- "how many minutes were watched today" isn't
 * sensitive the way a PIN hash or account list is, so there's no reason to
 * pay for the native round-trip on every single tick.
 *
 * Switching profiles (exitProfile/selectProfile in device-profiles.ts)
 * re-baselines usedSecondsToday to whichever profile just became active --
 * each profile's usage is tracked completely independently, keyed by
 * profile id + today's date, so switching to profile B and back to A never
 * mixes up whose time is whose.
 */
const STORAGE_PREFIX = 'bf-watch-time:';

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function storageKey(profileId: string): string {
  return `${STORAGE_PREFIX}${profileId}:${todayKey()}`;
}

function loadUsedSeconds(profileId: string): number {
  try {
    const raw = localStorage.getItem(storageKey(profileId));
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}

function saveUsedSeconds(profileId: string, seconds: number): void {
  try {
    localStorage.setItem(storageKey(profileId), String(seconds));
  } catch (e) {
    console.warn('watch-time: failed to persist usage', e);
  }
}

/** Seconds watched today by the currently-active profile. Reactive, resets to that profile's own stored value whenever the active profile changes. */
export const usedSecondsToday = ref(0);

/** True once the active profile's dailyLimitMinutes has been reached. Reset to false automatically when switching to a different profile (or one with no limit) -- see the watcher below. */
export const limitReached = ref(false);

let tickTimer: ReturnType<typeof setInterval> | null = null;

function startTicking(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    const profile = activeProfile.value;
    if (!profile || !playerState.playing || limitReached.value) return;
    usedSecondsToday.value += 1;
    saveUsedSeconds(profile.id, usedSecondsToday.value);
    if (profile.dailyLimitMinutes != null && usedSecondsToday.value >= profile.dailyLimitMinutes * 60) {
      limitReached.value = true;
      playerState.playing = false; // stop watching the instant the limit is hit, don't wait for the current track to end
    }
  }, 1000);
}

function stopTicking(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

watch(activeProfile, (profile) => {
  if (!profile) {
    stopTicking();
    usedSecondsToday.value = 0;
    limitReached.value = false;
    return;
  }
  usedSecondsToday.value = loadUsedSeconds(profile.id);
  limitReached.value = profile.dailyLimitMinutes != null && usedSecondsToday.value >= profile.dailyLimitMinutes * 60;
  startTicking();
}, { immediate: true });
