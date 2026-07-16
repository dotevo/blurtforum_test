/**
 * module/player — generic media player types.
 * No knowledge of Blurt, blockchain, posts, or forums lives here.
 * Anything app-specific (payout, votes, author/permlink as required fields)
 * belongs in a plugin's own metadata, attached via MediaTrack.meta / MediaTrack.badge.
 */

import type { WebtorrentStats, SeedManifestEntry } from './webtorrent-pool';

export interface MediaEntryMirror {
  type: 'audio' | 'youtube' | 'peertube' | 'webtorrent';
  /** For type 'webtorrent', this holds the full magnet URI (must include xt=urn:btih:). */
  id: string;
  src?: string;
  host?: string;
  thumb?: string;
  group?: string;
  typeIndex?: number;
}

export interface MediaTrack {
  /** Identity fields used to match/dedupe tracks. Generic in shape (just strings), but the player core treats them as opaque identity — it has no notion of "author" or "post" beyond equality checks. */
  author: string;
  permlink: string;
  subId?: string;
  title: string;
  sources: MediaEntryMirror[];
  activeSourceIndex: number;
  cover?: string;
  pending?: boolean;
  _errorHandled?: boolean;
  /** App-specific data a plugin needs to carry alongside the track (e.g. { payout, voteCount, voted }). Opaque to the player core; the UI never reads it directly — plugins render their own UI via the track-actions slot. */
  meta?: Record<string, unknown>;
}

export type PlayMode = 'sequential' | 'shuffle' | 'repeat-all' | 'repeat-one';

export interface PlayerState {
  enabled: boolean;
  active: boolean;
  playing: boolean;
  loading: boolean;
  minimized: boolean;
  expanded: boolean;
  expandedHeight: number;
  /** Width in px of the tabs sidebar within the expanded panel (video takes the rest). User-draggable, session-only like expandedHeight. */
  tabsWidth: number;
  /** Built-in ids are 'video' | 'queue' | 'playlists' | 'settings'; a plugin
   *  registering a tab via registerExpandedTab() can set this to its own id. */
  expandedTab: string;
  /** Fullscreen presentation of the same expanded panel/video — no separate
   *  player instance, purely a display-mode flag the UI reacts to. Not
   *  persisted: like `expanded`/`minimized`, it's session-only. */
  cinema: boolean;
  currentTrack: MediaTrack | null;
  queue: MediaTrack[];
  autoQueue: MediaTrack[];
  history: MediaTrack[];
  progress: number;
  duration: number;
  volume: number;
  experimental: boolean;
  isAutoStarting: boolean;
  playMode: PlayMode;
  /** When true, manual skip (playNext called without isAuto) is ignored. Plugins toggle this via lockSkip/unlockSkip. */
  skipLocked: boolean;
  /** Global WebTorrent upload switch (see webtorrent-pool.ts). Mirrors localStorage so it survives reloads. */
  seedingEnabled: boolean;
}

export interface Playlist {
  id: string;
  name: string;
  color: string;
  createdAt: number;
  updatedAt: number;
  tracks: (MediaTrack & { addedAt?: number })[];
}

export interface PlaylistState {
  playlists: Playlist[];
}

export type PlayerEvent =
  | 'trackChange' | 'play' | 'pause' | 'next' | 'prev'
  | 'ended' | 'volumeChange' | 'error';

export interface PlayerPlugin {
  name: string;
  install?: (player: BFPlayerAPI) => void;
  onTrackChange?: (track: MediaTrack) => void;
}

/** Where a track-action UI contribution is allowed to render. */
export type TrackActionZone = 'mini' | 'expanded' | 'both';

/**
 * A single plugin's contribution to the player's track-actions area.
 * `component` is any Vue component; it receives `track`, `player`, plus
 * whatever static `props` were registered alongside it, plus any listeners
 * passed down to the host slot (e.g. openTopic/submitVote) via fallthrough.
 * The player core never inspects what these components render — it only
 * decides *whether* to mount them, based on `zone`.
 */
export interface TrackActionContribution {
  id: string;
  zone: TrackActionZone;
  component: any;
  /** Extra static props merged in alongside `track`/`player` (e.g. a plugin's own `client`). */
  props?: Record<string, unknown>;
}

