<script setup lang="ts">
/**
 * modules/device-profiles/components/PinPad.vue
 *
 * Chromecast/Android-TV-style zone PIN entry -- purely a VIEW now. All the
 * actual state (which zone is highlighted, digits entered so far) and the
 * arrow-key mechanic itself live in pinpad-state.ts / modules/cinema/
 * dpad-nav.ts's PIN_PAD zone (checked at the very top of its dispatch,
 * highest priority, same precedent as the existing volume-slider edit-mode
 * carve-out in that file). This component only registers itself on mount
 * (so dpad-nav.ts's carve-out and the on-screen rendering both read from
 * the same shared state) and renders whatever that state currently is.
 *
 * Deliberately has NO keydown listener of its own anymore -- an earlier
 * version did, and it fought with the app's real navigation system (two
 * independent listeners reacting to the same key), which is exactly the
 * bug class this rewrite exists to eliminate. See dpad-nav.ts's own
 * PIN_PAD zone comment for the full reasoning.
 *
 * To get a genuinely fresh, reset pin pad for a new step (e.g. "enter new
 * PIN" -> "confirm PIN"), give this component a different :key from the
 * parent -- that forces Vue to unmount+remount it, which re-runs
 * registerPinPad() in onMounted and clears any previous digits/zone.
 * Don't rely on prop changes alone (:title changing does NOT reset state).
 */
import { onMounted, onUnmounted } from 'vue';
import {
  pinZone, pinDigits, pinShaking, pinLength,
  registerPinPad, unregisterPinPad, pinReset, pinFail, pinCommit, getPinZoneDigits,
} from '../pinpad-state';

const props = withDefaults(defineProps<{
  length?: number;
  title: string;
  subtitle?: string | null;
}>(), {
  length: 4,
  subtitle: null,
});

const emit = defineEmits<{
  complete: [pin: string];
}>();

onMounted(() => registerPinPad(props.length, (pin) => emit('complete', pin)));
onUnmounted(() => unregisterPinPad());

const ZONES: Array<'A' | 'B' | 'C'> = ['A', 'B', 'C'];

/** Wrong PIN was verified by the parent -- shake, then reset for a retry
 *  (same step, no remount -- see this file's own top comment for when to
 *  use a :key change instead). */
function fail(): void {
  pinFail();
}

/** Mouse/touch: tapping a visible digit enters it directly (also sets the
 *  highlighted zone to match, for visual consistency) -- unlike a D-pad
 *  press, a tap has no shoulder-surfing ambiguity to preserve, so there's
 *  no reason to make clicking indirect. */
function clickDigit(zone: 'A' | 'B' | 'C', digit: string): void {
  pinZone.value = zone;
  pinCommit(digit);
}

defineExpose({ reset: pinReset, fail });
</script>

<template>
  <div class="pinpad" :class="{ 'pinpad--shake': pinShaking }">
    <p class="pinpad-title">{{ title }}</p>
    <p v-if="subtitle" class="pinpad-subtitle">{{ subtitle }}</p>

    <div class="pinpad-dots" role="status" :aria-label="`${pinDigits.length} z ${pinLength} cyfr wpisanych`">
      <span
        v-for="i in pinLength" :key="i"
        class="pinpad-dot"
        :class="{ 'pinpad-dot--filled': i <= pinDigits.length }"
      ></span>
    </div>

    <div class="pinpad-zones">
      <div
        v-for="z in ZONES" :key="z"
        class="pinpad-zone"
        :class="{ 'pinpad-zone--active': pinZone === z }"
      >
        <button
          v-for="d in getPinZoneDigits(z)" :key="d"
          type="button"
          class="pinpad-key"
          @click="clickDigit(z, d)"
        >{{ d }}</button>
      </div>
      <div class="pinpad-zone pinpad-zone--zero" :class="{ 'pinpad-zone--active': pinZone === 'C' }">
        <button type="button" class="pinpad-key" @click="clickDigit('C', '0')">0</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pinpad {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 22px;
  padding: 32px 40px;
  background: var(--card-bg);
  border: 1px solid var(--surface-border);
  border-radius: 14px;
}
.pinpad--shake { animation: pinpad-shake 0.42s ease; }
@keyframes pinpad-shake {
  10%, 90% { transform: translateX(-6px); }
  20%, 80% { transform: translateX(8px); }
  30%, 50%, 70% { transform: translateX(-12px); }
  40%, 60% { transform: translateX(12px); }
}

.pinpad-title { margin: 0; font-size: 1.15rem; font-weight: 700; color: var(--text-strong); }
.pinpad-subtitle { margin: -14px 0 0; font-size: 0.85rem; color: var(--text-soft); }

.pinpad-dots { display: flex; gap: 14px; }
.pinpad-dot {
  width: 16px; height: 16px;
  border-radius: 50%;
  border: 2px solid var(--surface-border);
  background: transparent;
  transition: background-color .15s ease, border-color .15s ease, transform .15s ease;
}
.pinpad-dot--filled { background: var(--brand); border-color: var(--brand); transform: scale(1.15); }

.pinpad-zones { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.pinpad-zone {
  display: flex;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 2px solid transparent;
  transition: border-color .12s ease, background-color .12s ease;
}
.pinpad-zone--active {
  border-color: var(--brand);
  background: var(--surface-2);
  box-shadow: 0 0 0 4px var(--brand);
}
.pinpad-zone--zero { margin-top: 2px; }
.pinpad-key {
  width: 56px; height: 56px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-strong);
  font-size: 1.3rem;
  font-weight: 600;
  border: none;
  cursor: pointer;
  font-family: inherit;
}
.pinpad-key:hover, .pinpad-key:focus-visible { background: var(--surface-3); outline: none; }
.pinpad-zone--active .pinpad-key { background: var(--surface-3); }
</style>
