# module/player_blurt

Blurt-specific extension of `module/player`. Everything here knows about
Blurt blockchain concepts (posts, payouts, votes, authors, permlinks).

## Files

### `blurt-player-plugin.ts`
Plugin that fetches payout/vote data from the Blurt blockchain when the
current track changes. Writes results to `track.meta` (opaque to the
generic player). The UI for this data lives in `ForumMediaPlayer.vue`.

### `components/ForumMediaPlayer.vue`
Blurt-aware wrapper around the generic `MediaPlayer.vue`. Uses the
player's `#track-actions` slot to inject `PayoutBadge` and `VoteButton`
next to each track — the generic player core sees only a slot, knows
nothing about votes or payouts.

Emits: `openTopic`, `openProfile`, `submitVote`, `openPayoutModal`.

### `components/ForumMedia.ce.vue`
Custom element (`<forum-media>`) registered in `main.ts`. Scans forum
post bodies for media links and registers them with `BFPlayer`.

### `components/ForumMediaContainer.vue`
Wrapper used in forum list views to render a `<forum-media>` element
for each post.

### `components/ForumIframe.ce.vue`
Custom element (`<forum-iframe>`) for embedding iframes (YouTube,
PeerTube fallback).

## Plugin lifecycle

```ts
import { BlurtPlayerPlugin } from 'module/player_blurt/blurt-player-plugin';
BFPlayer.registerPlugin(BlurtPlayerPlugin(rpcClient, auth));
```

The plugin listens to `player.on('trackChange', ...)` and enriches
`track.meta` with `{ payout, voteCount, voted }`. `ForumMediaPlayer`
reads `track.meta` inside the `#track-actions` slot and renders the
Blurt-specific UI.

## Adding a new plugin (e.g. sponsored content)

1. Create `module/player_blurt/sponsored-plugin.ts`
2. Listen to `player.on('next', ...)` to inject a sponsored track:
   ```ts
   player.on('next', () => {
     if (shouldShowAd()) player.addToQueue(buildAdTrack(), 'start');
   });
   ```
3. Optionally call `player.lockSkip()` and `player.unlockSkip()` to
   control whether the user can manually skip past your track.
4. Register with `BFPlayer.registerPlugin(SponsoredPlugin(...))`.
