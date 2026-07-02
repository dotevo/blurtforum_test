/**
 * modules/player/webtorrent-pool.ts
 *
 * Manages a single, page-lifetime WebTorrent client shared by every
 * 'webtorrent' track. Responsibilities:
 *
 *  - Persistent storage per torrent (IndexedDB via indexeddb-chunk-store),
 *    so already-downloaded pieces survive a page reload and are immediately
 *    seedable again, without redownloading anything.
 *  - A user-configurable storage budget (bytes) with LRU eviction — when
 *    adding data would exceed the budget, the least-recently-active torrent
 *    is fully deleted (both the live torrent, if loaded, and its IndexedDB
 *    store) until we're back under budget.
 *  - A global seeding on/off switch (client.throttleUpload), e.g. for
 *    disabling upload on mobile/metered connections.
 *  - Lifetime transfer stats (bytes uploaded/downloaded, total and per
 *    torrent) that survive both individual torrents being evicted and the
 *    page reloading — torrent.uploaded/downloaded reset whenever a new
 *    Torrent JS object is created, so we track deltas into localStorage.
 *
 * Lazy-loaded: webtorrent and indexeddb-chunk-store are only dynamically
 * imported once a 'webtorrent' track is actually encountered, so nobody
 * who doesn't use this feature pays for it in bundle size.
 *
 * WEBTORRENT VERSION NOTE (upgraded 1.x -> 3.x):
 * As of WebTorrent 2.0, in-browser playback via `file.renderTo()` (the old
 * MediaSource-based renderer) was REMOVED. Its replacement, `file.streamTo()`
 * (used in player.ts), works completely differently: it doesn't attach a
 * MediaSource to the video element directly — it points the element's `src`
 * at a URL served by an in-browser HTTP server that WebTorrent runs through
 * a Service Worker. That means a Service Worker registration +
 * `client.createServer(...)` are no longer optional — they're a hard
 * prerequisite for playback in 2.x/3.x. See `initWebtorrent()` below.
 *
 * The Service Worker script (`sw.min.js`) ships inside the `webtorrent`
 * package itself (`node_modules/webtorrent/dist/sw.min.js`). With Vite,
 * don't hand-copy it — use `vite-plugin-static-copy` (see vite.config.ts)
 * so it's re-copied from node_modules on every build and never goes stale
 * relative to whatever webtorrent version is actually installed.
 *
 * No knowledge of Blurt or identity lives here — "only talk to peers who
 * can sign with a Blurt account" is a future plugin (player-blurt-seed)
 * layered on top of this, not something this module does.
 */

// ─── Debug logging ──────────────────────────────────────────────────────────
// Mobile remote-debug consoles (vConsole/eruda etc.) often JSON.stringify
// console args, which collapses Error objects to "{}" (message/stack are
// non-enumerable). So we always log a plain-string description alongside
// the raw object, and log every stage of the load so a stuck/failed load
// is diagnosable from the console alone.
const WT_DEBUG = true; // flip to false to silence
const wlog = (...args: unknown[]): void => { if (WT_DEBUG) console.log('[WT]', ...args); };
const describeError = (e: unknown): string => {
  if (e instanceof Error) return `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ''}`;
  try { return JSON.stringify(e); } catch { return String(e); }
};

// ─── localStorage keys & defaults ──────────────────────────────────────────

const MANIFEST_KEY = 'bf-player-wt-manifest';
const QUOTA_KEY = 'bf-player-wt-quota';
const SEEDING_KEY = 'bf-player-wt-seeding';
const STATS_KEY = 'bf-player-wt-stats';

const DEFAULT_QUOTA_BYTES = 500 * 1024 * 1024; // 500 MB
const QUOTA_HEADROOM = 0.9; // evict down to 90% of budget, not right up to the edge
const STATS_FLUSH_INTERVAL_MS = 30_000;
/** How long we wait for torrent metadata (peers/trackers) before giving up with a clear error. */
const METADATA_TIMEOUT_MS = 30_000;

