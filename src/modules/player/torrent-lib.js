/**
 * torrent-lib.js
 * ════════════════════════════════════════════════════════════════
 * Standalone library (ES module) wrapping WebTorrent that:
 * • maintains torrent list + state (progress/speed/peers/files)
 * • saves data in IndexedDB (per-torrent) with a CONFIGURABLE space
 * limit (quota) and auto-clearing of oldest inactive torrents
 * • saves all-time stats (downloaded/uploaded) in localStorage
 * • handles "live" video/audio playback with a smart, position-aware
 * download window (avoids downloading the entire file unnecessarily)
 * ════════════════════════════════════════════════════════════════
 */

import WebTorrent from 'https://cdn.jsdelivr.net/npm/webtorrent@3.0.16/dist/webtorrent.min.js';

// WebTorrent 3.x in the browser sometimes assumes Buffer.prototype.copy exists
// on standard Uint8Arrays. We polyfill it here.
if (typeof Uint8Array.prototype.copy === 'undefined') {
  Uint8Array.prototype.copy = function (target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
    const start = sourceStart;
    const end = Math.min(sourceEnd, this.length);
    const len = Math.min(end - start, target.length - targetStart);
    target.set(this.subarray(start, start + len), targetStart);
    return len;
  };
}

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.ogv', '.ts', '.m2ts']);
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.wav', '.flac', '.aac', '.m4a', '.opus']);
// All TEXT subtitle formats for which the player can build a VTT converter.
// Bitmap formats (VobSub .idx/.sub, PGS/.sup) are excluded.
const SUB_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa', '.sub', '.sbv', '.smi', '.sami']);

// Containers that the browser can natively play in a standard <video> element.
// MKV/AVI will NEVER play natively — this is a browser limitation, not the library's.
export const NATIVE_PLAYABLE_EXT = new Set(['.mp4', '.m4v', '.webm', '.ogv', '.mov']);

export function ext(name) {
  const p = name.toLowerCase().lastIndexOf('.');
  return p < 0 ? '' : name.toLowerCase().slice(p);
}
export function isVideo(n) { return VIDEO_EXT.has(ext(n)); }
export function isAudio(n) { return AUDIO_EXT.has(ext(n)); }
export function isSub(n) { return SUB_EXT.has(ext(n)); }
export function isNativePlayable(n) { return NATIVE_PLAYABLE_EXT.has(ext(n)); }

// ═════════════════════════════════════════════════════════════════
// SUBTITLE CONVERSION — SRT/SBV/SAMI/ASS/SUB → WebVTT + language guess.
// This is exactly the kind of "annoying to get right" logic a consumer
// shouldn't have to reimplement; see TorrentLibrary#getSubtitleTrack.
// ═════════════════════════════════════════════════════════════════
export function detectSubtitleLang(filename) {
  const f = filename.toLowerCase();
  if (f.includes('.pl.') || f.includes('_pl') || f.includes('polish') || f.includes('polski')) return 'pl';
  if (f.includes('.en.') || f.includes('_en') || f.includes('english')) return 'en';
  if (f.includes('.de.') || f.includes('german')) return 'de';
  if (f.includes('.fr.') || f.includes('french')) return 'fr';
  if (f.includes('.es.') || f.includes('spanish')) return 'es';
  return 'und';
}
function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2').trim();
}
function sbvToVtt(sbv) {
  const blocks = sbv.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split(/\n\s*\n/);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  let vtt = 'WEBVTT\n\n';
  for (const block of blocks) {
    const lines = block.split('\n');
    const m = /^(\d+):(\d{2}):(\d{2})\.(\d{3}),(\d+):(\d{2}):(\d{2})\.(\d{3})/.exec(lines[0] || '');
    if (!m) continue;
    const start = `${pad(m[1])}:${pad(m[2])}:${pad(m[3])}.${pad(m[4], 3)}`;
    const end = `${pad(m[5])}:${pad(m[6])}:${pad(m[7])}.${pad(m[8], 3)}`;
    const text = lines.slice(1).join('\n').trim();
    if (!text) continue;
    vtt += `${start} --> ${end}\n${text}\n\n`;
  }
  return vtt;
}
function samiToVtt(sami) {
  const items = [];
  const syncRe = /<SYNC\s+Start\s*=\s*(\d+)[^>]*>(?:\s*<P[^>]*>)?([\s\S]*?)(?=<SYNC|<\/BODY>|$)/gi;
  let m;
  while ((m = syncRe.exec(sami))) {
    const text = m[2]
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .trim();
    items.push({ startMs: parseInt(m[1], 10), text });
  }
  const msToVtt = ms => {
    const h = Math.floor(ms / 3600000), mi = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000), rest = Math.floor(ms % 1000);
    return `${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(rest).padStart(3,'0')}`;
  };
  let vtt = 'WEBVTT\n\n';
  for (let i = 0; i < items.length; i++) {
    if (!items[i].text) continue;
    const end = items[i + 1] ? items[i + 1].startMs : items[i].startMs + 4000;
    vtt += `${msToVtt(items[i].startMs)} --> ${msToVtt(end)}\n${items[i].text}\n\n`;
  }
  return vtt;
}
function assToVtt(ass) {
  const lines = ass.split('\n');
  let vtt = 'WEBVTT\n\n', n = 1, inEv = false, fmt = [];
  for (const line of lines) {
    if (line.trim() === '[Events]') { inEv = true; continue; }
    if (inEv && line.startsWith('[')) { inEv = false; continue; }
    if (inEv && line.startsWith('Format:')) { fmt = line.replace('Format:', '').split(',').map(x => x.trim()); continue; }
    if (inEv && line.startsWith('Dialogue:')) {
      const parts = line.replace('Dialogue:', '').split(',');
      if (parts.length < 10) continue;
      const gf = name => { const i = fmt.indexOf(name); return i >= 0 ? parts[i] : undefined; };
      const start = (gf('Start') || parts[1] || '').trim();
      const end = (gf('End') || parts[2] || '').trim();
      const text = parts.slice(fmt.indexOf('Text') >= 0 ? fmt.indexOf('Text') : 9).join(',').trim().replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n').replace(/\\n/g, '\n');
      if (!text) continue;
      const toVtt = t => t.replace(/(\d+):(\d{2}):(\d{2})\.(\d{2})/, (_, h, m, sec, cs) => `${h.padStart(2,'0')}:${m}:${sec}.${(+cs*10).toString().padStart(3,'0')}`);
      vtt += `${n++}\n${toVtt(start)} --> ${toVtt(end)}\n${text}\n\n`;
    }
  }
  return vtt;
}
function decodeSubtitleBytes(buf) {
  try { return new TextDecoder('utf-8').decode(buf); }
  catch (e) {
    try { return new TextDecoder('windows-1250').decode(buf); }
    catch (e2) { return new TextDecoder('latin-1').decode(buf); }
  }
}
function convertSubtitleToVtt(name, text) {
  const e = ext(name);
  if (e === '.srt' || e === '.sub') return srtToVtt(text);
  if (e === '.vtt') return text;
  if (e === '.ass' || e === '.ssa') return assToVtt(text);
  if (e === '.sbv') return sbvToVtt(text);
  if (e === '.smi' || e === '.sami') return samiToVtt(text);
  return text;
}

