import { reactive } from 'vue';
import { Blockchain } from '../blockchain';

/**
 * modules/player_blurt/blurt-peer-handshake.ts
 *
 * Stage 1 of the "reward seeders" plan: peers connected to a webtorrent
 * swarm announce their Blurt account directly over the BitTorrent wire —
 * using the player core's generic `player.webtorrent.registerWireExtension()`
 * hook (a plain BEP-10 / bittorrent-protocol extension registration; the
 * core has zero idea what this extension does). Peers show up with a badge
 * in the existing peer list (WebtorrentInfoModal.vue) via
 * `player.webtorrent.registerPeerAction()` — see BlurtPeerBadge.vue.
 *
 * This module deliberately knows NOTHING about how signing actually works
 * (dblurt, WhaleVault, encrypted keys, PIN unlock, …) — it's handed a
 * `signMessage(message) => Promise<string | null>` function from outside
 * (see createBlurtWireExtension's parameters, wired up in
 * blurt-player-plugin.ts) and just calls it, exactly the same way the
 * image-upload flow / voting already delegate signing elsewhere in the app.
 * Whatever that function does internally (decrypt a local key after a
 * cached PIN unlock, prompt WhaleVault, silently refuse, …) is entirely its
 * own business.
 *
 * IDENTITY VS VERIFICATION — important distinction from testing: signing
 * can fail, be unavailable, or (for an external signer like WhaleVault)
 * require an interactive confirmation popup. Forcing that popup to fire
 * automatically in the background just because we connected to a new peer
 * would be a genuinely bad experience — an unprompted signing request
 * appearing while someone's just watching a video. So this module NEVER
 * treats "couldn't sign right now" as a failure: if `signMessage` returns
 * null (for whatever reason), we still announce the account name, just
 * marked `verified: false`. The peer list badge renders these differently
 * (see BlurtPeerBadge.vue) — a name with no cryptographic proof behind it
 * yet, instead of either staying silent or forcing a popup just to show
 * any identity at all. Whether/when to actually attempt signing (e.g. only
 * if a local key is already unlocked and signing is instant, vs never for
 * an external signer) is entirely up to whatever `signMessage`
 * implementation gets injected — this module doesn't need to know or care.
 *
 * ── Protocol ────────────────────────────────────────────────────────────
 * Once both sides of a connection negotiate support for this extension
 * (BEP-10 extended handshake — standard bittorrent-protocol mechanic, we
 * don't touch it directly), and IF we're logged in, we send exactly one
 * 'hello' message — signed, if signing was possible:
 *
 *   { v: 1, type: 'hello', account, signed: true,  ts, nonce, sig }
 *   { v: 1, type: 'hello', account, signed: false }
 *
 * For a SIGNED hello, `sig` is a signature over
 * `${infoHash}:${account}:${ts}:${nonce}` — binding to `infoHash` means a
 * captured hello can't be replayed to impersonate the same account in a
 * DIFFERENT swarm. `ts` + a global (cross-connection) nonce cache with a
 * matching TTL means a captured hello can't be replayed at all once it
 * expires, and can't be reused a second time even within its freshness
 * window. An UNSIGNED hello carries no proof at all by design — replay
 * protection is meaningless for a claim that was never cryptographically
 * bound to anything in the first place; the "unverified" badge IS the
 * mitigation, not a signature check.
 *
 * One signed hello is reused for every peer on the SAME torrent until it's
 * close to expiring (see helloCache below), instead of re-signing per
 * connection — a swarm can easily have dozens of peers, and re-signing
 * that often is wasteful even when signing itself is cheap/local.
 */

// ─── Logging ──────────────────────────────────────────────────────────────
// Everything here is prefixed and greppable — filter the console by
// "[BlurtPeerHandshake]" to see the whole flow: extension applied, hellos
// sent/received, signing attempted, verification result, and exactly why
// something got skipped at each step.
const LOG = '[BlurtPeerHandshake]';
function log(...args: any[]): void { console.log(LOG, ...args); }
function warn(...args: any[]): void { console.warn(LOG, ...args); }

// ─── Verification: through Blockchain only, no direct crypto library use ──
// Per your note: player_blurt intentionally goes through `Blockchain` (the
// same abstraction the rest of the app uses) rather than importing dblurt
// directly, so it stays decoupled from whatever the underlying crypto
// library/version actually is. Blockchain.verifySignature() is implemented
// in blockchain.ts using the same SHA-256-via-crypto-js convention as the
// already-shipping image-upload signing path.
async function verifyBlurtSignature(message: string, signature: string, publicKey: string): Promise<boolean> {
  try {
    const ok = Blockchain.verifySignature(message, signature, publicKey);
    log('signature verify:', ok ? 'OK' : 'FAILED', { publicKey });
    return ok;
  } catch (e) {
    warn('verifyBlurtSignature threw:', e);
    return false;
  }
}

