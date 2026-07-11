/**
 * modules/player/webtorrent-pool.ts
 *
 * Thin adapter around the standalone, already-working torrent-lib.js
 * (TorrentLibrary) — NOT a from-scratch WebTorrent integration. The previous
 * version of this file drove the `webtorrent` npm package directly and had
 * a laundry list of open bugs (bundler-vs-browser-build issues, no
 * position-aware download window, manual srt/vtt conversion, etc.) — all of
 * that is now solved inside torrent-lib.js, which is a verified-working
 * standalone PoC. This file's only job is to:
 *
 *   1. own the one shared TorrentLibrary instance for the page's lifetime
 *      (lazy-constructed on first use, same as the old pool's initPromise
 *      pattern), and
 *   2. keep the public surface the rest of the player already depends on
 *      (player.ts, WebtorrentVideo.vue, WebtorrentInfoModal.vue,
 *      WebtorrentSettingsModal.vue) so swapping the engine underneath
 *      didn't require rewriting every call site — while also exposing the
 *      new capabilities (piece maps, subtitle conversion, playback buffer,
 *      richer stats) those call sites now use instead of hand-rolling them.
 *
 * torrent-lib.js itself is intentionally NOT modified — see its own header
 * comment, and see torrent-lib.d.ts for a note on the one piece of build
 * wiring (the CDN import for the webtorrent bundle) that needs to survive
 * bundling for this to actually work here the same way it does in the
 * standalone PoC.
 */
import { TorrentLibrary, isLectorTrack } from './torrent-lib.js';
import type {
  TorrentLibSnapshot, TorrentLibPieceMap, TorrentLibPlaybackHandle, TorrentLibSubtitleTrack,
  TorrentLibExtraAudioHandle,
} from './torrent-lib.js';

export { isLectorTrack };

const WT_DEBUG = true;
const wlog = (...args: unknown[]): void => { if (WT_DEBUG) console.log('[WT]', ...args); };

// ─── localStorage keys & defaults (same keys as the old pool, so an
// existing user's quota/seeding preference survives the swap) ─────────────
const QUOTA_KEY = 'bf-player-wt-quota';
const SEEDING_KEY = 'bf-player-wt-seeding';
const DEFAULT_QUOTA_BYTES = 500 * 1024 * 1024; // 500 MB

// ─── Public types (unchanged shape from the old pool, so types.ts and
// consumers that only care about "downloaded/uploaded totals" don't need to
// change) ───────────────────────────────────────────────────────────────────
export interface SeedManifestEntry {
  infoHash: string;
  magnetURI: string;
  title: string;
  sizeBytes: number;
  lastActiveAt: number;
  /** Whole-torrent download progress (0–1), not just the currently-playing file's streaming window. */
  progress: number;
  /** Whole torrent fully downloaded — safe to play back with zero network (once metadata is cached too, see downloadEntireTorrent). */
  done: boolean;
  /** Whether the user asked us to keep downloading every file, not just what's needed to stream the active one. */
  fullDownload: boolean;
}
export interface TorrentStatsEntry {
  title: string;
  uploaded: number;
  downloaded: number;
}
export interface WebtorrentStats {
  totalUploaded: number;
  totalDownloaded: number;
  perTorrent: Record<string, TorrentStatsEntry>;
}

// Re-exported so components can type against the library's richer snapshot
// (files[].isSub, wires[].bitfieldPct, allTime, timeRemaining, etc.) instead
// of the flattened shape the old pool used to hand-roll.
export type { TorrentLibSnapshot as TorrentSnapshot, TorrentLibPieceMap as PieceMap, TorrentLibSubtitleTrack as SubtitleTrack };

