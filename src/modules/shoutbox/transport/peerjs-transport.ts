import Peer, { type DataConnection } from 'peerjs';
import type { WireMessage } from '../types';
import type { SignalingTransport, TransportStatus } from './types';

/**
 * modules/shoutbox/transport/peerjs-transport.ts
 *
 * Signaling + relay over PeerJS's default public cloud broker
 * (0.peerjs.com) — no backend of our own. Star topology, not full mesh:
 *
 *   - The first tab anywhere claims a well-known, hardcoded peer id
 *     (ROOM_ID) and becomes the "host" for this session. It's a normal
 *     browser tab, nothing special — just first to arrive.
 *   - Every other tab tries the same claim, gets an 'unavailable-id' error
 *     back (PeerJS's way of saying "that id is taken"), and falls back to
 *     connecting to ROOM_ID as a plain client instead.
 *   - The host relays every message it receives to all *other* connected
 *     clients, and also delivers it to its own local listeners — so from
 *     the outside, broadcast() behaves the same whether you're the host or
 *     a client.
 *   - If the host's tab closes (or its connection drops), every remaining
 *     client notices its connection to ROOM_ID died, waits a small random
 *     delay (so they don't all collide at once), and races to claim
 *     ROOM_ID itself. Whoever wins becomes the new host; the others fall
 *     back to connecting to *them*.
 *
 * Known limitations, worth stating plainly rather than discovering later:
 *   - This is a single free public broker. If it's down/rate-limiting, no
 *     new connections can be established (existing WebRTC data channels
 *     between already-connected peers are unaffected, but nobody new can
 *     join until it recovers).
 *   - A client only ever sees "the host" as its direct peer — it does not
 *     learn who the other clients are except through messages the host
 *     relays (which is exactly how presence.ts's online-user list works;
 *     it deliberately does NOT rely on this transport exposing a peer
 *     count).
 *   - Star topology tops out well before full-mesh would; fine at the
 *     handful-of-concurrent-users scale this is built for, worth
 *     revisiting if that ever stops being true.
 */

const LOG = '[ShoutboxTransport]';
function log(...args: unknown[]): void { console.log(LOG, ...args); }
function warn(...args: unknown[]): void { console.warn(LOG, ...args); }

// Bump the version suffix if the WireMessage shape ever changes
// incompatibly — old and new clients would otherwise land in the same room
// and fail to understand each other's messages.
const ROOM_ID = 'blurtforum-shoutbox-v1';
const HOST_RETRY_MIN_MS = 400;
const HOST_RETRY_MAX_MS = 2000;

export class PeerJsTransport implements SignalingTransport {
  private peer: Peer | null = null;
  private hostConn: DataConnection | null = null; // set when we are a client
  private clientConns = new Map<string, DataConnection>(); // set when we are the host
  private _isHost = false;
  private _peerId: string | null = null;
  private destroyed = false;

  private messageCbs = new Set<(msg: WireMessage, fromPeerId: string) => void>();
  private statusCbs = new Set<(status: TransportStatus) => void>();

  get peerId(): string | null { return this._peerId; }
  get isHost(): boolean { return this._isHost; }

  async connect(): Promise<void> {
    this.destroyed = false;
    this.emitStatus('connecting');
    await this.tryBecomeHost();
  }

  disconnect(): void {
    this.destroyed = true;
    this.hostConn?.close();
    this.hostConn = null;
    for (const c of this.clientConns.values()) c.close();
    this.clientConns.clear();
    this.peer?.destroy();
    this.peer = null;
    this._peerId = null;
    this._isHost = false;
    this.emitStatus('disconnected');
  }

