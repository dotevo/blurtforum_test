import { ref } from 'vue';

/**
 * modules/device-profiles/pinpad-state.ts
 *
 * Only one PIN pad is ever meaningfully on screen at a time (picker PIN,
 * new-profile PIN setup, admin PIN change -- all mutually exclusive UI
 * states), so a single module-level singleton is safe here, same
 * reasoning as the various wtAudioTrack/wtSubtitle singletons in
 * player.ts.
 *
 * Confirmed mechanic (see the throwaway index.html test harness this was
 * validated against first, and modules/cinema/dpad-nav.ts's own PIN_PAD
 * carve-out that drives this):
 *   - Up/Down move the highlighted ZONE (A/B/C) only -- never enters a digit.
 *   - Left / Enter / Right never move the highlight -- they always enter the
 *     1st/2nd/3rd digit of whichever zone is CURRENTLY highlighted.
 *   - Down while already in zone C is the one exception: there's no zone
 *     below C to move to, so it's repurposed to enter "0" instead (same as
 *     Left/Enter/Right: enters, doesn't move).
 */
export type PinZone = 'A' | 'B' | 'C';
const ZONE_ORDER: PinZone[] = ['A', 'B', 'C'];
const ZONE_DIGITS: Record<PinZone, [string, string, string]> = {
  A: ['1', '2', '3'],
  B: ['4', '5', '6'],
  C: ['7', '8', '9'],
};

export const pinZone = ref<PinZone>('A');
export const pinDigits = ref<string[]>([]);
export const pinLength = ref(4);
export const pinShaking = ref(false);

let onCompleteCallback: ((pin: string) => void) | null = null;

export function getPinZoneDigits(zone: PinZone): readonly [string, string, string] {
  return ZONE_DIGITS[zone];
}

/** Called by PinPad.vue's onMounted. Resets to a fresh empty state every
 *  time a pin pad actually mounts (including remounting via a changed
 *  :key for a new step, e.g. "enter" -> "confirm") -- see PinPad.vue. */
export function registerPinPad(length: number, onComplete: (pin: string) => void): void {
  pinLength.value = length;
  onCompleteCallback = onComplete;
  pinZone.value = 'A';
  pinDigits.value = [];
  pinShaking.value = false;
}

export function unregisterPinPad(): void {
  onCompleteCallback = null;
}

export function pinMoveZone(delta: number): void {
  const idx = ZONE_ORDER.indexOf(pinZone.value);
  const next = idx + delta;
  if (next < 0 || next >= ZONE_ORDER.length) return; // clamp, no wrap
  pinZone.value = ZONE_ORDER[next];
}

export function pinCommit(digit: string): void {
  if (pinDigits.value.length >= pinLength.value) return;
  pinDigits.value = [...pinDigits.value, digit];
  if (pinDigits.value.length === pinLength.value) {
    onCompleteCallback?.(pinDigits.value.join(''));
  }
}

/** Down while already in zone C: no zone below it, so this enters "0" instead of moving. */
export function pinDownInZoneC(): void {
  if (pinZone.value === 'C') pinCommit('0');
  else pinMoveZone(1);
}

/** Clears back to a fresh empty state without necessarily remounting (used for "wrong PIN, retry the same step" -- see PinPad.vue's fail()). */
export function pinReset(): void {
  pinZone.value = 'A';
  pinDigits.value = [];
}

export function pinFail(onDone?: () => void): void {
  pinShaking.value = true;
  window.setTimeout(() => {
    pinShaking.value = false;
    pinReset();
    onDone?.();
  }, 420);
}
