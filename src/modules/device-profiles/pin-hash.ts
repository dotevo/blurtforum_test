/**
 * modules/device-profiles/pin-hash.ts
 *
 * Hashes a profile PIN with PBKDF2 (SHA-256, 100k iterations, random 16-byte
 * salt per profile) via window.crypto.subtle -- the standard Web Crypto
 * API, identical on web and inside the Capacitor WebView, so this needs no
 * native plugin. The PIN itself is never stored, logged, or compared in
 * plain form; only hash+salt (both hex strings) ever get persisted.
 *
 * This is a UI lock, not a key-encryption layer (unlike AuthService's
 * PIN-encrypted Blurt keys in useAuth.ts, a deliberately separate,
 * unrelated concern -- see types.ts's top comment). 100k iterations is
 * comfortably slow enough to make offline brute-forcing a 4-digit PIN
 * impractical while still resolving in well under 100ms on real hardware.
 */

const ITERATIONS = 100_000;
const HASH_ALG = 'SHA-256';
const SALT_BYTES = 16;

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function deriveHash(pin: string, salt: Uint8Array): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: ITERATIONS, hash: HASH_ALG },
    keyMaterial,
    256,
  );
  return toHex(bits);
}

/** Hashes a freshly-chosen PIN, generating a new random salt. */
export async function hashPin(pin: string): Promise<{ hash: string; salt: string }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveHash(pin, saltBytes);
  return { hash, salt: toHex(saltBytes.buffer) };
}

/** Re-derives the hash for an entered PIN against a stored salt and compares. */
export async function verifyPin(pin: string, hash: string, salt: string): Promise<boolean> {
  const candidate = await deriveHash(pin, fromHex(salt));
  // Not constant-time -- a timing side-channel on a locally-entered 4-digit
  // PIN gated by a 100k-iteration KDF (already ~50-100ms of noise per
  // attempt) isn't a meaningful attack surface here.
  return candidate === hash;
}