const readNumber = (key: string, fallback: number): number => {
  const raw = Number(localStorage.getItem(key));
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

// ─── "Download whole torrent" tracking ─────────────────────────────────────
// Streaming playback only ever downloads a small lookahead/behind window
// around the currently-playing position (see torrent-lib.js's
// PlaybackBuffer, driven from attachPlayback()) — great for "start watching
// immediately", useless for "grab the whole thing now so it plays back with
// no connection at all later" (e.g. before a flight, or a phone with a
// spotty connection — the actual motivating case for this feature, since a
// future offline-capable mobile app can't rely on fetching anything at
// play-time). torrent-lib.js itself has no concept of "select every file",
// so this is layered on entirely from here, using the library's already-
// public `client` handle rather than modifying torrent-lib.js.
const FULL_DOWNLOAD_KEY = 'bf-player-wt-full-downloads';
const fullDownloadHashes = new Set<string>(
  (() => {
    try { return JSON.parse(localStorage.getItem(FULL_DOWNLOAD_KEY) || '[]') as string[]; }
    catch { return []; }
  })(),
);
const saveFullDownloadHashes = (): void =>
  localStorage.setItem(FULL_DOWNLOAD_KEY, JSON.stringify([...fullDownloadHashes]));

/** Selects every file's pieces for download, on top of whatever attachPlayback() already selected for the active file. */
const selectAllFiles = (infoHash: string): void => {
  const t = lib?.client?.torrents?.find((x: any) => x.infoHash === infoHash);
  t?.files?.forEach((f: any) => f.select());
};

// ─── Shared instance ────────────────────────────────────────────────────────
let lib: TorrentLibrary | null = null;
let initPromise: Promise<TorrentLibrary> | null = null;

/**
 * Ensures the shared TorrentLibrary exists and has finished init() (Service
 * Worker registration/recovery, storage.persist(), resuming persisted
 * torrents). Safe to call repeatedly — subsequent calls return the same
 * promise. Every other export in this file that needs the instance awaits
 * this first, so callers never have to think about init ordering themselves.
 */
export const initWebtorrent = (): Promise<TorrentLibrary> => {
  if (initPromise) return initPromise;
  wlog('initWebtorrent: constructing TorrentLibrary…');
  initPromise = (async () => {
    const quotaBytes = readNumber(QUOTA_KEY, DEFAULT_QUOTA_BYTES);

    const instance = new TorrentLibrary({
      dbPrefix: 'bfp-wt',
      // sw.js is copied into /public by the app itself (see project README);
      // must be served from the origin root so its scope covers /webtorrent/*.
      swPath: '/sw.js',
      storageQuotaMB: quotaBytes / (1024 * 1024),
    });

    instance.on('error', (err: Error) => console.error('[WT] client-level error:', err));
    instance.on('warning', (msg: string) => console.warn('[WT] warning:', msg));
    instance.on('torrent-error', ({ infoHash, error }: { infoHash: string; error: Error }) =>
      console.warn('[WT] torrent error for', infoHash, '—', error?.message || error));
    // Extra lifecycle logging (per user request: "dodaj dużo dodatkowych
    // logów") — everything here is low-frequency (fires once per lifecycle
    // event, never on a tick/progress cadence), so it's safe to always leave on.
    instance.on('server-ready', () => wlog('event: server-ready — on-the-fly streaming is available'));
    instance.on('server-retrying', () => wlog('event: server-retrying — attempting to reconnect the streaming Service Worker'));
    instance.on('server-retry-needed', () => console.warn('[WT] event: server-retry-needed — streaming SW could not be (re)connected automatically; user action may be required'));
    instance.on('persistent-storage', (granted: boolean) => wlog('event: persistent-storage granted =', granted));
    instance.on('no-peers', ({ infoHash, type }: { infoHash: string; type: string }) => console.warn('[WT] event: no-peers for', infoHash, '(', type, ') — dead tracker/no seeders/blocked network are the usual causes'));
    instance.on('torrent-done', (snap: TorrentLibSnapshot) => wlog('event: torrent-done —', snap.name, snap.infoHash));
    instance.on('storage-evicted', (evicted: Array<{ infoHash: string; name?: string }>) => console.warn('[WT] event: storage-evicted —', evicted.map(e => e.name || e.infoHash)));
    instance.on('torrents-changed', (list: TorrentLibSnapshot[]) => wlog('event: torrents-changed — now tracking', list.length, 'torrent(s):', list.map(t => `${t.name || t.infoHash}(${t.files?.length ?? 0} files)`)));
    // Re-apply "download whole torrent" selections whenever the torrent list
    // changes — most importantly right after _restoreFromStorage() resumes a
    // previous session's torrents at startup, since that path (inside
    // torrent-lib.js) always re-adds with the library's own default
    // (deselect-everything-until-played) behavior, with no way for it to know
    // this particular hash was previously flagged for a full download.
    instance.on('torrents-changed', () => fullDownloadHashes.forEach(hash => selectAllFiles(hash)));

    // Work around a real bug in torrent-lib.js: _restoreFromStorage() (called
    // from inside init(), see torrent-lib.js#_restoreFromStorage) iterates
    // `state.getList()` and calls `client.add()` for every entry with NO
    // existing-torrent guard (unlike addTorrent(), which does check first).
    // If that persisted list ever contains two entries for the same
    // infoHash — which is exactly what "Cannot add duplicate torrent
    // <hash>" thrown from inside _restoreFromStorage means — every reload
    // trips over it. We fix this at the data source instead of touching
    // torrent-lib.js itself: wrap the instance's own getList() to
    // de-duplicate by infoHash before the library ever reads it.
    const rawGetList = instance.state.getList.bind(instance.state);
    instance.state.getList = () => {
      const seen = new Set<string>();
      const deduped = rawGetList().filter((entry: { infoHash: string }) => {
        if (seen.has(entry.infoHash)) {
          console.warn('[WT] dropping duplicate persisted manifest entry for', entry.infoHash);
          return false;
        }
        seen.add(entry.infoHash);
        return true;
      });
      return deduped;
    };

    wlog('initWebtorrent: calling instance.init() (SW registration + resume)…');
    await instance.init();
    instance.client?.throttleUpload?.(isSeedingEnabled() ? -1 : SEEDING_OFF_UPLOAD_CAP);

    lib = instance;
    // Flush anything registered before we existed — plugin.install() runs at
    // app startup, well before initWebtorrent() is ever lazily triggered by
    // an actual play attempt (see registerWireExtension below).
    if (pendingWireExtensions.length) {
      pendingWireExtensions.forEach(factory => instance.registerWireExtension(factory));
      pendingWireExtensions.length = 0;
    }
    wlog('initWebtorrent: ready. streaming server ready =', instance.serverReady, '— persisted torrents:', instance.state.getList().length);
    return instance;
  })();
  return initPromise;
};

/** Awaits init and returns the instance — internal helper for every export below. */
const ensureLib = (): Promise<TorrentLibrary> => lib ? Promise.resolve(lib) : initWebtorrent();

// ─── Settings: quota + seeding switch ──────────────────────────────────────

export const getMaxStorageBytes = (): number => readNumber(QUOTA_KEY, DEFAULT_QUOTA_BYTES);

export const setMaxStorageBytes = (bytes: number): void => {
  const clamped = Math.max(0, Math.floor(bytes));
  localStorage.setItem(QUOTA_KEY, String(clamped));
  lib?.setStorageQuotaMB(clamped / (1024 * 1024));
};

// Coarse, dependency-free mobile check (no need for anything fancier here —
// worst case on an odd device is just "seeding defaults the desktop way
// until the user picks a value explicitly", which is harmless).
const isMobileDevice = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as any).userAgentData;
  if (uaData && typeof uaData.mobile === 'boolean') return uaData.mobile;
  return /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(navigator.userAgent || '');
};