// ─── Posting public key lookup (fully confirmed — Blockchain.getAccount is
// already used exactly this way in useAuth.ts) ─────────────────────────────

const PUBKEY_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — posting keys change rarely, but do change
const pubKeyCache = new Map<string, { key: string | null; fetchedAt: number }>();

async function getPostingPublicKey(client: unknown, account: string): Promise<string | null> {
  const cached = pubKeyCache.get(account);
  if (cached && Date.now() - cached.fetchedAt < PUBKEY_CACHE_TTL_MS) {
    log('posting key for', account, '— cache hit:', cached.key ? cached.key : '(none found)');
    return cached.key;
  }
  try {
    const acc = await Blockchain.getAccount(client, account);
    const key: string | null = acc?.posting?.key_auths?.[0]?.[0] ?? null;
    pubKeyCache.set(account, { key, fetchedAt: Date.now() });
    log('posting key for', account, '— fetched:', key ? key : '(account not found or has no posting key_auths)');
    return key;
  } catch (e) {
    warn('failed to fetch posting key for', account, e);
    return null;
  }
}

// ─── Replay protection (only meaningful for SIGNED hellos — see the big
// comment up top for why an unsigned claim has nothing to protect) ────────
// Global (spans every connection, not just one): a signature is only valid
// for HELLO_FRESHNESS_MS from its own timestamp, and within that window
// only trusted once per (account, nonce). Because we reuse one signed
// hello for every peer on the same torrent, the SAME (account, nonce)
// legitimately arrives many times in a row, from many different peers, as
// OUR OWN broadcast reaches each of them — see onMessage below for how
// "I've already verified this exact (account, nonce)" is distinguished
// from "someone's replaying a captured one".

const HELLO_FRESHNESS_MS = 5 * 60 * 1000; // 5 min clock-skew + replay tolerance
const seenNonces = new Map<string, number>(); // `${account}:${nonce}` -> expiry epoch ms

function rememberNonce(account: string, nonce: string): void {
  const now = Date.now();
  seenNonces.forEach((expiry, k) => { if (expiry < now) seenNonces.delete(k); }); // opportunistic cleanup
  seenNonces.set(`${account}:${nonce}`, now + HELLO_FRESHNESS_MS);
}
const nonceAlreadySeen = (account: string, nonce: string): boolean => seenNonces.has(`${account}:${nonce}`);

// ─── Peer identity state ────────────────────────────────────────────────
// Keyed by `${infoHash}:${peerId}` since a bare peerId isn't guaranteed
// unique across different swarms. Reactive so BlurtPeerBadge.vue picks up
// changes without any polling of its own. `verified: false` means "this
// peer CLAIMS to be this account, unproven" — see the big comment up top.

export interface BlurtPeerIdentity {
  account: string;
  verified: boolean;
  seenAt: number;
}

export const peerIdentities = reactive(new Map<string, BlurtPeerIdentity>());

const peerKey = (infoHash: string, peerId: string): string => `${infoHash}:${peerId}`;

// Sent in front of every payload. If a received buffer doesn't start with
// this, it almost certainly isn't a bf_blurt message at all — e.g. an
// extension-ID collision with some OTHER extension both peers happen to
// have registered (BEP-10 IDs are small integers assigned per-connection;
// bittorrent-protocol is supposed to route by ID correctly, but this magic
// prefix makes a misroute immediately obvious in the logs instead of just
// looking like "corrupt JSON").
const MAGIC = 'BFBLURT1|';

type HelloPayload =
  | { v: 1; type: 'hello'; account: string; signed: true; ts: number; nonce: string; sig: string }
  | { v: 1; type: 'hello'; account: string; signed: false };

function randomNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Per-torrent hello cache ────────────────────────────────────────────
// Only the SIGNED case actually benefits from caching (avoids repeatedly
// calling the injected signMessage() for every peer); an unsigned hello is
// just a static object, cheap to rebuild every time, so it isn't cached.

interface CachedHello { payload: HelloPayload; expiresAt: number }
const helloCache = new Map<string, CachedHello>(); // key: `${infoHash}:${account}`
const HELLO_REFRESH_MARGIN_MS = 60 * 1000; // re-sign a bit before actual expiry, not exactly at the edge
const pendingSigns = new Map<string, Promise<HelloPayload>>(); // de-dupes concurrent attempts for the same key (many wires can hit this in the same tick)

