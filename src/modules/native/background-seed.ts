import { Capacitor, registerPlugin } from '@capacitor/core';

export interface BackgroundSeedPlugin {
  start(options: { fileCount: number }): Promise<void>;
  updateCount(options: { fileCount: number }): Promise<void>;
  stop(): Promise<void>;
}

const NativeBackgroundSeed = registerPlugin<BackgroundSeedPlugin>('BackgroundSeed');

let running = false;

/**
 * Starts the foreground service that keeps the process alive (screen off)
 * so the existing JS webtorrent seeding keeps running. No-op on web.
 */
export async function startBackgroundSeeding(fileCount: number): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await NativeBackgroundSeed.start({ fileCount });
  running = true;
}

/** Updates the persistent notification's file count without restarting the service. */
export async function updateBackgroundSeedCount(fileCount: number): Promise<void> {
  if (!Capacitor.isNativePlatform() || !running) return;
  await NativeBackgroundSeed.updateCount({ fileCount });
}

export async function stopBackgroundSeeding(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await NativeBackgroundSeed.stop();
  running = false;
}

export function isBackgroundSeedingActive(): boolean {
  return running;
}