/**
 * Path the WebTorrent Service Worker is registered at, and the scope it's
 * registered with. MUST be derived from the app's actual base path
 * (Vite's `import.meta.env.BASE_URL`), not hardcoded to '/':
 *  - `base: './'` (relative, used for local/file-based serving) resolves
 *    relative to the *current document's* URL, not the site root.
 *  - GitHub Pages deploys under `/repo-name/`, set via `VITE_BASE` in CI —
 *    a Service Worker can only be registered with a scope at or below the
 *    path of the script itself, so `scope: '/'` from a page served at
 *    `/repo-name/` would be rejected by the browser outright.
 * Both cases are covered by just reusing whatever base Vite already
 * computed for every other asset.
 */
const SW_PATH = `${import.meta.env.BASE_URL}sw.min.js`;
const SW_SCOPE = import.meta.env.BASE_URL;
/** How long we wait for the Service Worker to activate before giving up on streaming. */
const SW_ACTIVATION_TIMEOUT_MS = 15_000;

export interface SeedManifestEntry {
  infoHash: string;
  magnetURI: string;
  title: string;
  sizeBytes: number;
  lastActiveAt: number;
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

const readJSON = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const writeJSON = (key: string, value: unknown): void => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full/unavailable, best effort */ }
};

const readManifest = (): SeedManifestEntry[] => readJSON(MANIFEST_KEY, []);
const writeManifest = (entries: SeedManifestEntry[]): void => writeJSON(MANIFEST_KEY, entries);

const readStats = (): WebtorrentStats => readJSON(STATS_KEY, { totalUploaded: 0, totalDownloaded: 0, perTorrent: {} });
const writeStats = (stats: WebtorrentStats): void => writeJSON(STATS_KEY, stats);

// ─── Settings: quota + seeding switch ──────────────────────────────────────

