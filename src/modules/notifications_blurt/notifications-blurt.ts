/**
 * module/notifications_blurt
 *
 * The Blurt-specific half of the notifications feature: how to fetch
 * notifications from the chain, how to turn a click into an in-app
 * navigation, and the icon/copy for each notification type. The
 * backend-agnostic engine and UI live in `module/notifications`.
 */
import { Blockchain } from '../blockchain';
import { createNotificationsEngine } from '../notifications/notifications';
import type { AuthLike, NotificationItem } from '../notifications/types';

const NOTIF_ICONS: Record<string, string> = {
  reply: '💬', reply_comment: '💬', vote: '👍', mention: '🔔',
  follow: '👤', reblog: '🔄', transfer: '💰', witness_vote: '🗳️',
};

export const getNotifIcon = (type: string): string => NOTIF_ICONS[type] || '🔵';

// Mentions, replies, votes, follows, etc. — Blurt's own notification feed.
const activityChannel = (client: any) => ({
  key: 'activity',
  async fetch(username: string, limit: number) {
    const list: NotificationItem[] = (await Blockchain.getNotifications(client, username, limit)) || [];
    const maxId = list.length ? Number(list[0].id) : 0;
    return { items: list, maxId };
  },
});

// Incoming transfers, read out of account history and reshaped into the
// same NotificationItem the activity feed uses. History entries are
// `[opIndex, { op: [opType, opData], timestamp }]` tuples.
const transfersChannel = (client: any) => ({
  key: 'transfers',
  async fetch(username: string, limit: number) {
    const history = (await Blockchain.getAccountHistory(client, username, -1, limit)) || [];
    const maxId = history.length ? history[history.length - 1][0] : 0;

    const items: NotificationItem[] = history
      .filter(([, entry]: any) => entry.op[0] === 'transfer' && entry.op[1].to === username)
      .map(([idx, entry]: any) => {
        const tx = entry.op[1];
        return {
          id: idx,
          type: 'transfer',
          author: tx.from,
          date: entry.timestamp,
          msg: `Received ${tx.amount} from @${tx.from}` + (tx.memo ? `: ${tx.memo}` : ''),
          url: `@${tx.from}`,
        };
      });

    return { items, maxId };
  },
});

export interface OpenNotificationCallbacks {
  openTopic: (post: any) => void;
  openProfile: (username: string) => void;
  normalizePost: (raw: any) => any;
  client: any;
  config: any;
  targetNotifPermlink: { value: string | null };
  selectedCommunity: { value: string };
  loading: { value: boolean };
  auth: AuthLike & { user?: { username: string } | null };
  switchAccount: (username: string) => void;
}

export function createBlurtNotifications(client: any, auth: AuthLike, t: (key: string) => string) {
  const engine = createNotificationsEngine(
    { channels: [activityChannel(client), transfersChannel(client)] },
    auth,
    {
      storagePrefix: 'bf',
      formatPush: (item) => ({
        title: item.type === 'transfer' ? `Received transfer` : `Blurt: @${item.author || 'system'}`,
        body: item.msg || item.type,
      }),
    },
  );

  const togglePushNotifications = () => engine.togglePush({
    onUnsupported: () => alert(t('notifUnsupported')),
    onInsecure: () => alert(t('notifInsecureContext')),
    onDenied: () => alert(t('notifPermissionDenied')),
    onEnabled: () => new Notification('BlurtForum', { body: t('notifEnabledBody'), icon: './favicon.svg' }),
  });

  // Resolves a clicked notification into an in-app navigation: switch to
  // the account it belongs to if needed, then either open the target
  // profile or fetch and open the target post (walking up to its root if
  // it's a reply, and following a locked/community redirect if needed).
  const openNotification = async (notif: NotificationItem, callbacks: OpenNotificationCallbacks): Promise<void> => {
    engine.markClicked(notif);

    if (notif.account && callbacks.auth.user?.username !== notif.account) {
      callbacks.switchAccount(notif.account);
    }

    if (!notif.url) return;
    callbacks.loading.value = true;
    try {
      const [rawAuthor, permlink] = notif.url.split('/');
      const author = rawAuthor.replace('@', '');
      if (!permlink) {
        callbacks.openProfile(author);
        return;
      }

      const content = await Blockchain.getContent(callbacks.client, author, permlink);
      if (!content?.author) return;

      let root = content;
      if (content.parent_author) {
        const urlParts = content.url.split('#')[0].split('/');
        if (urlParts.length >= 4) {
          const rootAuthor = urlParts[2].replace('@', '');
          const rootPermlink = urlParts[3];
          if (rootAuthor !== author || rootPermlink !== permlink) {
            root = await Blockchain.getContent(callbacks.client, rootAuthor, rootPermlink);
          }
        }
      }

      const targetCommunity = root.category;
      if (targetCommunity?.startsWith('blurt-') && targetCommunity !== callbacks.config.communityAccount && !callbacks.config.lockedCommunity) {
        callbacks.config.communityAccount = targetCommunity;
        callbacks.selectedCommunity.value = targetCommunity;
      }

      callbacks.targetNotifPermlink.value = permlink;
      callbacks.openTopic(callbacks.normalizePost(root));
    } catch (err) {
      console.error('Failed to open notification target:', err);
    } finally {
      callbacks.loading.value = false;
    }
  };

  return { ...engine, openNotification, togglePushNotifications, getNotifIcon };
}
