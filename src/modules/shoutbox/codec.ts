/**
 * modules/shoutbox/codec.ts
 *
 * Tiny base64 <-> ArrayBuffer helpers, shared by session.ts (exporting
 * session public keys to put in a certificate) and identity.ts (encoding
 * ECDSA signatures for the wire). Deliberately not using crypto-js for
 * this — it's plain binary-to-text encoding, not cryptography, and the
 * Web Crypto API already hands us ArrayBuffers.
 */

export function b64FromBuffer(buf: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function bufferFromB64(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
