import { SecureStorage, isNative } from './secure-storage';

/**
 * modules/native/device-profile-store.ts
 *
 * Where the device-profiles blob (see modules/device-profiles/) lives.
 * Deliberately mirrors session-store.ts's exact shape (same async-read/
 * fire-and-forget-write pattern, same native-vs-web split) rather than
 * reusing it directly -- this is a conceptually separate blob (device
 * profiles, not Blurt login sessions) that happens to want the same
 * storage treatment, not a variant of the same data.
 *
 * On native this is Android-Keystore-backed (see SecureStoragePlugin.java);
 * on web it's plain localStorage. This only ever holds PIN *hashes* (never
 * the PIN itself) and which already-logged-in usernames a profile may use
 * -- not key material -- so the web fallback being unencrypted is a much
 * smaller concern here than it would be for session-store.ts's actual
 * Blurt keys.
 */
const KEY = 'blurtforum_device_profiles';

export async function loadDeviceProfiles(): Promise<string | null> {
  if (isNative()) return SecureStorage.get(KEY);
  return localStorage.getItem(KEY);
}

export function saveDeviceProfiles(json: string | null): void {
  if (isNative()) {
    const p = json == null ? SecureStorage.remove(KEY) : SecureStorage.set(KEY, json);
    p.catch(e => console.error('saveDeviceProfiles (native) failed', e));
    return;
  }
  if (json == null) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, json);
}