/**
 * Defaults to OFF on phones (metered data / battery — per user request:
 * "na telefonie seedowanie powinno być domyślnie wyłączone"), ON everywhere
 * else, but only ever as a *default*: once the user has explicitly flipped
 * the switch (in either direction) that saved choice always wins, on any
 * device.
 */
export const isSeedingEnabled = (): boolean => {
  const stored = localStorage.getItem(SEEDING_KEY);
  if (stored === 'on') return true;
  if (stored === 'off') return false;
  return !isMobileDevice();
};

/**
 * Real bug this closes: "seeding off" was implemented as
 * `client.throttleUpload(0)`. In WebTorrent/bittorrent-protocol, the upload
 * throttle limits the connection's ENTIRE outgoing byte pipe, not just
 * piece-data uploads — a rate of exactly 0 chokes literally everything,
 * including the tiny protocol messages (`interested`, `request`, `have`,
 * `bitfield`) a peer needs to send just to ASK for pieces. So "seeding off"
 * didn't just stop uploading to others, it silently stopped downloading
 * too — matching "had to switch seeding on before it would even start
 * downloading" exactly. A few KB/s is still nothing meaningfully seedable
 * (a single piece is commonly hundreds of KB to a few MB, so seeding a
 * whole piece at this rate takes minutes) while leaving more than enough
 * headroom for protocol control traffic to flow immediately.
 */
