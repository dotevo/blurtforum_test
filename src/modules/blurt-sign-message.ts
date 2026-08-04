import CryptoJS from 'crypto-js/core';
import 'crypto-js/sha256';
import 'crypto-js/enc-hex';
import * as dblurt from '@beblurt/dblurt';
import type { AuthUser } from '../types';

/**
 * src/modules/blurt-sign-message.ts
 *
 * Signs an arbitrary short message with the current user's posting key —
 * for background, non-interactive use (currently: the webtorrent peer
 * handshake in modules/player_blurt/blurt-peer-handshake.ts). Injected into
 * BlurtPlayerPlugin(client, auth, signBlurtMessage) in useApp.ts, so the
 * player plugin itself never has to know any of this.
 *
 * Crypto approach lifted directly from useImageUpload.ts's proven
 * uploadImageFile() (SHA-256 via crypto-js, dblurt.PrivateKey.sign() for
 * local keys, window.blurt_keychain.requestSignBuffer() for WhaleVault) —
 * not guessed, this is the same working pattern already shipping for image
 * uploads.
 *
 * DELIBERATE POLICY DIFFERENCE FROM uploadImageFile(): this function NEVER
 * triggers an interactive prompt of any kind — no PIN modal (no checkLock
 * call), no WhaleVault confirmation popup. It resolves `null` instead
 * whenever signing would require one. A signing request that silently pops
 * up out of nowhere because a new BitTorrent peer connected is exactly the
 * kind of surprise interruption this plugin needs to avoid (this was
 * flagged during review — the peer handshake gracefully falls back to an
 * "unverified" badge instead of forcing this). If you want to let a
 * WhaleVault user *opt in* to verified peer badges later, that would need
 * to be a deliberate, user-initiated action (e.g. a settings toggle) that
 * calls a *different*, interactive version of this — not this one.
 *
 * - `type === 'key'`, unlocked: signs locally, no UI at all. Safe to call
 *   as often as needed.
 * - `type === 'key'`, locked (PIN not yet entered this session): resolves
 *   `null` rather than showing the PIN modal.
 * - `type === 'whalevault'`: resolves `null` rather than calling
 *   window.blurt_keychain.requestSignBuffer() (which shows its own
 *   confirmation UI, entirely outside our control).
 */
const LOG = '[signBlurtMessage]';

export async function signBlurtMessage(auth: { user: AuthUser | null }, message: string): Promise<string | null> {
  const user = auth.user;
  if (!user) { console.log(LOG, 'skipping — not logged in'); return null; }
  if (user.type !== 'key') { console.log(LOG, 'skipping —', user.username, 'is type', user.type, '(only local keys sign automatically, by policy — see file header comment)'); return null; }
  if (user.locked) { console.log(LOG, 'skipping —', user.username, "'s local key is PIN-locked (won't prompt automatically)"); return null; }
  if (!user.key) { console.log(LOG, 'skipping —', user.username, 'has type "key" but no key material in memory (unexpected — locked flag should have caught this)'); return null; }

  try {
    const bytes = new TextEncoder().encode(message);
    const wordArray = CryptoJS.lib.WordArray.create(bytes as unknown as number[]);
    const hashHex = CryptoJS.SHA256(wordArray).toString(CryptoJS.enc.Hex);
    const hashBytes = new Uint8Array(hashHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    const privKey = dblurt.PrivateKey.from(user.key);
    const sig = privKey.sign(hashBytes as any);
    const sigHex = sig.toString();
    console.log(LOG, 'signed OK for', user.username);
    return sigHex;
  } catch (e) {
    console.warn(LOG, 'local signing threw for', user.username, ':', e);
    return null;
  }
}