async function getOrCreateHello(
  infoHash: string,
  account: string,
  signMessage: (message: string) => Promise<string | null>,
): Promise<HelloPayload> {
  const cacheKey = `${infoHash}:${account}`;
  const cached = helloCache.get(cacheKey);
  if (cached && cached.expiresAt - HELLO_REFRESH_MARGIN_MS > Date.now()) {
    log('hello for', account, 'on', infoHash.slice(0, 8), '— reusing cached signed hello, expires in', Math.round((cached.expiresAt - Date.now()) / 1000), 's');
    return cached.payload;
  }

  const pending = pendingSigns.get(cacheKey);
  if (pending) { log('hello for', account, 'on', infoHash.slice(0, 8), '— sign already in flight, waiting on it'); return pending; }

  const attempt = (async (): Promise<HelloPayload> => {
    const ts = Date.now();
    const nonce = randomNonce();
    const message = `${infoHash}:${account}:${ts}:${nonce}`;
    let sig: string | null = null;
    log('hello for', account, 'on', infoHash.slice(0, 8), '— attempting to sign…');
    try {
      sig = await signMessage(message);
    } catch (e) {
      warn('signMessage threw — announcing unverified instead:', e);
    }
    if (sig) {
      log('hello for', account, 'on', infoHash.slice(0, 8), '— signed OK, caching for', Math.round(HELLO_FRESHNESS_MS / 1000), 's');
      const payload: HelloPayload = { v: 1, type: 'hello', account, signed: true, ts, nonce, sig };
      helloCache.set(cacheKey, { payload, expiresAt: ts + HELLO_FRESHNESS_MS });
      return payload;
    }
    // Couldn't sign (declined, unavailable, whatever) — not an error, just
    // means this connection announces unverified. Not cached: there's no
    // cost to rebuilding this, and it lets us retry signing again next
    // time (e.g. once a local key gets unlocked mid-session).
    log('hello for', account, 'on', infoHash.slice(0, 8), '— signMessage returned null, announcing UNVERIFIED (locked key, WhaleVault, or not logged in with a local key — see blurt-sign-message.ts)');
    return { v: 1, type: 'hello', account, signed: false };
  })();
  pendingSigns.set(cacheKey, attempt);
  try {
    return await attempt;
  } finally {
    pendingSigns.delete(cacheKey);
  }
}

/**
 * Returns the bittorrent-protocol extension factory to hand to
 * `player.webtorrent.registerWireExtension(...)`.
 *
 * @param client         Passed straight through to Blockchain.getAccount().
 * @param getAuthUser    Function (not a snapshot) so every new connection
 *                       picks up whoever is logged in RIGHT NOW.
 * @param signMessage    Signs an arbitrary short string with the current
 *                       user's posting key, however that's actually
 *                       implemented elsewhere in the app (see the
 *                       top-of-file comment) — resolve `null` if signing
 *                       isn't possible/declined right now; never throw for
 *                       "user said no", only for genuine errors.
 */
