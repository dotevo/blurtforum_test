import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * Bridge to android/.../SecureStoragePlugin.java (Android Keystore-backed
 * EncryptedSharedPreferences). On web this transparently falls back to
 * localStorage, so callers don't need to branch on platform.
 *
 * IMPORTANT: the web fallback is plain localStorage — NOT encrypted. It
 * exists so the same call sites work in both environments during
 * development; don't rely on it for actual security on web. Real
 * protection here only exists on native (isNative() === true).
 */
export interface SecureStoragePlugin {
  set(options: { key: string; value: string }): Promise<void>;
  get(options: { key: string }): Promise<{ value: string | null }>;
  remove(options: { key: string }): Promise<void>;
  clear(): Promise<void>;
}

const NativeSecureStorage = registerPlugin<SecureStoragePlugin>('SecureStorage');

export const isNative = (): boolean => Capacitor.isNativePlatform();

export const SecureStorage = {
  async set(key: string, value: string): Promise<void> {
    if (isNative()) {
      await NativeSecureStorage.set({ key, value });
      return;
    }
    localStorage.setItem(key, value);
  },

  async get(key: string): Promise<string | null> {
    if (isNative()) {
      const { value } = await NativeSecureStorage.get({ key });
      return value;
    }
    return localStorage.getItem(key);
  },

  async remove(key: string): Promise<void> {
    if (isNative()) {
      await NativeSecureStorage.remove({ key });
      return;
    }
    localStorage.removeItem(key);
  },

  async clear(): Promise<void> {
    if (isNative()) {
      await NativeSecureStorage.clear();
      return;
    }
    // Deliberately NOT clearing all of localStorage on web — that would
    // wipe unrelated app state, not just secure values. Native clear() only
    // touches its own encrypted file, so this asymmetry is intentional.
  },
};