function peerIdToString(peerId) {
  if (!peerId) return null;
  if (typeof peerId === 'string') return peerId;
  try {
    let s = '';
    for (let i = 0; i < peerId.length; i++) s += String.fromCharCode(peerId[i]);
    return s;
  } catch (e) { return null; }
}

// ═════════════════════════════════════════════════════════════════
// Tiny, dependency-free event emitter
// ═════════════════════════════════════════════════════════════════
class Emitter {
  constructor() { this._l = new Map(); }
  on(evt, fn) {
    if (!this._l.has(evt)) this._l.set(evt, new Set());
    this._l.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) { this._l.get(evt)?.delete(fn); }
  emit(evt, ...args) {
    this._l.get(evt)?.forEach(fn => {
      try { fn(...args); } catch (e) { console.error(`[TorrentLibrary] listener error for "${evt}":`, e); }
    });
  }
}

// ═════════════════════════════════════════════════════════════════
// STORAGE HELPERS (localStorage)
// ═════════════════════════════════════════════════════════════════
class PersistentState {
  constructor(prefix) {
    this.LS_LIST = `${prefix}-list`;
    this.LS_STATS = `${prefix}-stats-`;
    this.LS_META = `${prefix}-meta-`;
  }
  _get(key, def) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; }
    catch (e) { console.error('[Storage] parse error:', e); return def; }
  }
  _set(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

  getList() { return this._get(this.LS_LIST, []); }
  saveList(list) { this._set(this.LS_LIST, list); }
  upsert(info) {
    const list = this.getList();
    const idx = list.findIndex(x => x.infoHash === info.infoHash);
    if (idx >= 0) Object.assign(list[idx], info); else list.push(info);
    this.saveList(list);
    return list;
  }
  removeFromList(hash) {
    this.saveList(this.getList().filter(x => x.infoHash !== hash));
    localStorage.removeItem(this.LS_STATS + hash);
    localStorage.removeItem(this.LS_META + hash);
  }

  getStats(hash) { return this._get(this.LS_STATS + hash, { downloaded: 0, uploaded: 0, lastSeen: 0 }); }
  saveStats(hash, t) {
    const prev = this.getStats(hash);
    const next = {
      downloaded: Math.max(prev.downloaded, t.downloaded || 0),
      uploaded: Math.max(prev.uploaded, t.uploaded || 0),
      lastSeen: Date.now(),
    };
    this._set(this.LS_STATS + hash, next);
    return next;
  }

  getGlobalStats() {
    const list = this.getList();
    let downloaded = 0, uploaded = 0;
    for (const info of list) {
      const s = this.getStats(info.infoHash);
      downloaded += s.downloaded;
      uploaded += s.uploaded;
    }
    return { downloaded, uploaded, torrents: list.length };
  }

  static bufToB64(buf) {
    let binary = '';
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(binary);
  }
  static b64ToBuf(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  cacheTorrentMeta(t) {
    try {
      if (t?.torrentFile) {
        localStorage.setItem(this.LS_META + t.infoHash, PersistentState.bufToB64(t.torrentFile));
      }
    } catch (e) { console.warn('[Storage] failed to save .torrent metadata:', e); }
  }
  getCachedTorrentMeta(hash) {
    const b64 = localStorage.getItem(this.LS_META + hash);
    if (!b64) return null;
    try { return PersistentState.b64ToBuf(b64); }
    catch (e) { console.warn('[Storage] corrupted metadata cache for', hash, e); return null; }
  }
}

// ═════════════════════════════════════════════════════════════════
// QUOTA MANAGER
// ═════════════════════════════════════════════════════════════════
class QuotaManager {
  constructor(dbPrefix, quotaBytes) {
    this.dbName = `${dbPrefix}-manifest`;
    this.quotaBytes = quotaBytes;
    this.db = null;
    this._ready = this._open();
  }

  _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('usage')) db.createObjectStore('usage', { keyPath: 'infoHash' });
      };
      req.onsuccess = e => { this.db = e.target.result; resolve(this.db); };
      req.onerror = () => reject(req.error);
    });
  }

  setQuota(bytes) { this.quotaBytes = bytes; }

  async _tx(mode) {
    const db = await this._ready;
    return db.transaction('usage', mode).objectStore('usage');
  }

  async touch(infoHash, name) {
    const store = await this._tx('readwrite');
    const cur = await new Promise(res => { const r = store.get(infoHash); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
    const rec = cur || { infoHash, bytes: 0, name };
    rec.name = name || rec.name;
    rec.lastAccess = Date.now();
    store.put(rec);
  }

  async addBytes(infoHash, delta, name) {
    const store = await this._tx('readwrite');
    const cur = await new Promise(res => { const r = store.get(infoHash); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
    const rec = cur || { infoHash, bytes: 0, name };
    rec.bytes = Math.max(0, (rec.bytes || 0) + delta);
    rec.name = name || rec.name;
    rec.lastAccess = Date.now();
    store.put(rec);
    return rec.bytes;
  }

  async remove(infoHash) {
    const store = await this._tx('readwrite');
    store.delete(infoHash);
  }

  async getUsage() {
    const store = await this._tx('readonly');
    const all = await new Promise(res => { const r = store.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); });
    const total = all.reduce((a, r) => a + (r.bytes || 0), 0);
    return { total, quota: this.quotaBytes, records: all.sort((a, b) => a.lastAccess - b.lastAccess) };
  }

  async enforce(dbPrefix, activeHashes = []) {
    if (!this.quotaBytes || this.quotaBytes <= 0) return []; // 0/undefined = unlimited
    const { total, records } = await this.getUsage();
    if (total <= this.quotaBytes) return [];

    const evicted = [];
    let remaining = total;
    for (const rec of records) {
      if (remaining <= this.quotaBytes) break;
      if (activeHashes.includes(rec.infoHash)) continue; // skip active
      await new Promise(resolve => {
        const req = indexedDB.deleteDatabase(`${dbPrefix}-${rec.infoHash}`);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
      await this.remove(rec.infoHash);
      remaining -= (rec.bytes || 0);
      evicted.push({ infoHash: rec.infoHash, name: rec.name, bytes: rec.bytes });
    }
    return evicted;
  }
}

// ═════════════════════════════════════════════════════════════════
// IDB CHUNK STORE
// ═════════════════════════════════════════════════════════════════
class IDBChunkStore {
  constructor(chunkLength, opts = {}) {
    this.chunkLength = chunkLength;
    this.length = opts.length != null ? opts.length : Infinity;
    this.name = opts.name || 'unknown';
    this.dbName = `${opts.dbPrefix || 'wtp'}-${this.name}`;
    this.storeName = 'chunks';
    this.db = null;
    this._quota = opts.quotaManager || null;

    this._ready = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onerror = () => reject(req.error);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'index' });
      };
      req.onsuccess = e => { this.db = e.target.result; resolve(this.db); };
    });
  }

  put(index, buf, cb) {
    this._ready.then(db => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        let data;
        if (buf instanceof ArrayBuffer) data = buf;
        else if (ArrayBuffer.isView(buf)) data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        else data = new Uint8Array(buf).buffer;

        const req = store.put({ index, data });
        req.onsuccess = () => {
          if (this._quota) this._quota.addBytes(this.name, data.byteLength, this._displayName).catch(() => {});
          cb(null);
        };
        req.onerror = () => cb(req.error);
      } catch (e) { cb(e); }
    }).catch(cb);
  }

  get(index, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    opts = opts || {};
    this._ready.then(db => {
      try {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get(index);
        req.onsuccess = () => {
          if (!req.result) { cb(new Error(`chunk ${index} not in IDB`)); return; }
          let ab = req.result.data;
          if (opts.offset != null || opts.length != null) {
            const off = opts.offset || 0;
            const end = opts.length != null ? off + opts.length : undefined;
            ab = ab.slice(off, end);
          }
          let out;
          if (typeof Buffer !== 'undefined') out = Buffer.from(ab);
          else {
            out = new Uint8Array(ab);
            out.copy = function (target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
              const start = sourceStart, end = Math.min(sourceEnd, this.length);
              const len = Math.min(end - start, target.length - targetStart);
              target.set(this.subarray(start, start + len), targetStart);
              return len;
            };
          }
          cb(null, out);
        };
        req.onerror = () => cb(req.error);
      } catch (e) { cb(e); }
    }).catch(cb);
  }

  close(cb) {
    this._ready.then(() => { if (this.db) { this.db.close(); this.db = null; } if (cb) cb(null); }).catch(err => { if (cb) cb(err); });
  }

  destroy(cb) {
    this.close(() => {
      const req = indexedDB.deleteDatabase(this.dbName);
      req.onsuccess = () => { if (this._quota) this._quota.remove(this.name).catch(() => {}); if (cb) cb(null); };
      req.onerror = () => { if (cb) cb(req.error); };
    });
  }
}