const SEEDING_OFF_UPLOAD_CAP = 2 * 1024; // 2 KB/s — "no meaningful seeding", not "no traffic at all"

export const setSeedingEnabled = (enabled: boolean): void => {
  localStorage.setItem(SEEDING_KEY, enabled ? 'on' : 'off');
  lib?.client?.throttleUpload?.(enabled ? -1 : SEEDING_OFF_UPLOAD_CAP);
};

// ─── Identity ───────────────────────────────────────────────────────────────

export const parseInfoHash = (magnetURI: string): string | null =>
  TorrentLibrary.extractMagnetInfoHash(magnetURI);

// ─── Loading / lifecycle ───────────────────────────────────────────────────

/**
 * Loads (or returns the already-loaded) torrent for a magnet URI, resolving
 * to a plain snapshot once metadata is available. `title` is accepted only
 * for call-site compatibility with the previous pool — the library names
 * torrents from their own metadata (`torrent.name`), it never needed our
 * title in the first place.
 *
 * torrent-lib.js's own addTorrent() has no timeout: its Promise only
 * resolves once WebTorrent's `client.add()` callback fires, which requires
 * at least one peer to hand over the torrent's metadata (magnet links carry
 * no file list up front). If no peer ever does — dead tracker, no seeders,
 * a firewalled network — that Promise just hangs forever with no error,
 * which looks exactly like "spinner never stops, nothing gets logged,
 * nothing plays." We add a timeout at this call site (NOT inside
 * torrent-lib.js) so that failure mode becomes a visible error instead.
 */
const ADD_TORRENT_TIMEOUT_MS = 45_000;

// ─── In-flight add coalescing ──────────────────────────────────────────────
// Real bug we hit in testing: click Play on torrent A, click Play on torrent
// B, then click back to A — this produced a console "Cannot add duplicate
// torrent <hash>" and the UI just hung (no video, no error surfaced to the
// user). Root cause is a race between two things that can both be trying to
// register the SAME infoHash with the underlying client at once:
//   1) torrent-lib.js's own _restoreFromStorage() (fired once, inside
//      instance.init(), for every torrent persisted from a previous
//      session/click) calling client.add() for a hash, and
//   2) this file's own addTorrent() call for that same hash triggered by the
//      user clicking Play again before #1's callback has fired.
// TorrentLibrary.addTorrent() only guards against a torrent that's already
// FULLY registered (found via client.torrents) — it has no way to know an
// add for the same hash is already *in flight*. When that race is lost, the
// underlying client's duplicate check fires as a client-level 'error' event
// (not a promise rejection!), so it never reaches our try/catch — it just
// looks like the click silently did nothing while the console fills with
// "[WT] client-level error: Cannot add duplicate torrent …".
// We fix this AT THIS LAYER (not inside torrent-lib.js) by keeping our own
// map of in-flight adds per infoHash: any getOrAddTorrent() call for a hash
// that's already being added (by us OR, once #1 above resolves, correctly
// long-since finished) waits on that same promise instead of ever calling
// addTorrent() a second time. As a belt-and-braces fallback, if the
// duplicate error still slips through (e.g. it came from the OTHER add
// attempt, not this one), we recover by reading back the now-live torrent
// instead of surfacing an unrecoverable error to the player.
const pendingAdds = new Map<string, Promise<TorrentLibSnapshot>>();

