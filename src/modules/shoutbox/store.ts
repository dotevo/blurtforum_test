import type { ChatMessage, ShoutboxScope, SessionCertificate } from './types';

/**
 * modules/shoutbox/store.ts
 *
 * Local persistence for shoutbox history. Deliberately stores EVERY scope
 * it ever sees traffic for — not just the one currently displayed. This is
 * the fix for the "only 1-2 people online, refresh the page, history is
 * gone" problem: even a lurker who never opens the "Community X" tab still
 * receives (via the transport's relay) and persists Community X's
 * messages, purely by being connected. The UI only *filters* by scope for
 * display (see Shoutbox.messagesFor()); storage itself is scope-blind.
 *
 * No server, no shared source of truth — this is one browser's local
 * cache, merged idempotently by message id whenever new messages arrive
 * from any peer. Multiple tabs/peers with overlapping-but-not-identical
 * histories is the expected steady state, not a bug.
 *
 * ALSO stores every SessionCertificate seen, separately from messages
 * (they're referenced by id from many messages, no need to duplicate
 * them). This exists specifically so `history_response` can bundle a
 * message together with the certificate that authorizes it (see
 * shoutbox.ts) — a message whose certificate never arrives anywhere is
 * permanently unverifiable and gets dropped on receipt, so the two must
 * travel together through history sync, not rely on the certificate
 * having been separately gossiped earlier and still being around.
 */

const LOG = '[ShoutboxStore]';
const STORAGE_KEY = 'bf_shoutbox_v1';
const MAX_MESSAGES_PER_SCOPE = 200;
const MAX_SCOPES_RETAINED = 64; // evict least-recently-touched scope beyond this

interface ScopeEntry {
  messages: ChatMessage[];
  touchedAt: number;
}

type StoredShape = Record<string, ScopeEntry>;

function load(): StoredShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredShape) : {};
  } catch (e) {
    console.warn(LOG, 'failed to load persisted history, starting empty', e);
    return {};
  }
}

function persist(data: StoredShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    // Most likely quota exceeded — non-fatal, in-memory state is still correct
    // for this session, we just won't survive a refresh until it's under quota again.
    console.warn(LOG, 'failed to persist history (quota?)', e);
  }
}

let cache: StoredShape = load();

function evictColdScopesIfNeeded(): void {
  const scopes = Object.keys(cache);
  if (scopes.length <= MAX_SCOPES_RETAINED) return;
  scopes.sort((a, b) => cache[a].touchedAt - cache[b].touchedAt);
  for (const s of scopes.slice(0, scopes.length - MAX_SCOPES_RETAINED)) delete cache[s];
}

// ─── Certificates ───────────────────────────────────────────────────────

const CERT_STORAGE_KEY = 'bf_shoutbox_certs_v1';
const MAX_CERTS_RETAINED = 500;

function loadCerts(): Record<string, SessionCertificate> {
  try {
    const raw = localStorage.getItem(CERT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, SessionCertificate>) : {};
  } catch (e) {
    console.warn(LOG, 'failed to load persisted certificates, starting empty', e);
    return {};
  }
}

function persistCerts(data: Record<string, SessionCertificate>): void {
  try {
    localStorage.setItem(CERT_STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn(LOG, 'failed to persist certificates (quota?)', e);
  }
}

let certCache: Record<string, SessionCertificate> = loadCerts();

function evictOldestCertsIfNeeded(): void {
  const ids = Object.keys(certCache);
  if (ids.length <= MAX_CERTS_RETAINED) return;
  ids.sort((a, b) => certCache[a].issuedAt - certCache[b].issuedAt);
  for (const id of ids.slice(0, ids.length - MAX_CERTS_RETAINED)) delete certCache[id];
}

export const ShoutboxStore = {
  getAll(scope: ShoutboxScope): ChatMessage[] {
    return cache[scope]?.messages ?? [];
  },

  /** Every scope currently held locally, regardless of what's being viewed. */
  getKnownScopes(): string[] {
    return Object.keys(cache);
  },

  latestTimestamp(scope: ShoutboxScope): number {
    const msgs = this.getAll(scope);
    return msgs.length ? msgs[msgs.length - 1].ts : 0;
  },

  /** Idempotent by message id — safe to call repeatedly with overlapping
   * sets (gossip re-delivery, history sync responses, etc). Returns the
   * resulting merged+sorted+capped array for convenience. */
  merge(scope: ShoutboxScope, incoming: ChatMessage[]): ChatMessage[] {
    if (incoming.length === 0) return this.getAll(scope);

    const entry: ScopeEntry = cache[scope] ?? { messages: [], touchedAt: 0 };
    const byId = new Map(entry.messages.map((m) => [m.id, m]));
    for (const m of incoming) byId.set(m.id, m);

    entry.messages = Array.from(byId.values())
      .sort((a, b) => a.ts - b.ts)
      .slice(-MAX_MESSAGES_PER_SCOPE);
    entry.touchedAt = Date.now();
    cache[scope] = entry;

    evictColdScopesIfNeeded();
    persist(cache);
    return entry.messages;
  },

  add(scope: ShoutboxScope, message: ChatMessage): ChatMessage[] {
    return this.merge(scope, [message]);
  },

  getCertificate(id: string): SessionCertificate | undefined {
    return certCache[id];
  },

  getCertificates(ids: Iterable<string>): SessionCertificate[] {
    const out: SessionCertificate[] = [];
    for (const id of ids) { const c = certCache[id]; if (c) out.push(c); }
    return out;
  },

  /** No-op if we already have this exact certificate id (they're
   * content-addressed — same id always means identical contents). */
  addCertificate(cert: SessionCertificate): void {
    if (certCache[cert.id]) return;
    certCache[cert.id] = cert;
    evictOldestCertsIfNeeded();
    persistCerts(certCache);
  },
};
