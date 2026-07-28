/**
 * module/notifications
 *
 * A backend-agnostic notification engine. It knows how to poll one or more
 * `NotificationChannel`s, track per-account read/pushed watermarks, fire OS
 * push notifications, and merge everything into a single sorted list.
 *
 * It knows nothing about Blurt, posts, communities, or where in the UI the
 * bell/list end up on screen — that glue lives in `module/notifications_blurt`
 * and in whichever layout mounts `NotifBell.vue` / `NotificationsList.vue`.
 */
import { reactive } from 'vue';
import type {
  AuthLike, NotificationItem, NotificationSource, NotificationsEngineOptions, NotificationsState,
} from './types';

function safeParse<T>(key: string, fallback: T): T {
  try {
    const val = localStorage.getItem(key);
    return val ? JSON.parse(val) : fallback;
  } catch {
    return fallback;
  }
}

function safeStore(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable or full — notifications still work in-memory */ }
}

const defaultFormatPush = (item: NotificationItem) => ({
  title: item.author ? `@${item.author}` : item.type,
  body: item.msg || item.type,
});

export interface NotificationsEngine {
  state: NotificationsState;
  checkNew(isInitial?: boolean): Promise<void>;
  openList(): Promise<void>;
  markClicked(item: NotificationItem): void;
  isUnread(item: NotificationItem): boolean;
  startPolling(): void;
  togglePush(callbacks: { onDenied: () => void; onUnsupported: () => void; onInsecure: () => void; onEnabled?: () => void }): Promise<void>;
}

