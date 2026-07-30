import { ref } from 'vue';
import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * modules/native/platform-info.ts
 *
 * Bridges android/.../PlatformInfoPlugin.java. Right now this only answers
 * one question -- "is this actually running on an Android TV device" --
 * used exclusively to gate the device-profiles feature (see
 * modules/device-profiles/). Deliberately NOT derived from cinemaMode
 * (useApp.ts): cinemaMode is a user-toggleable *setting* anyone can flip on
 * from a normal browser/phone, and none of them should ever see a TV-only
 * profile picker.
 */
interface PlatformInfoPlugin {
  isTV(): Promise<{ isTV: boolean }>;
}

const NativePlatformInfo = registerPlugin<PlatformInfoPlugin>('PlatformInfo');

/** Reactive; starts false and updates in place once the real check (or the
 *  dev override below) resolves. Read this, don't call detectTV() again --
 *  it only ever needs to run once per page load. */
export const isTVPlatform = ref<boolean>(import.meta.env.VITE_FORCE_TV === 'true');

async function detectTV(): Promise<void> {
  // Vite substitutes VITE_FORCE_TV at build time (see .env.tv / `npm run
  // dev:tv`) -- a normal dev/build run never defines it, so this branch is
  // statically dead code (and thus never reachable) outside that one dev
  // mode. Already reflected in the ref's initial value above; nothing left
  // to detect.
  if (import.meta.env.VITE_FORCE_TV === 'true') return;

  if (!Capacitor.isNativePlatform()) {
    isTVPlatform.value = false;
    return;
  }
  try {
    const { isTV } = await NativePlatformInfo.isTV();
    isTVPlatform.value = isTV;
  } catch (e) {
    console.error('platform-info: isTV() check failed, defaulting to false (not TV)', e);
    isTVPlatform.value = false;
  }
}

void detectTV();
