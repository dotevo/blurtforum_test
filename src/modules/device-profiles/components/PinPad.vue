<script setup lang="ts">
/**
 * modules/device-profiles/components/PinPad.vue
 *
 * Chromecast/Android-TV-style zone PIN entry. The confirmed mechanic (see
 * the throwaway index.html test harness this was validated against first):
 *
 *   - Up/Down move the highlighted ZONE (A/B/C) only -- never enters a digit.
 *   - Left / Enter / Right never move the highlight -- they always enter the
 *     1st/2nd/3rd digit of whichever zone is CURRENTLY highlighted.
 *   - Down while already in zone C is the one exception: there's no zone
 *     below C to move to, so it's repurposed to enter "0" instead (same as
 *     Left/Enter/Right: enters, doesn't move).
 *
 * The security property this buys: only 3 states are ever highlighted
 * (zone A/B/C), and Left/Enter/Right all look identical from the outside --
 * someone watching over a shoulder sees a sequence of zone highlights, not
 * which of the 3 digits in each zone was actually picked.
 *
 * Self-contained keyboard handling (a plain `window` keydown listener, added
 * on mount / removed on unmount) rather than a zone inside
 * modules/cinema/dpad-nav.ts -- this component is only ever shown before any
 * profile is active, i.e. before CinemaIndex/CinemaRail even exist in the
 * DOM, so there's nothing for it to conflict with there. Revisit this if a
 * later stage needs it to compose with dpad-nav's zones (e.g. a PIN prompt
 * reappearing *inside* an already-active cinema session for some reason).
 */
import { ref, onMounted, onUnmounted } from 'vue';

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

type Zone = 'A' | 'B' | 'C';
const ZONE_ORDER: Zone[] = ['A', 'B', 'C'];
const ZONE_DIGITS: Record<Zone, [string, string, string]> = {
  A: ['1', '2', '3'],
  B: ['4', '5', '6'],
  C: ['7', '8', '9'],
};

const zone = ref<Zone>('A');
const digits = ref<string[]>([]);
const shaking = ref(false);

function moveZone(delta: number): void {
  const idx = ZONE_ORDER.indexOf(zone.value);
  const next = idx + delta;
  if (next < 0 || next >= ZONE_ORDER.length) return; // clamp, no wrap
  zone.value = ZONE_ORDER[next];
}

function commit(digit: string): void {
  if (digits.value.length >= props.length) return;
  digits.value = [...digits.value, digit];
  if (digits.value.length === props.length) {
    emit('complete', digits.value.join(''));
  }
}

function handleKeydown(e: KeyboardEvent): void {
  switch (e.key) {
    case 'ArrowUp':
      e.preventDefault();
      moveZone(-1);
      break;
    case 'ArrowDown':
      e.preventDefault();
      if (zone.value === 'C') commit('0');
      else moveZone(1);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      commit(ZONE_DIGITS[zone.value][0]);
      break;
    case 'Enter':
    case ' ':
      e.preventDefault();
      commit(ZONE_DIGITS[zone.value][1]);
      break;
    case 'ArrowRight':
      e.preventDefault();
      commit(ZONE_DIGITS[zone.value][2]);
      break;
    case 'Backspace':
      e.preventDefault();
      digits.value = digits.value.slice(0, -1);
      break;
    default:
      break;
  }
}

onMounted(() => window.addEventListener('keydown', handleKeydown));
onUnmounted(() => window.removeEventListener('keydown', handleKeydown));

/** Clears back to a fresh empty state (e.g. the parent decides to let the person retry after some other event). */
function reset(): void {
  zone.value = 'A';
  digits.value = [];
}

/** Wrong PIN was verified by the parent -- shake, then reset for a retry. */
function fail(): void {
  shaking.value = true;
  window.setTimeout(() => {
    shaking.value = false;
    reset();
  }, 420);
}

defineExpose({ reset, fail });
</script>

<template>
  <div class="pinpad" :class="{ 'pinpad--shake': shaking }">
    <p class="pinpad-title">{{ title }}</p>
    <p v-if="subtitle" class="pinpad-subtitle">{{ subtitle }}</p>

    <div class="pinpad-dots" role="status" :aria-label="`${digits.length} z ${length} cyfr wpisanych`">
      <span
        v-for="i in length" :key="i"
        class="pinpad-dot"
        :class="{ 'pinpad-dot--filled': i <= digits.length }"
      ></span>
    </div>

    <div class="pinpad-zones">
      <div
        v-for="z in ZONE_ORDER" :key="z"
        class="pinpad-zone"
        :class="{ 'pinpad-zone--active': zone === z }"
      >
        <span v-for="d in ZONE_DIGITS[z]" :key="d" class="pinpad-key">{{ d }}</span>
      </div>
      <div class="pinpad-zone pinpad-zone--zero" :class="{ 'pinpad-zone--active': zone === 'C' }">
        <span class="pinpad-key">0</span>
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
}
.pinpad-zone--active .pinpad-key { background: var(--surface-3); }
</style>