export function createNotificationsEngine(
  source: NotificationSource,
  auth: AuthLike,
  options: NotificationsEngineOptions = {},
): NotificationsEngine {
  const prefix = options.storagePrefix ?? 'bf';
  const pollIntervalMs = options.pollIntervalMs ?? 60000;
  const maxListSize = options.maxListSize ?? 50;
  const pollBatchSize = options.pollBatchSize ?? 3;
  const formatPush = options.formatPush ?? defaultFormatPush;

  const storageKey = (name: string) => `${prefix}_${name}`;
  const READ_KEY = storageKey('notif_read_ids');
  const PUSHED_KEY = storageKey('notif_pushed_ids');
  const CLICKED_KEY = storageKey('notif_clicked_ids');
  const PUSH_ENABLED_KEY = storageKey('notif_push_enabled');

  const state = reactive<NotificationsState>({
    show: false,
    loading: false,
    initializing: true,
    list: [],
    hasNew: false,
    clickedIds: safeParse(CLICKED_KEY, []),
    pushSupported: 'Notification' in window,
    pushEnabled: safeParse(PUSH_ENABLED_KEY, false),
    lastReadIds: safeParse(READ_KEY, {}),
    lastPushedIds: safeParse(PUSHED_KEY, {}),
  });

  // Other tabs write to the same keys; pick up their watermarks so we don't
  // re-push notifications a sibling tab already surfaced.
  window.addEventListener('storage', (e) => {
    if (e.key === PUSHED_KEY && e.newValue) state.lastPushedIds = JSON.parse(e.newValue);
    if (e.key === READ_KEY && e.newValue) state.lastReadIds = JSON.parse(e.newValue);
  });

  const watermark = (map: Record<string, Record<string, number>>, channel: string, username: string): number =>
    map[channel]?.[username] ?? 0;

  const setWatermark = (map: Record<string, Record<string, number>>, channel: string, username: string, value: number): void => {
    if (!map[channel]) map[channel] = {};
    map[channel][username] = value;
  };

  const checkNew = async (isInitial = false): Promise<void> => {
    if (auth.accounts.length === 0 || state.show) {
      state.initializing = false;
      return;
    }
    if (isInitial) state.initializing = true;

    try {
      let hasAnyNew = false;

      for (const account of auth.accounts) {
        for (const channel of source.channels) {
          const lastRead = watermark(state.lastReadIds, channel.key, account.username);

          // Re-read from localStorage before each channel check so a push
          // fired a moment ago by another tab isn't repeated here.
          state.lastPushedIds = safeParse(PUSHED_KEY, state.lastPushedIds);
          const lastPushed = watermark(state.lastPushedIds, channel.key, account.username) || lastRead;

          const { items, maxId } = await channel.fetch(account.username, pollBatchSize);
          if (!items.length) continue;
          if (maxId > lastRead) hasAnyNew = true;

          if (maxId > lastPushed && state.pushEnabled && !isInitial && !state.show) {
            const toPush = items.filter((it) => typeof it.id === 'number' && it.id > lastPushed);
            // Save the watermark before showing anything, so a slow-to-render
            // push doesn't race a second poll into double-firing.
            setWatermark(state.lastPushedIds, channel.key, account.username, maxId);
            safeStore(PUSHED_KEY, state.lastPushedIds);

            toPush.forEach((item) => {
              const push = formatPush(item);
              if (push) new Notification(push.title, { body: push.body, icon: './favicon.svg' });
            });
          }
        }
      }
      state.hasNew = hasAnyNew;
    } catch {
      // Transient poll failure — try again on the next tick, no need to surface it.
    } finally {
      if (isInitial) state.initializing = false;
    }
  };

  const startPolling = (): void => {
    checkNew(true);
    // Randomized offset so multiple open tabs don't all poll in lockstep.
    const offset = Math.floor(Math.random() * 10000);
    setTimeout(() => {
      setInterval(() => checkNew(), pollIntervalMs);
    }, offset);
  };

  const openList = async (): Promise<void> => {
    state.show = true;
    state.loading = true;
    try {
      const all: NotificationItem[] = [];
      const maxIdsFound: Record<string, Record<string, number>> = {};

      await Promise.all(auth.accounts.map(async (account) => {
        for (const channel of source.channels) {
          try {
            const { items, maxId } = await channel.fetch(account.username, maxListSize);
            items.forEach((item) => all.push({ ...item, account: account.username, channel: channel.key }));
            setWatermark(maxIdsFound, channel.key, account.username, maxId);
          } catch (e) {
            console.warn(`Notification channel "${channel.key}" fetch failed for ${account.username}:`, e);
          }
        }
      }));

      all.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      state.list = all.slice(0, maxListSize);

      let changed = false;
      auth.accounts.forEach((account) => {
        source.channels.forEach((channel) => {
          const found = maxIdsFound[channel.key]?.[account.username];
          if (found && found > watermark(state.lastReadIds, channel.key, account.username)) {
            setWatermark(state.lastReadIds, channel.key, account.username, found);
            changed = true;
          }
        });
      });

      if (changed) {
        safeStore(READ_KEY, state.lastReadIds);
        state.hasNew = false;
      }
    } catch (err) {
      console.error('Notifications: failed to load list:', err);
    } finally {
      state.loading = false;
    }
  };

  const isUnread = (item: NotificationItem): boolean =>
    typeof item.id === 'number'
    && !!item.channel
    && !!item.account
    && item.id > watermark(state.lastReadIds, item.channel, item.account);

  const markClicked = (item: NotificationItem): void => {
    const key = `${item.account || 'unknown'}-${item.id}`;
    if (!state.clickedIds.includes(key)) {
      state.clickedIds.push(key);
      if (state.clickedIds.length > 200) state.clickedIds.shift();
      safeStore(CLICKED_KEY, state.clickedIds);
    }
    state.show = false;
  };

  const togglePush: NotificationsEngine['togglePush'] = async ({ onDenied, onUnsupported, onInsecure, onEnabled }) => {
    if (!state.pushSupported) { onUnsupported(); return; }
    // Browsers return 'denied' immediately outside a secure context, so
    // check explicitly and give the user a clearer reason.
    if (!window.isSecureContext) { onInsecure(); return; }

    if (state.pushEnabled) {
      state.pushEnabled = false;
      safeStore(PUSH_ENABLED_KEY, false);
      return;
    }

    if ('permissions' in navigator) {
      try {
        const status = await (navigator as any).permissions.query({ name: 'notifications' });
        if (status.state === 'denied') { onDenied(); return; }
      } catch { /* Permissions API not available for this query — fall through to requestPermission */ }
    }

    try {
      // Call directly (not via an awaited wrapper) so the browser still
      // attributes the prompt to the user's click gesture.
      const result = await Notification.requestPermission();
      if (result === 'granted') {
        state.pushEnabled = true;
        safeStore(PUSH_ENABLED_KEY, true);
        onEnabled?.();
      } else if (result === 'denied') {
        onDenied();
      }
    } catch (err) {
      console.error('Notification permission request failed:', err);
    }
  };

  return { state, checkNew, openList, markClicked, isUnread, startPolling, togglePush };
}