function makeChunkStoreClass(dbPrefix, quotaManager) {
  return class extends IDBChunkStore {
    constructor(chunkLength, opts) {
      super(chunkLength, { ...opts, dbPrefix, quotaManager });
    }
  };
}

// Sends the current "last allowed byte" to the Service Worker to restrict the stream
function makeSWNotifier(file) {
  return endByteInFile => {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
    try {
      navigator.serviceWorker.controller.postMessage({
        type: 'wtp-buffer-window',
        url: file.streamURL,
        endByte: endByteInFile == null ? null : endByteInFile,
      });
    } catch (e) {}
  };
}

// ═════════════════════════════════════════════════════════════════
// PLAYBACK BUFFER
// ═════════════════════════════════════════════════════════════════
class PlaybackBuffer {
  constructor(torrent, file, driver, opts = {}) {
    this.t = torrent;
    this.file = file;
    this.driver = driver;
    this.lookaheadSec = opts.lookaheadSec ?? 60;
    this.behindSec = opts.behindSec ?? 8;
    this.onWindowChange = opts.onWindowChange || (() => {});
    this.notifySW = opts.notifySW || (() => {});
    // When set, tells us the caller wants this file downloaded in full (not
    // just the streaming window) — e.g. webtorrent-pool.ts's "download whole
    // torrent" feature. Checked live (a function, not a snapshot boolean) so
    // toggling "download whole torrent" on/off mid-playback takes effect
    // immediately without having to reattach playback. See _recalc() below
    // for why this matters: without it, this class actively fights any
    // full-file selection by deselecting everything outside the small
    // lookahead/behind window every second.
    this.shouldKeepFull = opts.shouldKeepFull || (() => false);
    this._destroyed = false;
    this._timer = null;
    this._curWindow = null;

    const pieceLen = torrent.pieceLength;
    this.startPiece = Math.floor(file.offset / pieceLen);
    this.endPiece = Math.floor((file.offset + file.length - 1) / pieceLen);

    this._onSeeking = () => this._recalc();
    this._onLoadedMeta = () => this._recalc();
    driver.addEventListener('seeking', this._onSeeking);
    driver.addEventListener('loadedmetadata', this._onLoadedMeta);

    this._recalc();
    this._timer = setInterval(() => this._recalc(), 1000);
  }

  setLookahead(sec) { this.lookaheadSec = sec; this._recalc(); }
  setBehind(sec) { this.behindSec = sec; this._recalc(); }

