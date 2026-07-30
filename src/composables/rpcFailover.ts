import * as dblurt from '@beblurt/dblurt';

/**
 * composables/rpcFailover.ts
 *
 * Every RPC-reading call in this app funnels through exactly two patterns
 * on a dblurt.Client — `client.call(api, method, params)` and
 * `client.condenser.<method>(...)` — all centralized in modules/blockchain.ts,
 * which already wraps each one in its own try/catch and returns a safe
 * fallback ([]/null) on failure. That existing structure is what makes this
 * safe to add transparently: this module only changes what happens BEFORE
 * that catch block fires — instead of failing on the first node, it walks
 * a small pool of known-good nodes and only gives up (letting
 * blockchain.ts's existing catch handle it exactly as today) once every
 * node in the pool has failed.
 *
 * WHY THIS ONLY WRAPS .call() AND .condenser.* — NOT .broadcast:
 * broadcasting a transaction is not idempotent. If a broadcast times out
 * client-side, the operation may have already been accepted by the node;
 * blindly retrying it against a different node risks a duplicate
 * broadcast (e.g. voting twice, posting twice). Reads have no such
 * downside, so only reads get automatic failover. Every other property on
 * the client (`.broadcast`, `.currentAddress`, `.chainId`, `.address`,
 * `.options`, anything else) passes straight through to whichever node is
 * CURRENTLY considered best, unmodified — exactly today's single-node
 * behavior, just pointed at whatever node reads have most recently proven
 * to work, so nothing about this app's other client usage can regress by
 * this module simply not knowing about some property it didn't enumerate.
 *
 * WHY TWO SEPARATE POOLS EXIST (data vs forum), NOT ONE SHARED LIST:
 * `get_forum_posts` and friends are custom endpoints that aren't part of
 * the official Blurt RPC API yet — only some nodes run the software that
 * supports them (and which ones do has proven to drift/be unreliable; see
 * this module's callers in useRpc.ts for the current candidate lists).
 * Official reads (get_content, get_accounts, ...) work on any standard
 * node. Failing over a forum-endpoint read into a plain official node
 * would just waste a round trip on a call that node can never satisfy —
 * so each pool only ever fails over within nodes actually meant for that
 * kind of call.
 */

const COOLDOWN_MS = 60_000; // don't retry a node that JUST failed for a while, but never give up on it forever
const REQUEST_TIMEOUT_MS = 12_000; // a node that never responds (no HTTP error, just silence) must not hang the app forever

/**
 * Races a node request against a timeout. A merely SLOW node still gets its full
 * COOLDOWN_MS chance on the next call (this only stops us waiting on a single request
 * past REQUEST_TIMEOUT_MS); a node that never responds at all (hung connection, no CORS
 * error, nothing) previously left `attempt()` awaiting forever — since reads have no
 * side effects, abandoning that wait and moving to the next node in the pool is safe.
 */
function withTimeout<T>(url: string, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${url}`)), REQUEST_TIMEOUT_MS);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

export interface FailoverPool {
  /** Drop-in replacement for a plain dblurt.Client — same shape, same
   * call sites, just resilient. */
  client: dblurt.Client;
  /** Whichever node reads are currently landing on. */
  getCurrentUrl: () => string;
}

/**
 * @param urls Ordered candidate pool. The first entry is tried first
 *   unless a previous run of this app already recorded a different
 *   working node under `storageKey`.
 * @param storageKey localStorage key used to remember the last node that
 *   actually worked, so a fresh page load starts from there instead of
 *   re-discovering it every time.
 * @param onSwitch Optional callback fired whenever a read succeeds on a
 *   DIFFERENT node than the one currently considered best (i.e. a
 *   failover just happened). Purely informational — logging/telemetry,
 *   not required for correctness.
 */
export function createFailoverPool(urls: string[], storageKey: string, onSwitch?: (url: string) => void): FailoverPool {
  const realClients = new Map<string, dblurt.Client>();
  function getReal(url: string): dblurt.Client {
    let c = realClients.get(url);
    if (!c) { c = new dblurt.Client([url]); realClients.set(url, c); }
    return c;
  }

  let saved: string | null = null;
  try { saved = localStorage.getItem(storageKey); } catch { /* ignore */ }
  let order = saved && urls.includes(saved) ? [saved, ...urls.filter((u) => u !== saved)] : [...urls];

  const cooldownUntil = new Map<string, number>();

  function candidateOrder(): string[] {
    const now = Date.now();
    const fresh = order.filter((u) => (cooldownUntil.get(u) ?? 0) <= now);
    const cooling = order.filter((u) => (cooldownUntil.get(u) ?? 0) > now);
    return [...fresh, ...cooling]; // cooling-down nodes go last, never disappear entirely
  }

  async function attempt<T>(fn: (c: dblurt.Client) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (const url of candidateOrder()) {
      try {
        const result = await withTimeout(url, fn(getReal(url)));
        if (order[0] !== url) {
          order = [url, ...order.filter((u) => u !== url)];
          try { localStorage.setItem(storageKey, url); } catch { /* quota or private mode — non-fatal */ }
          console.log(`[RpcFailover:${storageKey}] switched to`, url);
          onSwitch?.(url);
        }
        cooldownUntil.delete(url);
        return result;
      } catch (e) {
        console.warn(`[RpcFailover:${storageKey}] ${url} failed, trying next —`, e);
        lastErr = e;
        cooldownUntil.set(url, Date.now() + COOLDOWN_MS);
      }
    }
    throw lastErr;
  }

  const condenserProxy = new Proxy(
    {},
    {
      get(_t, method: string) {
        return (...args: unknown[]) => attempt((c) => (c.condenser as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method](...args));
      },
    }
  );

  const client = new Proxy(
    {},
    {
      get(_t, prop, receiver) {
        if (prop === 'call') {
          return (...args: unknown[]) => attempt((c) => (c.call as (...a: unknown[]) => Promise<unknown>)(...args));
        }
        if (prop === 'condenser') return condenserProxy;
        // Everything else (.broadcast, .currentAddress, .chainId, .address,
        // .options, .addressPrefix, or anything added to dblurt.Client in
        // the future that this file doesn't know about) — forward to
        // whichever node is currently best, unmodified. See header comment
        // for why .broadcast in particular is deliberately not retried.
        return Reflect.get(getReal(order[0]) as object, prop, receiver);
      },
    }
  ) as dblurt.Client;

  return { client, getCurrentUrl: () => order[0] };
}