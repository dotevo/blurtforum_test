import { Capacitor } from '@capacitor/core';
import { Network } from '@capacitor/network';

export type ConnectionType = 'wifi' | 'cellular' | 'none' | 'unknown';

/**
 * Native (@capacitor/network) gives a reliable connection type. On web we
 * only get a best-effort guess from the non-standard Network Information
 * API (Chrome/Android only, absent on Safari/Firefox) — when unavailable
 * we return 'unknown' rather than guessing wifi, so callers should treat
 * 'unknown' as "don't restrict, we can't tell".
 */
export async function getConnectionType(): Promise<ConnectionType> {
  if (Capacitor.isNativePlatform()) {
    const status = await Network.getStatus();
    if (!status.connected) return 'none';
    return status.connectionType === 'wifi' ? 'wifi'
      : status.connectionType === 'cellular' ? 'cellular'
      : 'unknown';
  }
  const nav = navigator as Navigator & { connection?: { type?: string; effectiveType?: string } };
  const conn = nav.connection;
  if (!conn) return 'unknown';
  if (conn.type === 'wifi' || conn.type === 'ethernet') return 'wifi';
  if (conn.type === 'cellular') return 'cellular';
  return 'unknown';
}

/**
 * Subscribes to connection-type changes. Returns an unsubscribe function.
 * No-op (never fires) on web without the Network Information API.
 */
export function onConnectionChange(cb: (type: ConnectionType) => void): () => void {
  if (Capacitor.isNativePlatform()) {
    let handle: { remove: () => void } | null = null;
    Network.addListener('networkStatusChange', status => {
      const type: ConnectionType = !status.connected ? 'none'
        : status.connectionType === 'wifi' ? 'wifi'
        : status.connectionType === 'cellular' ? 'cellular'
        : 'unknown';
      cb(type);
    }).then(h => { handle = h; });
    return () => { handle?.remove(); };
  }
  const nav = navigator as Navigator & { connection?: EventTarget & { type?: string } };
  const conn = nav.connection;
  if (!conn) return () => {};
  const listener = () => { getConnectionType().then(cb); };
  conn.addEventListener('change', listener);
  return () => conn.removeEventListener('change', listener);
}