export const getOrAddTorrent = async (magnetURI: string, _title?: string): Promise<TorrentLibSnapshot> => {
  const instance = await ensureLib();
  const knownHash = TorrentLibrary.extractMagnetInfoHash(magnetURI);
  wlog('getOrAddTorrent: requesting metadata for', magnetURI.slice(0, 90), '· infoHash =', knownHash);

  // Fast path: already fully loaded (covers "click back to a torrent we
  // already played this session", the exact case that used to throw).
  if (knownHash) {
    const already = instance.getTorrent(knownHash);
    if (already && already.files?.length) {
      wlog('getOrAddTorrent: already loaded, returning live snapshot —', already.name, '·', already.files.length, 'file(s)');
      return already;
    }
  }

  // Coalesce: if there's already an add in flight for this exact hash
  // (whether kicked off by us a moment ago, or logically still-settling from
  // startup's _restoreFromStorage), piggyback on that instead of calling
  // addTorrent() again.
  if (knownHash && pendingAdds.has(knownHash)) {
    wlog('getOrAddTorrent: add already in flight for', knownHash, '— waiting on it instead of re-adding');
    return pendingAdds.get(knownHash)!;
  }

  // Offline-first metadata: torrent-lib.js's own _restoreFromStorage() (run
  // once at startup) already prefers a cached .torrent metadata buffer over
  // the bare magnet URI when one exists (see its cacheTorrentMeta/
  // getCachedTorrentMeta calls) — but the public addTorrent() method THIS
  // function calls does not: it always adds via the raw magnet, which needs
  // at least one live peer to hand over the file list before anything can
  // play. That's a real gap for a torrent we've already fully cached the
  // metadata for in an earlier session (e.g. replaying it from the Settings
  // "stored torrents" list, or — the actual point of caching this at all —
  // a future offline-capable mobile app that may have no network at play
  // time). Fix it at this layer instead of touching torrent-lib.js: if we
  // already have this hash's metadata cached, pass that buffer through
  // instead of the magnet, so no peer/tracker round-trip is needed at all.
  const cachedMeta = knownHash ? instance.state.getCachedTorrentMeta(knownHash) : null;
  const torrentId = cachedMeta || magnetURI;
  if (cachedMeta) wlog('getOrAddTorrent: using cached .torrent metadata for', knownHash, '— no network needed to resolve the file list');

  const attempt = (async (): Promise<TorrentLibSnapshot> => {
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(
        `Timed out after ${ADD_TORRENT_TIMEOUT_MS / 1000}s waiting for torrent metadata — no peer sent it (dead tracker, no seeders, or a blocked network).`,
      )), ADD_TORRENT_TIMEOUT_MS);
    });

    // Real bug this closes: TorrentLibrary.addTorrent()'s Promise only ever
    // *resolves*, via client.add()'s success callback — a client-level
    // 'error' (e.g. exactly the "Cannot add duplicate torrent <hash>" race
    // described above) is only ever emitted as an 'error' EVENT on the
    // shared client (see initWebtorrent()'s `instance.on('error', ...)`),
    // never as a rejection of THIS specific addTorrent() call. Previously
    // that meant this attempt just sat there for the full 45s timeout
    // before the /duplicate/i recovery below could ever run — which, from
    // the user's side, looked exactly like "clicking a different torrent
    // just hangs" even though it would have quietly recovered eventually.
    // Listening for the client's error event here and settling THIS
    // attempt immediately (instead of only logging it) makes the existing
    // duplicate-recovery loop below actually reachable in well under a
    // second instead of ~45s.
    let earlyReject: ((err: Error) => void) | null = null;
    const earlyError = new Promise<never>((_, reject) => { earlyReject = reject; });
    const onClientError = (err: Error): void => {
      const msg = err instanceof Error ? err.message : String(err);
      if (knownHash && msg.toLowerCase().includes(knownHash.toLowerCase())) {
        earlyReject?.(err instanceof Error ? err : new Error(msg));
      }
    };
    instance.on('error', onClientError);

    try {
      const snap = await Promise.race([instance.addTorrent(torrentId), timeout, earlyError]);
      wlog('getOrAddTorrent: metadata received —', snap.name, '·', snap.files.length, 'file(s) ·', snap.infoHash);
      return snap;
    } catch (err) {
      // Recovery path for the exact race described above: if the client
      // rejected/threw because of a duplicate, the torrent is (or is about
      // to be) live under the client anyway — hand back its snapshot
      // instead of propagating a scary, unrecoverable error.
      const msg = err instanceof Error ? err.message : String(err);
      if (knownHash && /duplicate/i.test(msg)) {
        wlog('getOrAddTorrent: caught a duplicate-add race for', knownHash, '— recovering by reading the live torrent instead of failing');
        for (let i = 0; i < 10; i++) {
          const live = instance.getTorrent(knownHash);
          if (live && live.files?.length) {
            wlog('getOrAddTorrent: recovered snapshot for', knownHash, 'after duplicate-add race —', live.name);
            return live;
          }
          await new Promise(r => setTimeout(r, 300));
        }
      }
      console.error('[WT] getOrAddTorrent: failed for', knownHash, '—', msg);
      throw err;
    } finally {
      clearTimeout(timeoutHandle!);
      instance.off('error', onClientError);
    }
  })();

  if (knownHash) {
    pendingAdds.set(knownHash, attempt);
    attempt.finally(() => {
      if (pendingAdds.get(knownHash) === attempt) pendingAdds.delete(knownHash);
    });
  }
  return attempt;
};

