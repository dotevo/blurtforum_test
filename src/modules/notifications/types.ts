// A single notification, already normalized to a shape the UI can render
// without knowing which backend/channel it came from.
export interface NotificationItem {
  id: number | string;
  type: string;
  author: string;
  date: string;
  msg?: string;
  url?: string;
  score?: number;
  account?: string;
  // Filled in by the engine when merging channel results; identifies which
  // NotificationChannel produced this item.
  channel?: string;
}

export interface NotificationChannelResult {
  items: NotificationItem[];
  // Highest sortable id seen in this batch, used as the per-account,
  // per-channel "read up to" watermark. Channels that mix id spaces
  // (e.g. blockchain notification ids vs. account-history indices) are
  // responsible for keeping their own ids monotonic and comparable.
  maxId: number;
}

// One independent feed of notifications (e.g. "mentions/replies/votes" or
// "incoming transfers"). The engine polls every channel and merges the
// results; it never interprets `type` or `msg` itself.
export interface NotificationChannel {
  key: string;
  fetch(username: string, limit: number): Promise<NotificationChannelResult>;
}

export interface NotificationSource {
  channels: NotificationChannel[];
}

export interface NotificationsEngineOptions {
  // localStorage key prefix, default 'bf'.
  storagePrefix?: string;
  pollIntervalMs?: number;
  maxListSize?: number;
  // How many items to request per channel on the lightweight "any new?"
  // poll, as opposed to the full fetch done when the list is opened.
  pollBatchSize?: number;
  // Builds the OS push notification title/body for an item. Returning
  // null skips pushing that item.
  formatPush?: (item: NotificationItem) => { title: string; body: string } | null;
}

export interface NotificationsState {
  show: boolean;
  loading: boolean;
  initializing: boolean;
  list: NotificationItem[];
  hasNew: boolean;
  clickedIds: (number | string)[];
  pushSupported: boolean;
  pushEnabled: boolean;
  // Per-channel, per-account watermarks: lastReadIds.mentions.alice = 123
  lastReadIds: Record<string, Record<string, number>>;
  lastPushedIds: Record<string, Record<string, number>>;
}

export interface AuthLike {
  accounts: { username: string }[];
}