export const getMaxStorageBytes = (): number => {
  const raw = Number(localStorage.getItem(QUOTA_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_QUOTA_BYTES;
};

export const setMaxStorageBytes = (bytes: number): void => {
  localStorage.setItem(QUOTA_KEY, String(Math.max(0, Math.floor(bytes))));
  void enforceQuota();
};

export const isSeedingEnabled = (): boolean => localStorage.getItem(SEEDING_KEY) !== 'off';

export const setSeedingEnabled = (enabled: boolean): void => {
  localStorage.setItem(SEEDING_KEY, enabled ? 'on' : 'off');
  client?.throttleUpload(enabled ? -1 : 0);
};

// ─── Client + active torrents ──────────────────────────────────────────────

let client: any = null;
let IdbChunkStore: any = null;
let initPromise: Promise<void> | null = null;
/** True once client.createServer() has succeeded — file.streamTo() will throw/no-op before this. */
let streamServerReady = false;
export const isStreamServerReady = (): boolean => streamServerReady;
const active = new Map<string, { torrent: any; title: string }>(); // infoHash -> live torrent
const statsBaseline = new Map<string, { uploaded: number; downloaded: number }>();
let protectedInfoHash: string | null = null;
let statsFlushTimer: ReturnType<typeof setInterval> | null = null;

/** Never evicted by quota enforcement — call with the currently-loaded track's infoHash, or null. */
export const protectFromEviction = (infoHash: string | null): void => { protectedInfoHash = infoHash; };

/** Bumps lastActiveAt without changing size — call when a track starts playing. */
export const markActive = (infoHash: string): void => {
  const manifest = readManifest();
  const idx = manifest.findIndex(e => e.infoHash === infoHash);
  if (idx >= 0) {
    manifest[idx] = { ...manifest[idx], lastActiveAt: Date.now() };
    writeManifest(manifest);
  }
};

const parseInfoHash = (magnetURI: string): string | null => {
  const m = magnetURI.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
  return m ? m[1].toLowerCase() : null;
};

const touchManifestEntry = (infoHash: string, magnetURI: string, title: string, sizeBytes?: number): void => {
  const manifest = readManifest();
  const idx = manifest.findIndex(e => e.infoHash === infoHash);
  const entry: SeedManifestEntry = {
    infoHash,
    magnetURI,
    title,
    sizeBytes: sizeBytes ?? manifest[idx]?.sizeBytes ?? 0,
    lastActiveAt: Date.now(),
  };
  if (idx >= 0) manifest[idx] = entry; else manifest.push(entry);
  writeManifest(manifest);
};

const makeStoreFactory = (infoHash: string) => (chunkLength: number, opts: any) =>
  new IdbChunkStore(chunkLength, { ...opts, name: `bfp-wt-${infoHash}` });

const wireTorrentTracking = (torrent: any, infoHash: string, title: string): void => {
  statsBaseline.set(infoHash, { uploaded: 0, downloaded: 0 });
  torrent.on('download', () => touchManifestEntry(infoHash, torrent.magnetURI, title, torrent.length));
  torrent.on('error', (err: Error) => console.warn('[webtorrent-pool] torrent error', infoHash, err));
};

/**
 * Registers the WebTorrent Service Worker and starts client.createServer()
 * against it. Required once per page load before any file.streamTo() call
 * will work (see WEBTORRENT VERSION NOTE at the top of this file).
 * Non-fatal on failure: we log clearly and leave streamServerReady false,
 * so callers can surface a real error instead of a silently-stuck spinner.
 */
const setUpStreamServer = async (): Promise<void> => {
  if (streamServerReady) return;
  if (!('serviceWorker' in navigator)) {
    wlog('setUpStreamServer: navigator.serviceWorker unavailable — streaming will not work (unsupported browser or non-HTTPS origin)');
    return;
  }
  try {
    wlog('setUpStreamServer: registering', SW_PATH, 'with scope', SW_SCOPE, '…');
    await navigator.serviceWorker.register(SW_PATH, { scope: SW_SCOPE });
    const registration = await navigator.serviceWorker.ready;
    const sw = registration.active || registration.installing || registration.waiting;

    if (!sw) throw new Error('Service worker registration has no worker (active/installing/waiting all null)');

    await (sw.state === 'activated' ? Promise.resolve() : new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Service worker did not activate within ${SW_ACTIVATION_TIMEOUT_MS / 1000}s`)), SW_ACTIVATION_TIMEOUT_MS);
      sw.addEventListener('statechange', () => {
        if (sw.state === 'activated') { clearTimeout(timeout); resolve(); }
      });
    }));

    wlog('setUpStreamServer: service worker activated, calling client.createServer()…');
    client.createServer({ controller: registration });
    streamServerReady = true;
    wlog('setUpStreamServer: stream server ready.');
  } catch (e) {
    console.error('[WT] setUpStreamServer: FAILED —', describeError(e), '— webtorrent playback will not work until this is fixed. ' +
      `Check that ${SW_PATH} is actually deployed and served over HTTPS (or localhost).`);
  }
};

/** Ensures the shared client exists, requests durable storage, resumes anything already on disk. */
export const initWebtorrent = (): Promise<void> => {
  if (initPromise) return initPromise;
  wlog('initWebtorrent: starting…');
  initPromise = (async () => {
    try {
      wlog('initWebtorrent: importing webtorrent + indexeddb-chunk-store modules…');
      const [wtMod, idbMod] = await Promise.all([import('webtorrent'), import('indexeddb-chunk-store')]);
      const WebTorrentCtor = (wtMod as any).default || wtMod;
      IdbChunkStore = (idbMod as any).default || idbMod;
      wlog('initWebtorrent: modules loaded, constructing client…');

      client = new WebTorrentCtor();

      // Without this, an 'error' emitted on the client itself (as opposed to
      // a specific torrent) is unhandled and — depending on the EventEmitter
      // polyfill in play — can surface as an opaque, hard-to-trace uncaught
      // exception rather than something we can log with context.
      client.on('error', (err: Error) => {
        console.error('[WT] client-level error:', describeError(err), err);
      });
      client.on('warning', (err: Error) => {
        console.warn('[WT] client-level warning:', describeError(err), err);
      });

      client.throttleUpload(isSeedingEnabled() ? -1 : 0);
      wlog('initWebtorrent: client ready. WebRTC support:', typeof RTCPeerConnection !== 'undefined', 'client._debugId:', client._debugId);

      // WebTorrent >=2.0 requires an in-browser HTTP server (backed by a
      // Service Worker) for playback: file.streamTo() just points the
      // <video> element at a URL this server generates. Without this,
      // streamTo() has nothing to stream and playback silently never
      // starts. This is new since 1.x, where renderTo() didn't need it.
      await setUpStreamServer();

      if ((navigator as any).storage?.persist) {
        try {
          const persisted = await (navigator as any).storage.persist();
          wlog('initWebtorrent: storage.persist() ->', persisted);
        } catch (e) { wlog('initWebtorrent: storage.persist() failed (non-fatal):', describeError(e)); }
      }

      // Resume everything already on disk so it's immediately seedable again,
      // without the user needing to open it — this is the whole point of
      // persisting in the first place.
      const manifest = readManifest();
      wlog('initWebtorrent: resuming', manifest.length, 'persisted torrent(s)…');
      await Promise.all(manifest.map(entry => resumeEntry(entry).catch(e =>
        console.warn('[webtorrent-pool] resume failed for', entry.infoHash, describeError(e))
      )));

      statsFlushTimer = setInterval(flushStats, STATS_FLUSH_INTERVAL_MS);
      window.addEventListener('beforeunload', flushStats);
      wlog('initWebtorrent: done.');
    } catch (e) {
      console.error('[WT] initWebtorrent: FAILED —', describeError(e));
      throw e;
    }
  })();
  return initPromise;
};

/** Stops the periodic stats flush and the beforeunload hook. Safe to call even if init never ran. */
export const destroyWebtorrentPool = (): void => {
  if (statsFlushTimer) { clearInterval(statsFlushTimer); statsFlushTimer = null; }
  window.removeEventListener('beforeunload', flushStats);
  flushStats();
};

const resumeEntry = (entry: SeedManifestEntry): Promise<void> => {
  if (active.has(entry.infoHash)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const torrent = client.add(
      entry.magnetURI,
      { store: makeStoreFactory(entry.infoHash), destroyStoreOnDestroy: true },
      (t: any) => {
        active.set(entry.infoHash, { torrent: t, title: entry.title });
        wireTorrentTracking(t, entry.infoHash, entry.title);
        resolve();
      }
    );
    torrent.on('error', () => resolve()); // one bad resume shouldn't block the rest
  });
};

/**
 * Loads (or returns the already-loaded) torrent for a magnet URI. Resolves
 * once metadata is available and torrent.files is populated.
 */
export const getOrAddTorrent = async (magnetURI: string, title: string): Promise<any> => {
  await initWebtorrent();

  const infoHash = parseInfoHash(magnetURI);
  if (!infoHash) throw new Error('[webtorrent-pool] magnet URI has no btih, cannot identify torrent');

  const existing = active.get(infoHash);
  if (existing) {
    wlog('getOrAddTorrent: already active, reusing:', infoHash);
    touchManifestEntry(infoHash, magnetURI, title, existing.torrent.length);
    return existing.torrent;
  }

  wlog('getOrAddTorrent: adding new torrent, infoHash =', infoHash);

  return new Promise((resolve, reject) => {
    let settled = false;
    let progressTimer: ReturnType<typeof setInterval> | null = null;

    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (progressTimer) clearInterval(progressTimer);
      const numPeers = torrent?.numPeers ?? 0;
      const msg = `Timed out after ${METADATA_TIMEOUT_MS / 1000}s waiting for torrent metadata ` +
        `(peers found: ${numPeers}). Trackers likely unreachable from this network — ` +
        `check that WebSocket trackers (wss://…) aren't blocked, and that at least one ` +
        `webseed (ws=) or reachable wss tracker is present in the magnet.`;
      console.error('[WT]', msg);
      reject(new Error(msg));
    }, METADATA_TIMEOUT_MS);

    const torrent = client.add(
      magnetURI,
      { store: makeStoreFactory(infoHash), destroyStoreOnDestroy: true },
      (t: any) => {
        wlog('getOrAddTorrent: metadata ready. files:', t.files?.map((f: any) => f.name), 'length:', t.length, 'numPeers:', t.numPeers);
        if (settled) { wlog('getOrAddTorrent: ready fired after settle (timeout/error already happened) — ignoring'); return; }
        settled = true;
        clearTimeout(timeoutTimer);
        if (progressTimer) clearInterval(progressTimer);
        active.set(infoHash, { torrent: t, title });
        wireTorrentTracking(t, infoHash, title);
        touchManifestEntry(infoHash, magnetURI, title, t.length);
        void enforceQuota();
        resolve(t);
      }
    );

    wlog('getOrAddTorrent: client.add() called, infoHash on torrent object:', torrent.infoHash);

    torrent.on('error', (err: Error) => {
      console.error('[WT] torrent error for', infoHash, '—', describeError(err));
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (progressTimer) clearInterval(progressTimer);
      reject(err);
    });
    torrent.on('warning', (err: Error) => {
      console.warn('[WT] torrent warning for', infoHash, '—', describeError(err));
    });
    torrent.on('infoHash', () => wlog('getOrAddTorrent: infoHash event, discovery starting'));
    torrent.on('metadata', () => wlog('getOrAddTorrent: metadata event (got .torrent info from peers/ut_metadata)'));
    torrent.on('wire', (wire: any) => wlog('getOrAddTorrent: peer connected via', wire.type || 'unknown transport', '- total peers now', torrent.numPeers));
    torrent.on('noPeers', (announceType: string) => wlog('getOrAddTorrent: noPeers from', announceType, '- still trying other sources'));

    // Periodic heartbeat while we wait, so a stuck load is visible in real
    // time rather than only at the 30s timeout.
    progressTimer = setInterval(() => {
      wlog('getOrAddTorrent: still waiting… numPeers =', torrent.numPeers, 'ready =', torrent.ready, 'discovery =', !!torrent.discovery);
    }, 5000);
  });
};

// ─── Quota enforcement (LRU) ────────────────────────────────────────────────

const destroyTorrentData = (infoHash: string): Promise<void> => {
  const entry = active.get(infoHash);
  active.delete(infoHash);
  statsBaseline.delete(infoHash);

  const cleanup = entry
    ? new Promise<void>(resolve => entry.torrent.destroy(() => resolve())) // destroyStoreOnDestroy wipes IndexedDB too
    : new Promise<void>(resolve => {
        const req = indexedDB.deleteDatabase(`bfp-wt-${infoHash}`);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });

  return cleanup.then(() => {
    writeManifest(readManifest().filter(e => e.infoHash !== infoHash));
    const stats = readStats();
    delete stats.perTorrent[infoHash];
    writeStats(stats);
  });
};

const enforceQuota = async (): Promise<void> => {
  const budget = getMaxStorageBytes();
  const target = budget * QUOTA_HEADROOM;
  let manifest = readManifest()
    .filter(e => e.infoHash !== protectedInfoHash)
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt); // oldest-active first

  let total = readManifest().reduce((sum, e) => sum + e.sizeBytes, 0);

  while (total > target && manifest.length > 0) {
    const victim = manifest.shift()!;
    await destroyTorrentData(victim.infoHash);
    total -= victim.sizeBytes;
  }
};