export const getTorrent = (infoHash: string): TorrentLibSnapshot | null => lib ? lib.getTorrent(infoHash) : null;
export const getTorrents = (): TorrentLibSnapshot[] => lib ? lib.getTorrents() : [];

/**
 * Back-compat name for getTorrent(): a FRESH plain snapshot every call (not
 * a live mutable object) — important for Vue prop change-detection in
 * WebtorrentVideo.vue, see that component's comment on why a mutated-in-place
 * object wouldn't trigger a re-render of its child.
 */
export const getActiveTorrent = (infoHash: string): TorrentLibSnapshot | null => getTorrent(infoHash);

export const removeTorrent = (infoHash: string): void => lib?.removeTorrent(infoHash);
export const copyMagnetURI = (infoHash: string): string | null => lib?.copyMagnetURI(infoHash) ?? null;

// ─── Streaming server ───────────────────────────────────────────────────────

export const isStreamingServerReady = (): boolean => lib?.serverReady ?? false;

/** Resolves once init() has settled one way or the other (never rejects) — mirrors the old pool's contract used by player.ts. */
export const waitForStreamingServer = async (): Promise<boolean> => {
  try {
    const instance = await ensureLib();
    return instance.serverReady;
  } catch {
    return false;
  }
};

export const retryServiceWorker = (): Promise<boolean> => lib?.retryServiceWorker() ?? Promise.resolve(false);

// ─── Playback ───────────────────────────────────────────────────────────────

/**
 * Starts playback of a specific file into `videoEl`, using the library's
 * position-aware download window (PlaybackBuffer in torrent-lib.js). This
 * replaces the previous file.renderTo()/manual-blob-fallback dance entirely
 * — the library decides streaming-vs-full-download-blob internally and
 * wires videoEl.src accordingly.
 */
export const attachPlayback = (
  infoHash: string, fileIndex: number, videoEl: HTMLVideoElement,
  opts: { lookaheadSec?: number; behindSec?: number } = {},
): TorrentLibPlaybackHandle => {
  if (!lib) throw new Error('[webtorrent-pool] attachPlayback called before initWebtorrent() resolved');
  // shouldKeepFull is checked LIVE (a function, not a one-time snapshot) by
  // torrent-lib.js's PlaybackBuffer, so toggling "download whole torrent" on
  // or off mid-playback takes effect immediately — see torrent-lib.js's
  // PlaybackBuffer._recalc() for why this is needed at all: without it, the
  // buffer's own per-second "deselect everything outside the ~1min window"
  // housekeeping was undoing the full-download selection below on every
  // tick, so a "full download" only ever actually kept ~1 minute ahead of
  // playback instead of grabbing the whole file in the background.
  const handle = lib.attachPlayback(infoHash, fileIndex, videoEl, {
    ...opts,
    shouldKeepFull: () => fullDownloadHashes.has(infoHash),
  });
  // attachPlayback() (inside torrent-lib.js) always deselects every other
  // file before setting up its own lookahead window for the active one —
  // if the user asked us to download this torrent in full, re-widen the
  // selection back out to everything right after.
  if (fullDownloadHashes.has(infoHash)) selectAllFiles(infoHash);
  return handle;
};

export const detachPlayback = (): void => lib?.detachPlayback();

/**
 * Alternate audio track (lektor/dub file) playing alongside the main video.
 * Thin pass-through to torrent-lib.js's own attachExtraAudio — the sync
 * (offset, play/pause/seek mirroring) and the two independent volume
 * knobs all live there; see its own comment for why this selects the whole
 * file once instead of using a windowed buffer like the main video does.
 */
