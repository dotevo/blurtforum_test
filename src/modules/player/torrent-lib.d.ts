/**
 * modules/player/torrent-lib.d.ts
 *
 * Ambient type declarations for torrent-lib.js — a plain ES module (not
 * TypeScript), dropped in as-is per the working standalone PoC. This file
 * only describes its public shape so webtorrent-pool.ts (and anything else
 * that imports it) gets type-checking; it has no runtime effect and must be
 * kept in sync by hand if torrent-lib.js's public API changes.
 *
 * IMPORTANT: this file must stay a *flat* declaration file, NOT wrapped in
 * `declare module './torrent-lib.js' { ... }`. TypeScript pairs a .d.ts with
 * a same-directory, same-basename .js file automatically (the standard
 * colocated-declaration convention) and then expects THIS file to be the
 * module — wrapping it in an extra `declare module` block makes TS treat it
 * as a global script instead, which is the "is not a module" error.
 *
 * NOTE: torrent-lib.js does `import WebTorrent from
 * 'https://cdn.jsdelivr.net/npm/webtorrent@3.0.16/dist/webtorrent.min.js'`
 * — a bare CDN URL specifier. Vite/Rollup treat absolute http(s) import
 * specifiers as external and pass them through unchanged rather than trying
 * to resolve them from node_modules, so this should survive bundling as-is;
 * if `vite build` ever warns about it, add it to
 * `build.rollupOptions.external` (a regex like `/^https?:\/\//` is enough) —
 * that only suppresses the warning, the import itself already works.
 */

export function ext(name: string): string;
export function isVideo(name: string): boolean;
export function isAudio(name: string): boolean;
export function isSub(name: string): boolean;
export function isLectorTrack(name: string): boolean;
export function isNativePlayable(name: string): boolean;
export function detectSubtitleLang(filename: string): string;
export const NATIVE_PLAYABLE_EXT: Set<string>;

export interface TorrentLibFileSnapshot {
  index: number;
  name: string;
  length: number;
  isVideo: boolean;
  isAudio: boolean;
  isSub: boolean;
  nativePlayable: boolean;
  progress: number | null;
}

export interface TorrentLibWireSnapshot {
  addr: string;
  downloadSpeed: number;
  uploadSpeed: number;
  peerChoking: boolean;
  amChoking: boolean;
  peerId: string | null;
  bitfieldPct: number;
}

export interface TorrentLibSnapshot {
  infoHash: string;
  name: string;
  length: number;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  downloaded: number;
  uploaded: number;
  numPeers: number;
  done: boolean;
  timeRemaining: number;
  magnetURI: string;
  allTime: { downloaded: number; uploaded: number; lastSeen: number };
  files: TorrentLibFileSnapshot[];
  wires: TorrentLibWireSnapshot[];
  notLoaded?: boolean;
}

export interface TorrentLibPieceMap {
  buckets: Array<{ h: number; parity: number }>;
  totalPieces: number;
  startPiece: number;
  endPiece: number;
  pieceLength: number;
  fileName?: string;
  fileLength?: number;
  fileOffset?: number;
  piecesPerBucket?: number;
}

export interface TorrentLibPlaybackHandle {
  file: any;
  torrent: any;
  streaming: boolean;
  detach: () => void;
  setLookahead?: (sec: number) => void;
  setBehind?: (sec: number) => void;
}

export interface TorrentLibExtraAudioHandle {
  file: any;
  torrent: any;
  setMode: (mode: 'lektor' | 'dub') => void;
  setOrigVolume: (pct: number) => void;
  setTrackVolume: (pct: number) => void;
  setOffsetMs: (ms: number) => void;
  getOffsetMs: () => number;
  detach: () => void;
}

export interface TorrentLibSubtitleTrack {
  url: string;
  vtt: string;
  name: string;
  srclang: string;
  format: string;
}

export class TorrentLibrary {
  constructor(opts?: {
    trackers?: string[];
    dbPrefix?: string;
    swPath?: string;
    storageQuotaMB?: number;
  });

  client: any;
  serverReady: boolean;
  state: any;
  quota: any;

  init(): Promise<this>;
  destroy(): void;

  on(evt: string, fn: (...args: any[]) => void): () => void;
  off(evt: string, fn: (...args: any[]) => void): void;

  addTorrent(magnetOrUrl: string): Promise<TorrentLibSnapshot>;
  removeTorrent(infoHash: string): void;
  copyMagnetURI(infoHash: string): string | null;

  getTorrents(): TorrentLibSnapshot[];
  getTorrent(infoHash: string): TorrentLibSnapshot | null;
  getGlobalStats(): {
    downloadSpeed: number; uploadSpeed: number; numPeers: number;
    activeTorrents: number; allTimeDownloaded: number; allTimeUploaded: number;
    totalTorrents: number;
  };

  getFilePieceMap(infoHash: string, fileIndex: number, buckets?: number): TorrentLibPieceMap | null;
  getTorrentPieceMap(infoHash: string, buckets?: number): TorrentLibPieceMap | null;

  attachPlayback(
    infoHash: string, fileIndex: number, videoEl: HTMLMediaElement,
    opts?: { lookaheadSec?: number; behindSec?: number; shouldKeepFull?: () => boolean }
  ): TorrentLibPlaybackHandle;
  detachPlayback(): void;

  attachExtraAudio(infoHash: string, fileIndex: number, opts?: {
    mode?: 'lektor' | 'dub'; origVolume?: number; trackVolume?: number; offsetMs?: number;
  }): TorrentLibExtraAudioHandle;
  detachExtraAudio(): void;

  /**
   * Registers a bittorrent-protocol (BEP-10) extension factory — exactly
   * what you'd pass to `wire.use(factory)` directly. Applied to every wire
   * on every torrent, current (retroactively) and future. The library has
   * no opinion on what the extension does.
   */
  registerWireExtension(factory: (wire: any) => any): void;

  downloadFileBlob(infoHash: string, fileIndex: number): Promise<{ blob: Blob; url: string; name: string }>;
  readFileArrayBuffer(infoHash: string, fileIndex: number, priority?: number): Promise<ArrayBuffer>;
  getSubtitleTrack(infoHash: string, fileIndex: number): Promise<TorrentLibSubtitleTrack>;

  setStorageQuotaMB(mb: number): void;
  getStorageUsage(): Promise<{ usedBytes: number; quotaBytes: number; perTorrent: any[] }>;

  retryServiceWorker(): Promise<boolean>;

  static extractMagnetInfoHash(str: string): string | null;
}