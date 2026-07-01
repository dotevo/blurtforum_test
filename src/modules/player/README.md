# module/player

A generic, dependency-free media player core (audio + YouTube + PeerTube) with
a plugin system. Knows nothing about Blurt, blockchain, posts, or forums —
that knowledge lives in `module/player_blurt` instead.

## Files

- `player.ts` — playback engine, queue, history, playlists, event emitter, plugin host.
- `types.ts` — `MediaTrack`, `PlayerState`, `BFPlayerAPI`, `PlayerPlugin`, etc.

## Using the player in a page

```ts
import { BFPlayer } from 'module/player/player';

BFPlayer.registerTrack({
  type: 'youtube', id: 'dQw4w9WgXcQ',
  author: 'some-id', permlink: 'unique-id', // identity fields, opaque to the core
  title: 'My video',
});

BFPlayer.playTrack(track);
```

`author` / `permlink` exist only as an **identity pair** the core uses for
equality checks (two registrations with the same author+permlink+subId are
merged into one track). The core never interprets them beyond that — call
them whatever makes sense for your app.

## Attaching app-specific data: `meta` and `badge`

`MediaTrack` has two escape hatches for plugins / host apps:

- `meta?: Record<string, unknown>` — opaque data a plugin wants to carry
  alongside the track (e.g. `{ payout: 12.3, voteCount: 4 }`). The core never
  reads this.
- `badge?: { label, variant?, clickable? }` — a small label the **UI**
  renders generically next to the track (e.g. "$12.30", "Sponsored",
  "NEW"). Set `badge` from a plugin's `onTrackChange` handler.

## Plugin API

```ts
BFPlayer.registerPlugin({
  name: 'my-plugin',
  install(player) { /* runs once, can call player.on(...) etc */ },
  onTrackChange(track) { /* runs every time the current track changes */ },
});
```

Plugins can also listen to raw events via `player.on(event, fn)` /
`player.off(event, fn)`. Events: `trackChange`, `play`, `pause`, `next`,
`prev`, `ended`, `volumeChange`, `error`.

### Injecting a track before playback advances

There is no `beforeNext` hook. Instead, listen for `'next'` (emitted
synchronously at the very start of `playNext()`, before the queue is
consulted) and push a track to the **front** of the manual queue:

```ts
player.on('next', () => {
  if (shouldShowSponsoredTrack()) {
    player.addToQueue(buildSponsoredTrack(), 'start');
  }
});
```

`playNext()` always drains the manual queue first, so a track added this way
plays immediately next, ahead of the auto-queue.

### Locking skip

To temporarily prevent the user from manually skipping past the current
track (e.g. while a sponsored/ad track must play for N seconds), call:

```ts
player.lockSkip();
// ... later, e.g. on a timer or when the ad's minimum duration has elapsed:
player.unlockSkip();
```

While locked, manual calls to `playNext()` (e.g. from the UI's skip button)
are ignored. Automatic advancement (`playNext(true)`, triggered when a track
naturally ends) is **not** affected by the lock — plugins are expected to
call `playNext()` themselves when their content should end, not rely on the
lock to control timing.

## Not included here

Anything that interprets `author`/`permlink` as "blockchain post identity",
fetches payouts/votes, or renders Blurt-specific UI (vote buttons, payout
badges, "open post" links) belongs in `module/player_blurt`.
