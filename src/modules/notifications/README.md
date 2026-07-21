# module/notifications

A backend-agnostic notification engine (polling, read/pushed watermarks, OS
push) plus presentation-only Vue components. Knows nothing about Blurt,
accounts, posts, or where in the UI it gets mounted — that knowledge lives in
`module/notifications_blurt`, mirroring the `module/player` /
`module/player_blurt` split.

## Files

- `notifications.ts` — the engine: `createNotificationsEngine(source, auth, options)`.
- `types.ts` — `NotificationItem`, `NotificationChannel`, `NotificationSource`, etc.
- `components/NotifBell.vue` — the bell button. Pure props/emit, drop it anywhere.
- `components/NotificationsList.vue` — just the list rows, no surrounding chrome.
- `components/NotifModal.vue` — wraps the list in a modal, for layouts that want that.

## Sourcing notifications: `NotificationChannel`

The engine doesn't know how to fetch anything itself. It polls one or more
independent `NotificationChannel`s and merges their results:

```ts
interface NotificationChannel {
  key: string;
  fetch(username: string, limit: number): Promise<{ items: NotificationItem[]; maxId: number }>;
}
```

Each channel owns its own id space (`maxId` is only ever compared against
watermarks for that same channel), so it's fine to combine sources whose ids
don't relate to each other at all — e.g. Blurt's app-side notification feed
and its on-chain transfer history, see `module/notifications_blurt`.

## Using the engine in a page

```ts
import { createNotificationsEngine } from 'module/notifications/notifications';

const notifications = createNotificationsEngine(mySource, auth, { storagePrefix: 'bf' });
notifications.startPolling();

// in the template
<NotifBell :has-new="notifications.state.hasNew" @click="notifications.openList" />
```

`NotificationsList` needs an `isUnread(item)` predicate rather than raw
watermark data — use `notifications.isUnread`, don't reimplement it in the
host app.

## Where notifications render is not this module's problem

`NotifBell` and `NotificationsList` are plain props/emit components with no
opinion on layout. The classic forum wraps the list in `NotifModal`; cinema
mode renders `NotificationsList` directly inside its own rail-anchored panel
(see `module/cinema/CinemaRail.vue`). Both consume the exact same engine
state and list markup — only the surrounding chrome differs.

## Not included here

Fetching real notifications, deciding what counts as a "transfer" vs a
"mention", resolving a clicked notification into an app-side post view,
localized push copy — all of that is Blurt-specific and belongs in
`module/notifications_blurt`.