export const attachExtraAudio = (
  infoHash: string, fileIndex: number,
  opts: { mode?: 'lektor' | 'dub'; origVolume?: number; trackVolume?: number; offsetMs?: number } = {},
): TorrentLibExtraAudioHandle => {
  if (!lib) throw new Error('[webtorrent-pool] attachExtraAudio called before initWebtorrent() resolved');
  return lib.attachExtraAudio(infoHash, fileIndex, opts);
};

export const detachExtraAudio = (): void => lib?.detachExtraAudio();

/**
 * Generic plugin hook into the raw peer-wire protocol (BEP-10 / bittorrent-
 * protocol extensions) — see torrent-lib.js's own registerWireExtension for
 * the exact factory shape. This module has no idea what any given
 * extension does; it just forwards the registration.
 *
 * Real gotcha this avoids: plugins call this from their install(player)
 * hook, which runs at app startup — long before initWebtorrent() is ever
 * lazily triggered by an actual play attempt (`lib` is null until then, see
 * the rest of this file). Dropping the registration in that case would mean
 * it silently never took effect. Queue it instead; initWebtorrent() flushes
 * the queue once `lib` actually exists.
 */
const pendingWireExtensions: Array<(wire: any) => any> = [];

export const registerWireExtension = (factory: (wire: any) => any): void => {
  if (lib) {
    lib.registerWireExtension(factory);
  } else {
    pendingWireExtensions.push(factory);
  }
};

/**
 * "Download whole torrent" — selects every file's pieces, not just the
 * lookahead window around whatever's currently playing, so the torrent ends
 * up fully present in local IndexedDB storage and can be played back later
 * with zero network at all (offline, airplane mode, a future standalone
 * mobile app, etc). Persisted across reloads via fullDownloadHashes/
 * FULL_DOWNLOAD_KEY, and re-applied automatically after every
 * torrents-changed event (see initWebtorrent above) and every
 * attachPlayback() call, since both of those otherwise narrow the selection
 * back down to just the active file's streaming window.
 */
export const downloadEntireTorrent = (infoHash: string): void => {
  fullDownloadHashes.add(infoHash);
  saveFullDownloadHashes();
  selectAllFiles(infoHash);
};

/** Stops expanding the download beyond what's needed to stream — doesn't discard any pieces already saved. */
export const cancelFullDownload = (infoHash: string): void => {
  fullDownloadHashes.delete(infoHash);
  saveFullDownloadHashes();
};

export const isFullDownload = (infoHash: string): boolean => fullDownloadHashes.has(infoHash);

/**
 * Deselects the actively-downloading file while leaving the torrent fully
 * connected and seedable — "stop pulling new pieces, keep sharing what we
 * have." `infoHash` is kept only for call-site compatibility (only one file
 * plays at a time, so there's nothing to disambiguate).
 */
export const pauseDownload = (_infoHash: string): void => { lib?.detachPlayback(); };

/** No-op with the new engine: playback resumes normally via the next attachPlayback() call. Kept for call-site compatibility. */
export const resumeDownload = (_infoHash: string): void => { /* intentionally empty, see comment above */ };

export const markActive = (infoHash: string): void => {
  const snap = getTorrent(infoHash);
  lib?.quota.touch(infoHash, snap?.name);
};

/** No-op: the library already protects whichever file is actively attached from quota eviction (torrent-lib.js#_enforceQuota only ever evicts non-active hashes). Kept for call-site compatibility. */
export const protectFromEviction = (_infoHash: string | null): void => { /* intentionally empty, see comment above */ };

// ─── Piece map / progress bar (new — powers the "downloaded/to-download" bar) ─

export const getFilePieceMap = (infoHash: string, fileIndex: number, buckets = 150): TorrentLibPieceMap | null =>
  lib ? lib.getFilePieceMap(infoHash, fileIndex, buckets) : null;

export const getTorrentPieceMap = (infoHash: string, buckets = 150): TorrentLibPieceMap | null =>
  lib ? lib.getTorrentPieceMap(infoHash, buckets) : null;

// ─── Subtitles (delegates entirely to the library's format detection +
// SRT/VTT/ASS/SSA/SUB/SBV/SAMI → WebVTT conversion + language guess) ────────

export const getSubtitleTrack = (infoHash: string, fileIndex: number): Promise<TorrentLibSubtitleTrack> => {
  if (!lib) return Promise.reject(new Error('[webtorrent-pool] WebTorrent not initialized yet'));
  return lib.getSubtitleTrack(infoHash, fileIndex);
};