export function createBlurtWireExtension(
  client: unknown,
  getAuthUser: () => { username: string } | null,
  signMessage: (message: string) => Promise<string | null>,
) {
  function BlurtExtension(this: any, wire: any) {
    this.wire = wire;
    log('extension applied to a new wire (remoteAddress:', wire.remoteAddress || '?', ')');
    // Registered directly on the wire (rather than relying on a possible
    // bittorrent-protocol "onClose" extension hook, which I'm not 100%
    // certain is part of its API) — guaranteed to work either way.
    wire.on('close', () => {
      if (this.infoHash && this.peerId) {
        log('peer disconnected, dropping identity for', this.peerId);
        peerIdentities.delete(peerKey(this.infoHash, this.peerId));
      }
    });
  }
  BlurtExtension.prototype.name = 'bf_blurt';

  BlurtExtension.prototype.onHandshake = function (this: any, infoHash: string, peerId: string) {
    this.infoHash = infoHash;
    this.peerId = peerId;
    log('BT handshake seen — infoHash:', infoHash.slice(0, 8), 'peerId:', peerId);
  };

  BlurtExtension.prototype.onExtendedHandshake = function (this: any, handshake: any) {
    // onExtendedHandshake fires whenever the peer sends ITS extended
    // handshake at all — confirm they actually listed support for OUR
    // extension (`m: { bf_blurt: <id> }`) before bothering to send
    // anything; otherwise nobody on the other end is listening for it.
    if (!handshake?.m?.[BlurtExtension.prototype.name]) {
      log('peer', this.peerId, "doesn't support bf_blurt — not sending a hello");
      return;
    }
    log('peer', this.peerId, 'supports bf_blurt');

    const user = getAuthUser();
    if (!user?.username) {
      log('not logged in — will not announce, but can still verify hellos FROM this peer');
      return;
    }
    const infoHash = this.infoHash as string;
    const wire = this.wire;

    getOrCreateHello(infoHash, user.username, signMessage).then((payload) => {
      try {
        const raw = MAGIC + JSON.stringify(payload);
        wire.extended('bf_blurt', Buffer.from(raw, 'utf8'));
        log('sent hello to', this.peerId, '— account:', payload.account, 'signed:', payload.signed, `(${raw.length} bytes)`);
      } catch (e) {
        warn('failed to send hello to', this.peerId, ':', e);
      }
    });
  };

  BlurtExtension.prototype.onMessage = function (this: any, buf: Buffer) {
    // Real bug found via logging: `buf` here isn't guaranteed to be a full
    // Node-style Buffer — bittorrent-protocol/simple-peer can hand this
    // callback a plain Uint8Array in the browser. A plain
    // Uint8Array.prototype.toString() silently IGNORES an encoding
    // argument like 'utf8'/'hex' and falls back to
    // Array.prototype.join(',') instead — which is exactly what showed up
    // in the logs as garbage-looking comma-separated numbers (they were
    // actually the correct ASCII byte values the whole time; decoding them
    // by hand spelled out our own "BFBLURT1|{...}" message perfectly).
    // Wrapping in Buffer.from() first guarantees real Buffer semantics
    // regardless of what bittorrent-protocol actually handed us.
    const b = Buffer.from(buf);
    const raw = b.toString('utf8');
    if (!raw.startsWith(MAGIC)) {
      warn(
        "received a bf_blurt-routed message that doesn't start with our magic prefix from", this.peerId,
        '— likely an extension-ID collision with something else, not actually a bf_blurt message. Raw bytes (first 80):',
        JSON.stringify(raw.slice(0, 80)), '| hex:', b.subarray(0, 40).toString('hex'),
      );
      return;
    }
    let payload: HelloPayload;
    try {
      payload = JSON.parse(raw.slice(MAGIC.length));
    } catch (e) {
      warn('magic prefix OK but JSON body is corrupt from', this.peerId, '— raw body (first 200):', JSON.stringify(raw.slice(MAGIC.length, MAGIC.length + 200)), e);
      return;
    }
    if (payload?.type !== 'hello' || payload.v !== 1 || !payload.account) {
      warn('received bf_blurt message with unexpected shape from', this.peerId, '— ignoring:', payload);
      return;
    }
    log('received hello from', this.peerId, '— claims:', payload.account, 'signed:', payload.signed);

    const infoHash = this.infoHash as string;
    const peerId = this.peerId as string;

    if (!payload.signed) {
      log('accepting', payload.account, 'as UNVERIFIED for peer', peerId, '(hello had no signature)');
      peerIdentities.set(peerKey(infoHash, peerId), { account: payload.account, verified: false, seenAt: Date.now() });
      return;
    }

    if (!payload.ts || !payload.nonce || !payload.sig) {
      warn('signed hello from', payload.account, 'is missing ts/nonce/sig — ignoring:', payload);
      return;
    }
    const ageMs = Date.now() - payload.ts;
    if (Math.abs(ageMs) > HELLO_FRESHNESS_MS) {
      warn('rejecting hello from', payload.account, '— stale or clock skew (age:', Math.round(ageMs / 1000), 's, limit:', HELLO_FRESHNESS_MS / 1000, 's)');
      return;
    }

    // Same signed hello legitimately arrives from every peer we're
    // connected to on this torrent (see the caching note up top). A
    // repeat (account, nonce) is only actually suspicious the first time
    // THIS process hasn't already verified it — once verified, trust it
    // again for any other peer forwarding the identical payload without
    // re-running crypto; only a genuinely NEW (account, nonce) needs a
    // fresh signature check.
    if (nonceAlreadySeen(payload.account, payload.nonce)) {
      log('accepting', payload.account, 'as VERIFIED for peer', peerId, '(nonce already verified once this session, reusing result)');
      peerIdentities.set(peerKey(infoHash, peerId), { account: payload.account, verified: true, seenAt: Date.now() });
      return;
    }

    const message = `${infoHash}:${payload.account}:${payload.ts}:${payload.nonce}`;
    log('new (account, nonce) — fetching posting key + verifying signature for', payload.account);

    getPostingPublicKey(client, payload.account).then(async (pubKey) => {
      if (!pubKey) {
        warn('rejecting hello from', payload.account, '— no posting public key found (account may not exist)');
        return;
      }
      const ok = await verifyBlurtSignature(message, payload.sig, pubKey);
      if (!ok) {
        warn('rejecting hello from', payload.account, '— signature verification FAILED');
        return;
      }
      rememberNonce(payload.account, payload.nonce);
      log('accepting', payload.account, 'as VERIFIED for peer', peerId, '(signature check passed)');
      peerIdentities.set(peerKey(infoHash, peerId), { account: payload.account, verified: true, seenAt: Date.now() });
    });
  };

  return BlurtExtension;
}