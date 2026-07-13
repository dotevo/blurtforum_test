import { SecureStorage, isNative } from './secure-storage';

/**
 * Where the "remember me" session blob(s) live. Same JSON shape as before
 * on web (still localStorage, still PIN-encrypted key inside — see
 * useAuth.ts). On native, backed by SecureStorage (Android Keystore) and
 * the key inside is stored RAW — no PIN layer, since the OS sandbox +
 * Keystore already provide the protection PIN was standing in for.
 *
 * Fire-and-forget on write (native storage is async, but every existing
 * call site in useAuth.ts/useApp.ts calls this synchronously) — errors are
 * logged, not thrown, so a storage hiccup can't crash the login flow.
 */
const ACTIVE_KEY = 'blurtforum_session';
const ALL_KEY = 'blurtforum_sessions';

export { isNative };

export async function loadSessions(): Promise<string | null> {
  if (isNative()) return SecureStorage.get(ALL_KEY);
  return localStorage.getItem(ALL_KEY);
}

export async function loadActiveSession(): Promise<string | null> {
  if (isNative()) return SecureStorage.get(ACTIVE_KEY);
  return localStorage.getItem(ACTIVE_KEY);
}

export function saveSessions(json: string | null): void {
  if (isNative()) {
    const p = json == null ? SecureStorage.remove(ALL_KEY) : SecureStorage.set(ALL_KEY, json);
    p.catch(e => console.error('saveSessions (native) failed', e));
    return;
  }
  if (json == null) localStorage.removeItem(ALL_KEY);
  else localStorage.setItem(ALL_KEY, json);
}

export function saveActiveSession(json: string | null): void {
  if (isNative()) {
    const p = json == null ? SecureStorage.remove(ACTIVE_KEY) : SecureStorage.set(ACTIVE_KEY, json);
    p.catch(e => console.error('saveActiveSession (native) failed', e));
    return;
  }
  if (json == null) localStorage.removeItem(ACTIVE_KEY);
  else localStorage.setItem(ACTIVE_KEY, json);
}