/**
 * A single plugin's contribution to the expanded panel's tab bar (alongside
 * the built-in video/queue/playlists/settings tabs). `component` receives
 * `track` (the current MediaTrack, may be null) and `player`, plus whatever
 * static `props` were registered. The player core has no idea what a given
 * tab renders — e.g. a Blurt plugin contributing a "Comments" tab that reads
 * `track.author`/`track.permlink` to fetch replies is entirely its own
 * business; the core only knows there's an id/label/icon and a component to
 * mount when that tab is selected.
 */
export interface PlayerTabContribution {
  id: string;
  label: string;
  icon: string;
  component: any;
  props?: Record<string, unknown>;
}

/**
 * A single plugin's contribution to a webtorrent peer-list row. `component`
 * receives `peerId`, `infoHash`, `addr`, `t`, plus whatever static `props`
 * were registered alongside it. The player core has no idea what any given
 * contribution renders (or whether it renders anything at all for a given
 * peer) — e.g. a Blurt-identity badge that only shows up for peers whose
 * wire extension handshake it recognizes, and renders nothing for anyone
 * else. Unlike track actions there's no `zone`: peer rows only exist in one
 * place (the webtorrent peer list), so every registered contribution is
 * simply mounted once per row.
 */
export interface PeerActionContribution {
  id: string;
  component: any;
  props?: Record<string, unknown>;
}

/**
 * Namespaced, protocol-specific surface for webtorrent-only capabilities —
 * requested explicitly so plugin code reads as `player.webtorrent.foo(...)`
 * rather than flat `player.foo(...)`, matching how the player also supports
 * other protocols (YouTube, PeerTube, plain audio) that have nothing to do
 * with any of this. The methods below are the SAME functions as their flat
 * BFPlayerAPI counterparts (kept for now, unremoved, to avoid breaking
 * anything already calling them the old way) — this is purely an additional,
 * clearer entry point, not a different implementation.
 */
export interface WebtorrentAPI {
  /** Turns global upload on/off (e.g. a mobile "don't seed" switch). Mirrored in state.seedingEnabled. */
  setSeedingEnabled: (enabled: boolean) => void;
  /** Max bytes the persistent seed cache is allowed to use; oldest-active torrents are evicted first once exceeded. */
  setMaxSeedStorageBytes: (bytes: number) => void;
  getMaxSeedStorageBytes: () => number;
  /** Lifetime upload/download totals, per torrent and overall — survive reloads and individual torrents being evicted. */
  getWebtorrentStats: () => WebtorrentStats;
  /** Everything currently persisted (on disk), for a "what am I seeding" settings view. */
  getWebtorrentManifest: () => SeedManifestEntry[];
  getWebtorrentStorageEstimate: () => Promise<{ usage: number; quota: number } | null>;
  /** Deletes all locally seeded data — a "clear my seed data" privacy control. */
  clearWebtorrentData: () => Promise<void>;
  /** Manually (re)attach playback to a specific file index in the currently-loaded torrent — lets the UI offer a per-file "Play" action instead of only the automatic best-file pick. */
  playWebtorrentFile: (fileIndex: number) => void;

  /**
   * Registers a bittorrent-protocol (BEP-10) extension factory — exactly
   * what you'd pass to `wire.use(factory)` yourself. Applied to every wire
   * on every torrent, current (retroactively) and future. The player has no
   * opinion on what the extension does — e.g. a plugin implementing its own
   * peer-identity handshake protocol.
   */
  registerWireExtension: (factory: (wire: any) => any) => void;
  /** Registers a plugin's own Vue component into every webtorrent peer-list row (see PeerActionContribution). Idempotent by id. */
  registerPeerAction: (contribution: PeerActionContribution) => void;
  /** Contributions currently registered. Used by the generic peer-list renderer in WebtorrentInfoModal.vue. */
  getPeerActions: () => PeerActionContribution[];
}