/** Deletes everything we've ever seeded — for a "clear my seed data" privacy control. */
export const clearAllSeedData = async (): Promise<void> => {
  const manifest = readManifest();
  await Promise.all(manifest.map(e => destroyTorrentData(e.infoHash)));
  writeManifest([]);
};

// ─── Stats ──────────────────────────────────────────────────────────────────

const flushStats = (): void => {
  const stats = readStats();
  for (const [infoHash, { torrent, title }] of active) {
    const baseline = statsBaseline.get(infoHash) || { uploaded: 0, downloaded: 0 };
    const deltaUp = Math.max(0, torrent.uploaded - baseline.uploaded);
    const deltaDown = Math.max(0, torrent.downloaded - baseline.downloaded);

    const prev = stats.perTorrent[infoHash] || { title, uploaded: 0, downloaded: 0 };
    stats.perTorrent[infoHash] = { title, uploaded: prev.uploaded + deltaUp, downloaded: prev.downloaded + deltaDown };
    stats.totalUploaded += deltaUp;
    stats.totalDownloaded += deltaDown;

    statsBaseline.set(infoHash, { uploaded: torrent.uploaded, downloaded: torrent.downloaded });
  }
  writeStats(stats);
};

/** Lifetime stats (survive reloads and individual torrents being evicted). */
export const getStats = (): WebtorrentStats => {
  flushStats(); // don't make the caller wait up to 30s for fresh numbers
  return readStats();
};

// ─── Introspection ──────────────────────────────────────────────────────────

export const getManifest = (): SeedManifestEntry[] => readManifest();

export const getManifestUsageBytes = (): number =>
  readManifest().reduce((sum, e) => sum + e.sizeBytes, 0);

/** Browser-level context (not just our own usage) for a settings UI, e.g. "12 GB free". */
export const getStorageEstimate = async (): Promise<{ usage: number; quota: number } | null> => {
  const storage = (navigator as any).storage;
  if (!storage?.estimate) return null;
  const { usage, quota } = await storage.estimate();
  return { usage: usage || 0, quota: quota || 0 };
};