  broadcast(msg: WireMessage): void {
    if (this._isHost) {
      this.deliverLocal(msg, this._peerId ?? 'self');
      for (const conn of this.clientConns.values()) {
        if (conn.open) conn.send(msg);
      }
    } else if (this.hostConn?.open) {
      this.hostConn.send(msg);
      // Optimistic local delivery so the sender's own UI updates instantly
      // rather than waiting on a round trip through the host.
      this.deliverLocal(msg, this._peerId ?? 'self');
    } else {
      warn('broadcast() called while not connected — dropped', msg);
    }
  }

  onMessage(cb: (msg: WireMessage, fromPeerId: string) => void): () => void {
    this.messageCbs.add(cb);
    return () => this.messageCbs.delete(cb);
  }

  onStatusChange(cb: (status: TransportStatus) => void): () => void {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  }

  // ─── Host election ──────────────────────────────────────────────────────

  private async tryBecomeHost(): Promise<void> {
    if (this.destroyed) return;
    const peer = new Peer(ROOM_ID);
    this.peer = peer;

    const claimedHost = await new Promise<boolean>((resolve) => {
      peer.once('open', (id) => { log('claimed host id', id); resolve(true); });
      peer.once('error', (err: any) => {
        if (err?.type === 'unavailable-id') resolve(false);
        else { warn('host claim attempt errored', err); resolve(false); }
      });
    });

    if (this.destroyed) { peer.destroy(); return; }

    if (claimedHost) {
      this._isHost = true;
      this._peerId = peer.id;
      peer.on('connection', (conn) => this.attachClientConnection(conn));
      peer.on('disconnected', () => this.peer?.reconnect()); // broker session dropped, not our peers
      peer.on('error', (err) => warn('host peer error', err));
      this.emitStatus('connected');
    } else {
      peer.destroy();
      await this.connectAsClient();
    }
  }

  private async connectAsClient(): Promise<void> {
    if (this.destroyed) return;
    const peer = new Peer();
    this.peer = peer;

    await new Promise<void>((resolve) => {
      peer.once('open', (id) => { this._peerId = id; resolve(); });
      peer.once('error', (err) => { warn('client peer open error', err); resolve(); });
    });
    if (this.destroyed || !this._peerId) return;

    const conn = peer.connect(ROOM_ID, { reliable: true });
    this.hostConn = conn;
    this._isHost = false;

    conn.on('open', () => { log('connected to host'); this.emitStatus('connected'); });
    conn.on('data', (data) => this.deliverLocal(data as WireMessage, ROOM_ID));
    conn.on('close', () => this.handleHostLost());
    conn.on('error', (err) => { warn('connection to host errored', err); this.handleHostLost(); });
  }

  private attachClientConnection(conn: DataConnection): void {
    conn.on('open', () => {
      this.clientConns.set(conn.peer, conn);
      log('client joined:', conn.peer, '— total clients:', this.clientConns.size);
    });
    conn.on('data', (data) => {
      const msg = data as WireMessage;
      for (const [id, other] of this.clientConns) {
        if (id !== conn.peer && other.open) other.send(msg);
      }
      this.deliverLocal(msg, conn.peer);
    });
    conn.on('close', () => {
      this.clientConns.delete(conn.peer);
      log('client left:', conn.peer, '— total clients:', this.clientConns.size);
    });
    conn.on('error', (err) => warn('client connection error', err));
  }

  private handleHostLost(): void {
    if (this.destroyed) return;
    this.hostConn = null;
    this.emitStatus('connecting');
    this.peer?.destroy();
    const jitter = HOST_RETRY_MIN_MS + Math.random() * (HOST_RETRY_MAX_MS - HOST_RETRY_MIN_MS);
    log('host connection lost — re-electing in', Math.round(jitter), 'ms');
    setTimeout(() => { if (!this.destroyed) this.tryBecomeHost(); }, jitter);
  }

  private deliverLocal(msg: WireMessage, fromPeerId: string): void {
    for (const cb of this.messageCbs) cb(msg, fromPeerId);
  }

  private emitStatus(status: TransportStatus): void {
    for (const cb of this.statusCbs) cb(status);
  }
}
