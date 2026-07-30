import { ref, computed, watch } from 'vue';
import { loadDeviceProfiles, saveDeviceProfiles } from '../native/device-profile-store';
import { hashPin, verifyPin as verifyPinHash } from './pin-hash';
import { setPlaylistNamespace } from '../player/player';
import type { DeviceProfile, DeviceProfilesFile, NewDeviceProfileInput } from './types';

/**
 * modules/device-profiles/device-profiles.ts
 *
 * See types.ts's top comment for what a "device profile" is and isn't.
 * Two things worth restating here because they shape every function below:
 *
 * 1. A profile only ever references Blurt accounts by username
 *    (linkedUsernames) -- it never stores or touches key material. Actual
 *    login stays entirely in useAuth.ts's auth.accounts, completely
 *    unmodified by anything in this file.
 *
 * 2. Switching/exiting a profile (selectProfile/exitProfile) must NEVER
 *    touch WebTorrent or player.ts state. Seeding/playback started under
 *    one profile's account has to keep running when a different profile
 *    becomes active -- that's a firm product requirement, not an
 *    oversight, so don't "helpfully" add a stopAll() call here later.
 */

const profiles = ref<DeviceProfile[]>([]);
const activeProfileId = ref<string | null>(null);
const loaded = ref(false);

export const activeProfile = computed<DeviceProfile | null>(() =>
  profiles.value.find(p => p.id === activeProfileId.value) ?? null,
);

// Each device profile gets its own playlists rather than sharing one global
// list -- see setPlaylistNamespace's own comment in player.ts. This never
// fires off-TV (activeProfileId never leaves null there), so playlists keep
// behaving exactly as before everywhere except behind the TV gate.
watch(activeProfileId, (id) => {
  setPlaylistNamespace(id);
});

function persist(): void {
  const file: DeviceProfilesFile = {
    version: 1,
    profiles: profiles.value,
    activeProfileId: activeProfileId.value,
  };
  saveDeviceProfiles(JSON.stringify(file));
}

function genId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Call once on app start (before rendering the TV gate). Safe to call more than once -- a no-op after the first successful (or failed) load. */
export async function loadProfiles(): Promise<void> {
  if (loaded.value) return;
  try {
    const raw = await loadDeviceProfiles();
    if (raw) {
      const file = JSON.parse(raw) as DeviceProfilesFile;
      profiles.value = file.profiles ?? [];
    }
  } catch (e) {
    console.error('device-profiles: failed to load stored profiles, starting fresh', e);
    profiles.value = [];
  }
  // Deliberately NOT restoring the previously-active profile across app
  // restarts, even though it's part of the persisted file -- every fresh
  // launch of the TV app should show the picker again ("who's watching?"),
  // same as Netflix/Disney+. This also means a kid profile can never end up
  // active just because it happened to be the last one used before the TV
  // was turned off.
  activeProfileId.value = null;
  loaded.value = true;
}

export function createProfile(input: NewDeviceProfileInput): DeviceProfile {
  const profile: DeviceProfile = {
    id: genId(),
    name: input.name,
    avatarColor: input.avatarColor,
    isAdmin: profiles.value.length === 0, // the very first profile ever created on this device is always the admin -- no separate "admin account" concept to bootstrap
    pinHash: null,
    pinSalt: null,
    maxRating: input.maxRating ?? null,
    showVotes: input.showVotes ?? true,
    showComments: input.showComments ?? true,
    dailyLimitMinutes: input.dailyLimitMinutes ?? null,
    linkedUsernames: input.linkedUsernames ?? [],
    createdAt: Date.now(),
  };
  profiles.value = [...profiles.value, profile];
  persist();
  return profile;
}

/** PIN fields are excluded here on purpose -- go through setPin/clearPin, which handle hashing. */
export function updateProfile(id: string, patch: Partial<Omit<DeviceProfile, 'id' | 'createdAt' | 'pinHash' | 'pinSalt'>>): void {
  if (!profiles.value.some(p => p.id === id)) return;
  profiles.value = profiles.value.map(p => (p.id === id ? { ...p, ...patch } : p));
  persist();
}

export function deleteProfile(id: string): { ok: boolean; reason?: 'not-found' | 'last-admin' } {
  const target = profiles.value.find(p => p.id === id);
  if (!target) return { ok: false, reason: 'not-found' };
  if (target.isAdmin && profiles.value.filter(p => p.isAdmin).length <= 1) {
    // Deleting the last admin would permanently lock this device out of
    // "manage profiles" (and out of WebTorrent storage/network settings --
    // see the admin-only gating planned for a later stage).
    return { ok: false, reason: 'last-admin' };
  }
  profiles.value = profiles.value.filter(p => p.id !== id);
  if (activeProfileId.value === id) activeProfileId.value = null;
  persist();
  return { ok: true };
}

function setPinFields(id: string, pinHash: string | null, pinSalt: string | null): void {
  profiles.value = profiles.value.map(p => (p.id === id ? { ...p, pinHash, pinSalt } : p));
  persist();
}

export async function setPin(id: string, pin: string): Promise<void> {
  const { hash, salt } = await hashPin(pin);
  setPinFields(id, hash, salt);
}

export function clearPin(id: string): void {
  setPinFields(id, null, null);
}

export async function verifyProfilePin(id: string, pin: string): Promise<boolean> {
  const profile = profiles.value.find(p => p.id === id);
  if (!profile?.pinHash || !profile.pinSalt) return false;
  return verifyPinHash(pin, profile.pinHash, profile.pinSalt);
}

/** Makes `id` the active profile. Caller is responsible for verifying the
 *  PIN first via verifyProfilePin() if the profile has one -- this is only
 *  the "now enter as this profile" step, it doesn't gate anything itself. */
export function selectProfile(id: string): void {
  if (!profiles.value.some(p => p.id === id)) return;
  activeProfileId.value = id;
}

/** Back to the picker. See the file's top comment: never touches WebTorrent/player state. */
export function exitProfile(): void {
  activeProfileId.value = null;
}

export function linkAccount(profileId: string, username: string): void {
  const p = profiles.value.find(pr => pr.id === profileId);
  if (!p || p.linkedUsernames.includes(username)) return;
  updateProfile(profileId, { linkedUsernames: [...p.linkedUsernames, username] });
}

export function unlinkAccount(profileId: string, username: string): void {
  const p = profiles.value.find(pr => pr.id === profileId);
  if (!p) return;
  updateProfile(profileId, { linkedUsernames: p.linkedUsernames.filter(u => u !== username) });
}

export { profiles, activeProfileId };