export interface BFPlayerAPI {
  state: PlayerState;
  playlistState: PlaylistState;
  playTrack: (track: MediaTrack, isManual?: boolean, manualIdx?: number, fromHistory?: boolean) => Promise<void>;
  playNext: (isAuto?: boolean) => void;
  playPrev: () => void;
  togglePlay: () => void;
  seek: (pct: number) => void;
  /** Adds a track to the manual queue. position 'start' inserts at the front (e.g. to inject sponsored content before the next auto-pick), default 'end'. */
  addToQueue: (track: MediaTrack, position?: 'start' | 'end') => void;
  scanView: (container?: Element | null) => void;
  registerTrack: (incoming: any) => void;
  unregisterTrack: (trackId: string, type: string, idHint?: string, subId?: string) => void;
  setClient: (client: any) => void;
  clearTracks: () => void;
  setAutoQueue: (tracks: MediaTrack[]) => void;
  initResize: (e: MouseEvent | TouchEvent) => void;
  /** Drag handle between the video and the tabs sidebar in the expanded panel. */
  initTabsResize: (e: MouseEvent | TouchEvent) => void;
  scrollToCurrent: () => void;
  toggleExperimental: (val: boolean) => void;
  togglePlayMode: () => void;
  on: (event: PlayerEvent, fn: (data: unknown) => void) => void;
  off: (event: PlayerEvent, fn: (data: unknown) => void) => void;
  registerPlugin: (plugin: PlayerPlugin) => void;
  /** Registers a plugin's own Vue component into the track-actions area (see TrackActionContribution). Idempotent by id. */
  registerTrackAction: (contribution: TrackActionContribution) => void;
  /** Contributions currently registered for a given zone (includes 'both'-zone ones). Used by the generic TrackActions.vue host. */
  getTrackActions: (zone: Exclude<TrackActionZone, 'both'>) => TrackActionContribution[];
  /** Registers a plugin's own tab (+ component) into the expanded panel's tab bar. Idempotent by id. */
  registerExpandedTab: (contribution: PlayerTabContribution) => void;
  /** Tabs currently registered, in registration order. Used by MediaPlayer.vue to render extra tab buttons/bodies generically. */
  getExpandedTabs: () => PlayerTabContribution[];
  /** Temporarily blocks manual skip (e.g. while a sponsored track must play). Plugins are responsible for calling unlockSkip(). */
  lockSkip: () => void;
  unlockSkip: () => void;
  createPlaylist: (name: string, color?: string) => Playlist | null;
  deletePlaylist: (id: string) => void;
  renamePlaylist: (id: string, newName: string) => void;
  addTrackToPlaylist: (playlistId: string, track: MediaTrack) => boolean;
//  removeTrackFromPlaylist: (playlistId: string, trackId: string) => void;
  removeTrackFromPlaylist: (playlistId: string, author: string, permlink: string, subId?: string) => void;
  playPlaylist: (playlistId: string, startIndex?: number) => void;

  // ─── WebTorrent (see webtorrent-pool.ts for the actual implementation) ───
  /** Turns global upload on/off (e.g. a mobile "don't seed" switch). Mirrored in state.seedingEnabled. */
  setSeedingEnabled: (enabled: boolean) => void;
  /** Max bytes the persistent seed cache is allowed to use; oldest-active torrents are evicted first once exceeded. */
  setMaxSeedStorageBytes: (bytes: number) => void;
  getMaxSeedStorageBytes: () => number;
  /** Lifetime upload/download totals, per torrent and overall — survive reloads and individual torrents being evicted. */
  getWebtorrentStats: () => WebtorrentStats;
  /** Everything currently persisted (on disk), for a "what am I seeding" settings view. */
  getWebtorrentManifest: () => SeedManifestEntry[];
  getWebtorrentStorageEstimate: () => Promise<{ usage: number; quota: number } | null>;
  /** Deletes all locally seeded data — a "clear my seed data" privacy control. */
  clearWebtorrentData: () => Promise<void>;
  /** Manually (re)attach playback to a specific file index in the currently-loaded torrent — lets the UI offer a per-file "Play" action instead of only the automatic best-file pick. */
  playWebtorrentFile: (fileIndex: number) => void;

  /** Same webtorrent-only capabilities as the flat methods above (kept for now), namespaced — see WebtorrentAPI. Prefer this for new code. */
  webtorrent: WebtorrentAPI;
}