// ─── Downloads ──────────────────────────────────────────────────────────────

export const downloadFileBlob = (infoHash: string, fileIndex: number): Promise<{ blob: Blob; url: string; name: string }> => {
  if (!lib) return Promise.reject(new Error('[webtorrent-pool] WebTorrent not initialized yet'));
  return lib.downloadFileBlob(infoHash, fileIndex);
};

// ─── Stats / manifest (settings modal + BFPlayerAPI) ──────────────────────

/** Everything currently persisted (on disk), for a "what am I seeding" settings view. */
export const getManifest = (): SeedManifestEntry[] => {
  if (!lib) return [];
  const list: Array<{ infoHash: string; magnetURI: string; name?: string; length?: number; addedAt?: number }> = lib.state.getList();
  return list.map(e => {
    const live = lib!.getTorrent(e.infoHash);
    return {
      infoHash: e.infoHash,
      magnetURI: e.magnetURI,
      title: e.name || e.infoHash,
      sizeBytes: e.length || 0,
      lastActiveAt: e.addedAt || 0,
      progress: live?.progress ?? 0,
      done: live?.done ?? false,
      fullDownload: fullDownloadHashes.has(e.infoHash),
    };
  });
};

/** Actual on-disk usage per the library's own QuotaManager bookkeeping (more accurate than summing manifest sizeBytes, since that's the whole-torrent length, not bytes actually written to IndexedDB yet). */
export const getManifestUsageBytes = async (): Promise<number> => {
  if (!lib) return 0;
  const usage = await lib.getStorageUsage();
  return usage.usedBytes;
};

/** Lifetime upload/download totals, per torrent and overall — read from the library's own per-torrent persisted stats. */
export const getStats = (): WebtorrentStats => {
  const manifest = getManifest();
  const perTorrent: Record<string, TorrentStatsEntry> = {};
  let totalDownloaded = 0;
  let totalUploaded = 0;
  for (const entry of manifest) {
    const snap = getTorrent(entry.infoHash);
    const downloaded = snap?.allTime?.downloaded ?? 0;
    const uploaded = snap?.allTime?.uploaded ?? 0;
    perTorrent[entry.infoHash] = { title: entry.title, downloaded, uploaded };
    totalDownloaded += downloaded;
    totalUploaded += uploaded;
  }
  return { totalDownloaded, totalUploaded, perTorrent };
};

/** Browser-level context (not just our own usage) for a settings UI, e.g. "12 GB free". */
export const getStorageEstimate = async (): Promise<{ usage: number; quota: number } | null> => {
  const storage = (navigator as { storage?: StorageManager }).storage;
  if (!storage?.estimate) return null;
  const { usage, quota } = await storage.estimate();
  return { usage: usage || 0, quota: quota || 0 };
};

/** Deletes everything we've ever seeded — for a "clear my seed data" privacy control. */
export const clearAllSeedData = async (): Promise<void> => {
  if (!lib) return;
  for (const entry of getManifest()) lib.removeTorrent(entry.infoHash);
};

// ─── Global stats / events (new — for a live "total speed / peers" readout) ─

export const getGlobalStats = () => lib?.getGlobalStats() ?? {
  downloadSpeed: 0, uploadSpeed: 0, numPeers: 0, activeTorrents: 0,
  allTimeDownloaded: 0, allTimeUploaded: 0, totalTorrents: 0,
};

/**
 * Forwards to the library's own event emitter (torrents-changed,
 * torrent-stats, global-tick, buffer-window, range-requested, torrent-done,
 * torrent-error, warning, error, storage-evicted, server-ready,
 * server-retrying, server-retry-needed). Only call after initWebtorrent()
 * has resolved (or from inside a component that's guaranteed to mount after
 * a webtorrent track has already triggered init) — events fired before the
 * instance exists aren't queued.
 */
export const on = (evt: string, fn: (...args: any[]) => void): (() => void) => {
  if (!lib) { console.warn('[webtorrent-pool] on() called before init — listener not attached:', evt); return () => {}; }
  return lib.on(evt, fn);
};
export const off = (evt: string, fn: (...args: any[]) => void): void => lib?.off(evt, fn);