import type { WireMessage } from '../types';

/**
 * modules/shoutbox/transport/types.ts
 *
 * The shoutbox core (shoutbox.ts) talks only to this interface, never to
 * PeerJS directly. Swapping the underlying network (PeerJS cloud broker →
 * Gun.js relays → Nostr relays → anything else) means writing a new class
 * that implements this and changing one constructor call — nothing in
 * identity.ts, store.ts, or shoutbox.ts's message-handling logic needs to
 * change.
 */

export type TransportStatus = 'connecting' | 'connected' | 'disconnected';

export interface SignalingTransport {
  /** Our own id in the current network, once connected. Null before that. */
  readonly peerId: string | null;
  /** Whether we're currently the room's relay point (star topology "hub"). */
  readonly isHost: boolean;

  connect(): Promise<void>;
  disconnect(): void;

  /** Fire-and-forget. Delivered to every other connected peer, and also
   * looped back to our own onMessage() listeners (so callers don't need to
   * special-case "handle my own message locally too"). */
  broadcast(msg: WireMessage): void;

  /** Returns an unsubscribe function. */
  onMessage(cb: (msg: WireMessage, fromPeerId: string) => void): () => void;
  onStatusChange(cb: (status: TransportStatus) => void): () => void;
}
