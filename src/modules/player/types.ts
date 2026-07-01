/**
 * module/player — generic media player types.
 * No knowledge of Blurt, blockchain, posts, or forums lives here.
 * Anything app-specific (payout, votes, author/permlink as required fields)
 * belongs in a plugin's own metadata, attached via MediaTrack.meta / MediaTrack.badge.
 */

export interface MediaEntryMirror {
  type: 'audio' | 'youtube' | 'peertube';
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
  expandedTab: 'video' | 'queue' | 'playlists' | 'settings';
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
  scrollToCurrent: () => void;
  toggleExperimental: (val: boolean) => void;
  togglePlayMode: () => void;
  on: (event: PlayerEvent, fn: (data: unknown) => void) => void;
  off: (event: PlayerEvent, fn: (data: unknown) => void) => void;
  registerPlugin: (plugin: PlayerPlugin) => void;
  /** Temporarily blocks manual skip (e.g. while a sponsored track must play). Plugins are responsible for calling unlockSkip(). */
  lockSkip: () => void;
  unlockSkip: () => void;
  createPlaylist: (name: string, color?: string) => Playlist | null;
  deletePlaylist: (id: string) => void;
  renamePlaylist: (id: string, newName: string) => void;
  addTrackToPlaylist: (playlistId: string, track: MediaTrack) => boolean;
  removeTrackFromPlaylist: (playlistId: string, trackId: string) => void;
  playPlaylist: (playlistId: string, startIndex?: number) => void;
}
