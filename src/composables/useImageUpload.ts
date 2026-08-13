import { ref, reactive } from 'vue';
import CryptoJS from 'crypto-js/core';
import 'crypto-js/lib-typedarrays';
import 'crypto-js/sha256';
import 'crypto-js/enc-hex';
import * as dblurt from '@beblurt/dblurt';
import type { AuthUser } from '../types';

/**
 * Handles uploading images to the Blurt image host and inserting the
 * resulting markdown at the cursor position (or appending via a callback
 * for cases like reply bodies / edit modal that aren't backed by a
 * currently-focused textarea).
 */
export function useImageUpload(
  auth: { user: AuthUser | null },
  checkLock: (fn: () => any) => boolean
) {
  const imgUploads = reactive({ post: false, reply: false });
  const lastTextarea = ref<HTMLTextAreaElement | null>(null);

  const uploadImageFile = async (file: File): Promise<string> => {
    if (!auth.user) throw new Error('Not logged in');
    const arrayBuf = await file.arrayBuffer();
    const fileBytes = new Uint8Array(arrayBuf);
    const prefix = new TextEncoder().encode('ImageSigningChallenge');
    const combined = new Uint8Array(prefix.length + fileBytes.length);
    combined.set(prefix, 0); combined.set(fileBytes, prefix.length);
    const wordArray = CryptoJS.lib.WordArray.create(combined as unknown as number[]);
    const hashHex = CryptoJS.SHA256(wordArray).toString(CryptoJS.enc.Hex);
    const hashBytes = new Uint8Array(hashHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    let sigHex: string;
    if (auth.user.type === 'key') {
      const privKey = dblurt.PrivateKey.from(auth.user.key!);
      const sig = privKey.sign(hashBytes as any);
      sigHex = sig.toString();
    } else {
      sigHex = await new Promise((resolve, reject) => {
        if (!window.blurt_keychain) { reject(new Error('WhaleVault not available')); return; }
        const bufferObject = { type: 'Buffer', data: Array.from(combined) };
        (window.blurt_keychain as Record<string, Function>).requestSignBuffer(auth.user!.username, JSON.stringify(bufferObject), 'posting', (res: { success: boolean; result?: string; message?: string }) => {
          if (res?.success) {
            let result = res.result ?? '';
            result = result.split(':')[0];
            if (result.startsWith('SIG_K1_')) { try { result = dblurt.Signature.fromString(result).toString(); } catch { /* ignore */ } }
            resolve(result);
          } else reject(new Error(res?.message ?? 'WV sign error'));
        });
      });
    }
    const url = `https://img-upload.blurt.blog/${auth.user.username}/${sigHex}`;
    const formData = new FormData(); formData.append('file', file);
    const resp = await fetch(url, { method: 'POST', body: formData });
    if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
    const data = await resp.json() as { url?: string };
    if (!data.url) throw new Error('No URL in response: ' + JSON.stringify(data));
    return data.url;
  };

  /**
   * Inserts image markdown at the cursor in the last focused textarea, if any,
   * otherwise falls back to the caller-provided appender for the given target.
   */
  const insertImageIntoBody = (target: string, imgUrl: string, appendFallback: (target: string, md: string) => void): void => {
    const md = `\n![image](${imgUrl})\n`;

    if (lastTextarea.value && document.contains(lastTextarea.value)) {
      const el = lastTextarea.value;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const val = el.value;
      el.value = val.substring(0, start) + md + val.substring(end);
      el.selectionStart = el.selectionEnd = start + md.length;
      el.dispatchEvent(new Event('input'));
      el.focus();
      return;
    }

    appendFallback(target, md);
  };

  const handleImageUpload = async (
    file: File,
    target: string,
    appendFallback: (target: string, md: string) => void,
    onError: (target: string, message: string) => void
  ): Promise<void> => {
    if (checkLock(() => handleImageUpload(file, target, appendFallback, onError))) return;
    if (!file || !file.type.startsWith('image/')) return;
    try {
      insertImageIntoBody(target, await uploadImageFile(file), appendFallback);
    } catch (err) {
      console.error('Image upload error:', err);
      onError(target, 'Image upload failed: ' + (err as Error).message);
    }
  };

  const onImagePick = async (
    target: string,
    e: Event,
    appendFallback: (target: string, md: string) => void,
    onError: (target: string, message: string) => void
  ) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = '';
    if (!f) return;
    (imgUploads as any)[target] = true;
    try { await handleImageUpload(f, target, appendFallback, onError); }
    finally { (imgUploads as any)[target] = false; }
  };

  const onPaste = async (
    target: string,
    e: ClipboardEvent,
    appendFallback: (target: string, md: string) => void,
    onError: (target: string, message: string) => void
  ) => {
    if (e.target instanceof HTMLTextAreaElement) lastTextarea.value = e.target;
    for (const item of Array.from(e.clipboardData?.items ?? [])) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const f = item.getAsFile()!;
        (imgUploads as any)[target] = true;
        try { await handleImageUpload(f, target, appendFallback, onError); }
        finally { (imgUploads as any)[target] = false; }
        break;
      }
    }
  };

  return {
    imgUploads,
    lastTextarea,
    onImagePick,
    onPaste,
  };
}