  _recalc() {
    if (this._destroyed) return;
    const { t, file, driver } = this;
    if (t.done) { this.notifySW(null); return; }
    if (typeof t.select !== 'function') return;

    const pieceLen = t.pieceLength;
    const duration = driver.duration;
    const curTime = Math.max(0, driver.currentTime || 0);

    const bytesPerSec = (duration && isFinite(duration) && duration > 0)
      ? file.length / duration
      : (file.length / 1800);

    let startByte = Math.floor(Math.max(0, curTime - this.behindSec) * bytesPerSec);
    let endByte = Math.floor((curTime + this.lookaheadSec) * bytesPerSec);
    startByte = Math.max(0, Math.min(startByte, file.length - 1));
    endByte = Math.max(startByte, Math.min(endByte, file.length - 1));

    const newStart = this.startPiece + Math.floor(startByte / pieceLen);
    const newEnd = Math.min(this.endPiece, this.startPiece + Math.floor(endByte / pieceLen));
console.log(`[Buffer] ⏱️ Wideo: ${curTime.toFixed(1)}s | startByte: ${startByte}, endByte: ${endByte} | Chanki: ${newStart}-${newEnd}`);
    const changed = !this._curWindow || this._curWindow.start !== newStart || this._curWindow.end !== newEnd;
    if (changed) {
      try {
        t.select(newStart, newEnd, true);
        this._curWindow = { start: newStart, end: newEnd };
        this.onWindowChange({ start: newStart, end: newEnd, curTime });
      } catch (e) { console.warn('[PlaybackBuffer] select failed:', e); }
    }

    // Best-effort deselect for pieces outside the current window — but NOT
    // if the caller asked us to download this whole file anyway. Without
    // this guard, "download entire torrent" (webtorrent-pool.ts) selects
    // every piece once, and then THIS timer (ticking every second) immediately
    // deselects everything outside the small lookahead/behind window again,
    // so the file only ever downloads ~1 minute ahead of playback no matter
    // what the user asked for.
    if (!this.shouldKeepFull()) {
      try {
        if (newStart > this.startPiece) t.deselect(this.startPiece, newStart - 1);
        if (newEnd < this.endPiece) t.deselect(newEnd + 1, this.endPiece);
      } catch (e) {}
    }

    // Hard limit the Service Worker to prevent over-downloading from open-ended Range requests
    this.notifySW(endByte);
  }

  destroy() {
    this._destroyed = true;
    if (this._timer) clearInterval(this._timer);
    this.driver.removeEventListener('seeking', this._onSeeking);
    this.driver.removeEventListener('loadedmetadata', this._onLoadedMeta);
    try { this.t.deselect(this.startPiece, this.endPiece); } catch (e) {}
    this.notifySW(null);
  }
}

// ═════════════════════════════════════════════════════════════════
// MAIN LIBRARY CLASS
// ═════════════════════════════════════════════════════════════════
export class TorrentLibrary extends Emitter {
  constructor(opts = {}) {
    super();
    this.trackers = opts.trackers || [
      'wss://tracker.openwebtorrent.com',
      'wss://tracker.btorrent.xyz',
      'wss://tracker.fastcast.nz',
    ];
    this.dbPrefix = opts.dbPrefix || 'wtp';
    this.swPath = opts.swPath || './sw.js';
    this.client = null;
    this.serverReady = false;
    this.state = new PersistentState(this.dbPrefix);
    this.quota = new QuotaManager(this.dbPrefix, (opts.storageQuotaMB || 0) * 1024 * 1024);
    this._globalTimer = null;
    this._activeBuffer = null;
    this._activeFile = null;
    this._activeVideoEl = null;
    this._extraAudio = null;

    // url -> { infoHash, fileIndex, file, torrent } — lets us translate the
    // SW's "actually requested" byte ranges (keyed by streamURL) back into
    // torrent/file/piece coordinates for the UI.
    this._streamRegistry = new Map();
    this._requestChannel = (typeof BroadcastChannel !== 'undefined')
      ? new BroadcastChannel('wtp-stream-requests')
      : null;
    if (this._requestChannel) {
      this._requestChannel.onmessage = ({ data }) => this._onRangeRequested(data);
    }

    // Guards against double/looping reloads between the polling-based retry
    // path and the controllerchange-based one.
    this._swRefreshing = false;
    this._armControllerChangeRecovery();
  }

  // Registers/unregisters a file's streamURL so incoming SW telemetry can be
  // mapped back to (infoHash, fileIndex, pieces). Called from attach/detach.
  _registerStreamURL(file, torrent, infoHash, fileIndex) {
    if (!file?.streamURL) return;
    this._streamRegistry.set(file.streamURL, { infoHash, fileIndex, file, torrent });
  }
  _unregisterStreamURL(file) {
    if (!file?.streamURL) return;
    this._streamRegistry.delete(file.streamURL);
  }

  // Handles a "wtp-range-requested" message from the Service Worker: this is
  // the REAL (post-clamp) Range header the browser is about to fetch, i.e.
  // the actual bytes that will be requested from WebTorrent right now — as
  // opposed to `buffer-window`, which only reflects the page's *intended*
  // window before clamping/out-of-sync fallbacks are applied.
  _onRangeRequested(data) {
    if (!data || data.type !== 'wtp-range-requested') return;
    const reg = this._streamRegistry.get(data.url);
    if (!reg) return;
    const { infoHash, fileIndex, file, torrent } = reg;
    const pieceLen = torrent.pieceLength;
    const fileStartPiece = Math.floor(file.offset / pieceLen);
    const fileEndPiece = Math.floor((file.offset + file.length - 1) / pieceLen);

    const startByte = Math.max(0, data.start || 0);
    const endByte = data.end == null ? file.length - 1 : Math.min(data.end, file.length - 1);

    const startPiece = Math.min(fileEndPiece, fileStartPiece + Math.floor(startByte / pieceLen));
    const endPiece = Math.max(startPiece, Math.min(fileEndPiece, fileStartPiece + Math.floor(endByte / pieceLen)));

    this.emit('range-requested', {
      infoHash, fileIndex, startByte, endByte, startPiece, endPiece,
      destination: data.destination, ts: data.ts,
    });
  }

  // ── INIT ──────────────────────────────────────────────────────
  async init() {
    this.client = new WebTorrent({ maxConns: 55 });
    this.client.on('error', err => this.emit('error', err));
    this.client.on('torrent', t => this.emit('torrent-ready', this._snapshot(t)));

    await this._initServiceWorker();
    await this._requestPersistentStorage();
    this._restoreFromStorage();

    this._globalTimer = setInterval(() => {
      this.emit('global-tick', this.getGlobalStats());
    }, 1000);

    return this;
  }

  async _requestPersistentStorage() {
    try {
      if (navigator.storage?.persist) {
        const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
        const granted = already || await navigator.storage.persist();
        this.emit('persistent-storage', granted);
      }
    } catch (e) {}
  }

  async _initServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      this.emit('warning', 'This browser/context does not support Service Workers (requires https or localhost) — playback will require a full download first.');
      return;
    }
    await this._cleanupStaleRegistrations();

    const ok = await this._registerAndWaitForController(4, 1500);
    if (ok) { this._resetSWReloadLog(); this._finishServerSetup(); return; }

    if (this._canAutoReloadForSW()) {
      this._reloadOnceForSW('no controller after registration attempts');
      return;
    }

    console.error('[SW] Still no controller. Check DevTools -> Application -> Service Workers.');
    this.emit('warning', 'Failed to start on-the-fly streaming — you can try again or wait for full file download.');
    this.emit('server-retry-needed');
  }

  // Fires whenever the page's controller changes — including the case where
  // THIS reload/tab is the one that caused a new SW to activate. Per the
  // standard SW gotcha: the tab that triggers an update is often NOT
  // controlled by the new worker until it reloads once more. Without this,
  // that reload has to be done manually by the user (which is exactly the
  // "Ctrl+R doesn't connect, but a fresh navigation does" symptom — a fresh
  // navigation is more likely to land after the SW has already activated,
  // while a reload can race it).
  _armControllerChangeRecovery() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (this.serverReady) return; // already working — this is a later, benign update; don't disrupt playback
      if (!this._canAutoReloadForSW()) return; // safety valve against pathological loops
      this._reloadOnceForSW('controllerchange event');
    });
  }

  _reloadOnceForSW(reason) {
    if (this._swRefreshing) return;
    this._swRefreshing = true;
    this._markSWAutoReload();
    console.warn(`[SW] Reloading page to recover Service Worker control (${reason}).`);
    location.reload();
  }

  _swReloadLog() {
    try { return JSON.parse(sessionStorage.getItem('wtp-sw-reload-log') || '{"count":0,"last":0}'); }
    catch (e) { return { count: 0, last: 0 }; }
  }
  _canAutoReloadForSW() {
    const MAX_AUTO_RELOADS = 5;
    const COOLDOWN_MS = 8000;
    const DECAY_MS = 5 * 60 * 1000; // a failure streak from 5+ min ago no longer counts against us
    const log = this._swReloadLog();
    const count = (Date.now() - log.last > DECAY_MS) ? 0 : log.count;
    return count < MAX_AUTO_RELOADS && (Date.now() - log.last) > COOLDOWN_MS;
  }
  _markSWAutoReload() {
    const log = this._swReloadLog();
    const decayed = (Date.now() - log.last > 5 * 60 * 1000);
    const nextCount = (decayed ? 0 : log.count) + 1;
    sessionStorage.setItem('wtp-sw-reload-log', JSON.stringify({ count: nextCount, last: Date.now() }));
  }
  // Called on every successful connection — a working connection means past
  // failures are no longer relevant, so future hiccups get the full retry
  // budget again instead of inheriting exhaustion from earlier attempts.
  _resetSWReloadLog() {
    try { sessionStorage.removeItem('wtp-sw-reload-log'); } catch (e) {}
  }

  async _cleanupStaleRegistrations() {
    const swFile = this.swPath.split('/').pop();
    try {
      const existing = await navigator.serviceWorker.getRegistrations();
      for (const r of existing) {
        const url = r.active?.scriptURL || r.waiting?.scriptURL || r.installing?.scriptURL || '';
        if (url && !url.endsWith('/' + swFile) && !url.endsWith(swFile)) {
          console.warn('[SW] Removing stale/foreign service worker registration:', url);
          await r.unregister();
        }
      }
    } catch (e) {}
  }

  async _registerAndWaitForController(maxAttempts, delayMs) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`[SW] Registering ${this.swPath} (attempt ${attempt}/${maxAttempts})...`);
        const reg = await navigator.serviceWorker.register(this.swPath);
        await navigator.serviceWorker.ready;
        
        console.log('[SW] Active. Controller present?', !!navigator.serviceWorker.controller);
        if (navigator.serviceWorker.controller) return true;

        // Fix for Bug 2: If the SW is active but the page is uncontrolled 
        // (e.g. due to a hard reload), forcefully ask the SW to claim clients.
        if (reg.active && !navigator.serviceWorker.controller) {
          reg.active.postMessage({ type: 'wtp-claim' });
        }

        console.log(`[SW] No controller — waiting up to ${delayMs}ms for "controllerchange"...`);
        await new Promise(resolve => {
          const timer = setTimeout(resolve, delayMs);
          navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        if (navigator.serviceWorker.controller) return true;
      } catch (e) {
        console.warn(`[SW] Attempt ${attempt} failed:`, e);
      }
    }
    return false;
  }

  _finishServerSetup() {
    navigator.serviceWorker.getRegistration().then(reg => {
      try {
        this.client.createServer({ controller: reg });
        this.serverReady = true;
        console.log('[SW] WebTorrent server created — streaming should work.');
        this.emit('server-ready');
      } catch (err) {
        console.error('[SW] createServer failed:', err);
        this.emit('warning', 'Failed to start streaming server: ' + (err.message || err));
      }
    });
  }

  async retryServiceWorker() {
    if (this.serverReady) return true;
    this.emit('server-retrying');
    const ok = await this._registerAndWaitForController(2, 1500);
    if (ok) { this._resetSWReloadLog(); this._finishServerSetup(); return true; }
    this.emit('warning', 'Still unable to connect to the Service Worker — try manually refreshing the page.');
    return false;
  }

  // ── QUOTA ─────────────────────────────────────────────────────
  setStorageQuotaMB(mb) { this.quota.setQuota((mb || 0) * 1024 * 1024); this._enforceQuota(); }
  async getStorageUsage() {
    const usage = await this.quota.getUsage();
    return { usedBytes: usage.total, quotaBytes: usage.quota, perTorrent: usage.records };
  }
  async _enforceQuota() {
    const active = [this._activeFile?._infoHash].filter(Boolean);
    const evicted = await this.quota.enforce(this.dbPrefix, active);
    if (evicted.length) {
      evicted.forEach(e => this.state.removeFromList(e.infoHash));
      this.emit('storage-evicted', evicted);
      this.emit('torrents-changed', this.getTorrents());
    }
  }

  // ── HELPERS ───────────────────────────────────────────────────
  _findTorrent(infoHash) {
    if (!this.client || !infoHash) return null;
    return this.client.torrents.find(t => t.infoHash === infoHash) || null;
  }

  static extractMagnetInfoHash(str) {
    if (typeof str !== 'string') return null;
    const m = /xt=urn:btih:([a-zA-Z0-9]+)/.exec(str);
    return m ? m[1].toLowerCase() : null;
  }

  _snapshot(t) {
    const stats = this.state.getStats(t.infoHash);
    return {
      infoHash: t.infoHash,
      name: t.name,
      length: t.length,
      progress: t.progress,
      downloadSpeed: t.downloadSpeed,
      uploadSpeed: t.uploadSpeed,
      downloaded: t.downloaded,
      uploaded: t.uploaded,
      numPeers: t.numPeers,
      done: t.done,
      timeRemaining: t.timeRemaining,
      magnetURI: t.magnetURI,
      allTime: stats,
      files: t.files.map((f, i) => ({
        index: i, name: f.name, length: f.length,
        isVideo: isVideo(f.name), isAudio: isAudio(f.name), isSub: isSub(f.name),
        nativePlayable: isNativePlayable(f.name),
        progress: f.progress ?? null,
      })),
      wires: (t.wires || []).map(w => ({
        addr: w.remoteAddress ? `${w.remoteAddress}:${w.remotePort || '?'}` : 'WebRTC',
        downloadSpeed: typeof w.downloadSpeed === 'function' ? w.downloadSpeed() : 0,
        uploadSpeed: typeof w.uploadSpeed === 'function' ? w.uploadSpeed() : 0,
        peerChoking: w.peerChoking, amChoking: w.amChoking,
        peerId: peerIdToString(w.peerId),
        bitfieldPct: this._peerBitfieldPct(w, t),
      })),
    };
  }

  _peerBitfieldPct(w, t) {
    if (!w.peerPieces || !w.peerPieces.buffer || !t.pieces) return 0;
    const total = t.pieces.length || 1;
    let bits = 0;
    const bytes = new Uint8Array(w.peerPieces.buffer);
    for (const b of bytes) { let x = b; while (x) { bits += x & 1; x >>= 1; } }
    return Math.round((bits / total) * 100);
  }

  // ── PIECE MAP ──────────────────────────────────────────────────
  _haveAt(t, pieceIndex) {
    if (t.bitfield && typeof t.bitfield.get === 'function') return !!t.bitfield.get(pieceIndex);
    if (t.pieces) return t.pieces[pieceIndex] === null;
    return false;
  }

  _buildBucketMap(t, startPiece, endPiece, buckets) {
    const total = endPiece - startPiece + 1;
    if (total <= 0) return { buckets: [], totalPieces: 0, startPiece, endPiece, pieceLength: t.pieceLength };
    const n = Math.max(1, Math.min(buckets, total));
    const out = new Array(n);
    for (let b = 0; b < n; b++) {
      const from = startPiece + Math.floor((b / n) * total);
      const to = startPiece + Math.max(Math.floor((b / n) * total) + 1, Math.floor(((b + 1) / n) * total));
      let have = 0, count = 0;
      for (let p = from; p < to && p <= endPiece; p++) { count++; if (this._haveAt(t, p)) have++; }
      out[b] = { h: count > 0 ? have / count : 0, parity: from % 2 };
    }
    return { buckets: out, totalPieces: total, startPiece, endPiece, pieceLength: t.pieceLength };
  }

  getFilePieceMap(infoHash, fileIndex, buckets = 150) {
    const t = this._findTorrent(infoHash);
    if (!t) return null;
    const file = t.files[fileIndex];
    if (!file) return null;
    const pieceLen = t.pieceLength;
    const startPiece = Math.floor(file.offset / pieceLen);
    const endPiece = Math.floor((file.offset + file.length - 1) / pieceLen);
    const map = this._buildBucketMap(t, startPiece, endPiece, buckets);
    map.fileName = file.name;
    map.fileLength = file.length;
    map.fileOffset = file.offset;
    map.piecesPerBucket = map.buckets.length ? map.totalPieces / map.buckets.length : 0;
    return map;
  }

  getTorrentPieceMap(infoHash, buckets = 150) {
    const t = this._findTorrent(infoHash);
    if (!t) return null;
    const last = (t.pieces ? t.pieces.length : (t.bitfield ? t.bitfield.length : 0)) - 1;
    if (last < 0) return null;
    return this._buildBucketMap(t, 0, last, buckets);
  }

  getTorrents() {
    return this.state.getList().map(info => {
      const live = this._findTorrent(info.infoHash);
      if (live) return this._snapshot(live);
      const stats = this.state.getStats(info.infoHash);
      return { infoHash: info.infoHash, name: info.name, length: info.length, progress: 0, downloadSpeed: 0, uploadSpeed: 0, downloaded: 0, uploaded: 0, numPeers: 0, done: false, magnetURI: info.magnetURI, allTime: stats, files: [], wires: [], notLoaded: true };
    });
  }

  getTorrent(infoHash) {
    return this.getTorrents().find(s => s.infoHash === infoHash) || null;
  }

  getGlobalStats() {
    let dl = 0, ul = 0, peers = 0, active = 0;
    this.client?.torrents.forEach(t => { dl += t.downloadSpeed; ul += t.uploadSpeed; peers += t.numPeers; if (!t.done) active++; });
    const allTime = this.state.getGlobalStats();
    return { downloadSpeed: dl, uploadSpeed: ul, numPeers: peers, activeTorrents: active, allTimeDownloaded: allTime.downloaded, allTimeUploaded: allTime.uploaded, totalTorrents: allTime.torrents };
  }

  // ── ADD / REMOVE ─────────────────────────────────────────────
  addTorrent(magnetOrUrl) {
    return new Promise((resolve, reject) => {
      const knownHash = TorrentLibrary.extractMagnetInfoHash(magnetOrUrl);
      const existing = knownHash ? this._findTorrent(knownHash) : null;
      if (existing) { resolve(this._snapshot(existing)); return; }

      const opts = {
        store: makeChunkStoreClass(this.dbPrefix, this.quota),
        announce: this.trackers,
        deselect: true,
      };

      this.emit('adding');
      this.client.add(magnetOrUrl, opts, torrent => {
        this.state.upsert({ infoHash: torrent.infoHash, magnetURI: torrent.magnetURI, name: torrent.name, length: torrent.length, addedAt: Date.now() });
        this.state.cacheTorrentMeta(torrent);
        this.quota.touch(torrent.infoHash, torrent.name);
        this._fixStreamURLs(torrent);
        this._wireTorrentEvents(torrent);
        this.emit('torrents-changed', this.getTorrents());
        resolve(this._snapshot(torrent));
      });
    });
  }

  _wireTorrentEvents(t) {
    const persist = () => { this.state.saveStats(t.infoHash, t); this._enforceQuota(); };
    let lastEmit = 0;
    const emitStats = () => {
      const now = Date.now();
      if (now - lastEmit < 300) return;
      lastEmit = now;
      this.emit('torrent-stats', this._snapshot(t));
    };
    t.on('download', () => { persist(); emitStats(); });
    t.on('upload', () => { persist(); emitStats(); });
    t.on('wire', () => emitStats());
    t.on('done', () => { persist(); this.emit('torrent-done', this._snapshot(t)); this.emit('torrents-changed', this.getTorrents()); });
    t.on('error', err => this.emit('torrent-error', { infoHash: t.infoHash, error: err }));
    t.on('noPeers', type => this.emit('no-peers', { infoHash: t.infoHash, type }));
  }

  _fixStreamURLs(t) {
    const base = location.pathname.substring(0, location.pathname.lastIndexOf('/'));
    if (base && base !== '/') {
      t.files.forEach(file => {
        if (file.streamURL && file.streamURL.startsWith('/webtorrent/') && !file.streamURL.startsWith(base)) {
          console.log(`[Library] Patching streamURL for GH Pages: ${file.streamURL} -> ${base}${file.streamURL}`);
          file.streamURL = base + file.streamURL;
        }
      });
    }
  }

  removeTorrent(infoHash) {
    if (this._activeFile?._infoHash === infoHash) this.detachPlayback();
    const t = this._findTorrent(infoHash);
    if (t) t.destroy({ destroyStore: true }, () => {});
    this.quota.remove(infoHash);
    this.state.removeFromList(infoHash);
    this.emit('torrents-changed', this.getTorrents());
  }

  copyMagnetURI(infoHash) {
    const t = this._findTorrent(infoHash);
    return t ? t.magnetURI : (this.state.getList().find(x => x.infoHash === infoHash) || {}).magnetURI || null;
  }

  _restoreFromStorage() {
    const list = this.state.getList();
    list.forEach(info => {
      const cachedMeta = this.state.getCachedTorrentMeta(info.infoHash);
      const torrentId = cachedMeta || info.magnetURI;
      if (!torrentId) return;
      const opts = {
        store: makeChunkStoreClass(this.dbPrefix, this.quota),
        announce: this.trackers,
        deselect: true,
      };
      this.client.add(torrentId, opts, torrent => {
        this.state.upsert({ ...info, name: torrent.name, length: torrent.length });
        this.state.cacheTorrentMeta(torrent);
        this._fixStreamURLs(torrent);
        this._wireTorrentEvents(torrent);
        this.emit('torrents-changed', this.getTorrents());
      });
    });
  }

  // ── PLAYBACK ──────────────────────────────────────────────────
  attachPlayback(infoHash, fileIndex, videoEl, opts = {}) {
    this.detachPlayback();
    const t = this._findTorrent(infoHash);
    if (!t) throw new Error(`Torrent ${infoHash} is not loaded in the client`);
    this._fixStreamURLs(t);
    const file = t.files[fileIndex];
    if (!file) throw new Error(`File [${fileIndex}] does not exist in the torrent`);

    t.files.forEach(f => f.deselect());
    file._infoHash = infoHash;
    this._activeFile = file;
    this.quota.touch(infoHash, t.name);

    if (this.serverReady) {
      videoEl.src = file.streamURL;
      this._registerStreamURL(file, t, infoHash, fileIndex);
    } else if (t.done) {
      file.blob().then(blob => { videoEl.src = URL.createObjectURL(blob); }).catch(err => this.emit('error', err));
    } else {
      this.emit('warning', 'On-the-fly streaming unavailable (no Service Worker) — wait for full download.');
      return { detach: () => {}, setLookahead: () => {}, file, torrent: t, streaming: false };
    }

    this._activeVideoEl = videoEl;
    this._activeBuffer = new PlaybackBuffer(t, file, videoEl, {
      lookaheadSec: opts.lookaheadSec ?? 60,
      behindSec: opts.behindSec ?? 8,
      shouldKeepFull: opts.shouldKeepFull,
      onWindowChange: win => this.emit('buffer-window', { infoHash, fileIndex, ...win }),
      notifySW: makeSWNotifier(file),
    });

    return {
      file, torrent: t, streaming: true,
      detach: () => this.detachPlayback(),
      setLookahead: sec => { if (this._activeBuffer) this._activeBuffer.setLookahead(sec); },
      setBehind: sec => { if (this._activeBuffer) this._activeBuffer.setBehind(sec); },
    };
  }

  detachPlayback() {
    this.detachExtraAudio();
    if (this._activeBuffer) { this._activeBuffer.destroy(); this._activeBuffer = null; }
    if (this._activeFile) {
      this._unregisterStreamURL(this._activeFile);
      try { this._activeFile.deselect(); } catch (e) {}
      this._activeFile = null;
    }
    this._activeVideoEl = null;
  }

  // ── EXTRA AUDIO ───────────────────────────
  attachExtraAudio(infoHash, fileIndex, opts = {}) {
    this.detachExtraAudio();
    const mainVideo = this._activeVideoEl;
    if (!mainVideo || !this._activeFile) throw new Error('Start video/audio playback first (attachPlayback).');

    const t = this._findTorrent(infoHash);
    if (!t) throw new Error(`Torrent ${infoHash} is not loaded in the client`);
    const file = t.files[fileIndex];
    if (!file) throw new Error(`File [${fileIndex}] does not exist in the torrent`);

    const audioEl = new Audio();
    audioEl.preload = 'auto';

    const state = {
      mode: opts.mode === 'dub' ? 'dub' : 'lektor',
      duckLevel: opts.duckLevel != null ? Math.max(0, Math.min(1, opts.duckLevel)) : 0.15,
      offsetSec: (opts.offsetMs || 0) / 1000,
      prevVideoVolume: mainVideo.volume,
      prevVideoMuted: mainVideo.muted,
    };

    const applyVolumes = () => {
      mainVideo.muted = false;
      mainVideo.volume = state.mode === 'dub' ? 0 : state.duckLevel;
      audioEl.volume = 1;
    };
    applyVolumes();

    if (this.serverReady) {
      audioEl.src = file.streamURL;
      this._registerStreamURL(file, t, infoHash, fileIndex);
    } else if (t.done) {
      file.blob().then(blob => { audioEl.src = URL.createObjectURL(blob); }).catch(err => this.emit('error', err));
    } else {
      this.emit('warning', 'On-the-fly streaming unavailable — extra audio will be ready after full download.');
    }

    const resync = () => {
      const target = Math.max(0, mainVideo.currentTime + state.offsetSec);
      if (Math.abs(audioEl.currentTime - target) > 0.25) {
        try { audioEl.currentTime = target; } catch (e) {}
      }
    };
    const onPlay = () => { resync(); audioEl.play().catch(() => {}); };
    const onPause = () => audioEl.pause();
    const onSeeked = () => resync();
    const onRateChange = () => { audioEl.playbackRate = mainVideo.playbackRate; };
    const onTimeUpdate = () => resync();

    mainVideo.addEventListener('play', onPlay);
    mainVideo.addEventListener('pause', onPause);
    mainVideo.addEventListener('seeked', onSeeked);
    mainVideo.addEventListener('ratechange', onRateChange);
    mainVideo.addEventListener('timeupdate', onTimeUpdate);
    onRateChange();
    if (!mainVideo.paused) onPlay();

    const driver = {
      get currentTime() { return mainVideo.currentTime + state.offsetSec; },
      get duration() { return mainVideo.duration; },
      addEventListener: (...a) => mainVideo.addEventListener(...a),
      removeEventListener: (...a) => mainVideo.removeEventListener(...a),
    };

    const buffer = new PlaybackBuffer(t, file, driver, {
      lookaheadSec: opts.lookaheadSec ?? 60,
      behindSec: opts.behindSec ?? 8,
      onWindowChange: win => this.emit('buffer-window', { infoHash, fileIndex, extra: true, ...win }),
      notifySW: makeSWNotifier(file),
    });

    this._extraAudio = {
      el: audioEl, buffer, state, mainVideo, file,
      listeners: { onPlay, onPause, onSeeked, onRateChange, onTimeUpdate },
    };

    return {
      file, torrent: t,
      setMode: mode => { state.mode = mode === 'dub' ? 'dub' : 'lektor'; applyVolumes(); },
      setDuckLevel: pct => { state.duckLevel = Math.max(0, Math.min(1, pct)); applyVolumes(); },
      setOffsetMs: ms => { state.offsetSec = (ms || 0) / 1000; resync(); },
      getOffsetMs: () => Math.round(state.offsetSec * 1000),
      setLookahead: sec => buffer.setLookahead(sec),
      setBehind: sec => buffer.setBehind(sec),
      detach: () => this.detachExtraAudio(),
    };
  }

  detachExtraAudio() {
    if (!this._extraAudio) return;
    const { el, buffer, listeners, mainVideo, state, file } = this._extraAudio;
    if (file) this._unregisterStreamURL(file);
    buffer.destroy();
    mainVideo.removeEventListener('play', listeners.onPlay);
    mainVideo.removeEventListener('pause', listeners.onPause);
    mainVideo.removeEventListener('seeked', listeners.onSeeked);
    mainVideo.removeEventListener('ratechange', listeners.onRateChange);
    mainVideo.removeEventListener('timeupdate', listeners.onTimeUpdate);
    try { el.pause(); el.src = ''; } catch (e) {}
    mainVideo.volume = state.prevVideoVolume;
    mainVideo.muted = state.prevVideoMuted;
    this._extraAudio = null;
  }

  async downloadFileBlob(infoHash, fileIndex) {
    const t = this._findTorrent(infoHash);
    if (!t) throw new Error('Torrent not loaded');
    const file = t.files[fileIndex];
    if (!file) throw new Error('File does not exist');
    const blob = await file.blob();
    return { blob, url: URL.createObjectURL(blob), name: file.name };
  }

  async readFileArrayBuffer(infoHash, fileIndex, priority = 1) {
    const t = this._findTorrent(infoHash);
    if (!t) throw new Error('Torrent not loaded');
    const file = t.files[fileIndex];
    if (!file) throw new Error('File does not exist');
    file.select(priority);
    return file.arrayBuffer();
  }

  // Reads a subtitle file of ANY supported format (.srt/.vtt/.ass/.ssa/.sub/
  // .sbv/.smi/.sami), auto-detects encoding, converts to WebVTT, and hands
  // back a ready-to-use blob URL + guessed language — so a consumer can just
  // do `video.appendChild(Object.assign(document.createElement('track'), {
  // kind: 'subtitles', src: result.url, srclang: result.srclang, label: result.name
  // }))` without knowing any of the format details.
  async getSubtitleTrack(infoHash, fileIndex) {
    const t = this._findTorrent(infoHash);
    if (!t) throw new Error('Torrent not loaded');
    const file = t.files[fileIndex];
    if (!file) throw new Error('File does not exist');
    if (!isSub(file.name)) throw new Error(`File "${file.name}" is not a recognized subtitle format`);

    file.select(1);
    const ab = await file.arrayBuffer();
    const text = decodeSubtitleBytes(new Uint8Array(ab));
    const vtt = convertSubtitleToVtt(file.name, text);
    const blob = new Blob([vtt], { type: 'text/vtt;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    return { url, vtt, name: file.name, srclang: detectSubtitleLang(file.name), format: ext(file.name) };
  }

  destroy() {
    if (this._globalTimer) clearInterval(this._globalTimer);
    this.detachPlayback();
    if (this._requestChannel) { try { this._requestChannel.close(); } catch (e) {} this._requestChannel = null; }
    if (this.client) this.client.destroy();
  }
}