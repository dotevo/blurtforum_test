# TV vs. phone: one APK, two behaviors

This app ships as **one APK** installed on both phones and Android TV
devices. Which behaviors apply is decided **at runtime**, not at build
time — there is no separate "TV build" and "phone build".

## The two signals, and why they're different

### `isTVPlatform` (`src/modules/native/platform-info.ts`)

- Backed by a real native Capacitor plugin
  (`android/app/src/main/java/pl/blurt/forum/PlatformInfoPlugin.java`),
  which asks Android directly via
  `PackageManager.hasSystemFeature(FEATURE_LEANBACK)` — the same check
  Google's own Android TV documentation recommends. Not a user-agent
  guess, not a screen-size heuristic.
- **Immutable at runtime.** A phone is never going to suddenly report
  `isTVPlatform === true`, and vice versa.
- On web/desktop builds (no Capacitor native layer available), this is a
  plain `ref(false)` — see the fallback in `platform-info.ts`.
- **Use this to gate anything that only makes sense on an actual TV
  device**, regardless of what UI mode the user has chosen: the
  device-profiles PIN picker (`modules/device-profiles/`), hiding
  logout/switch-account from the cinema rail (nobody should be able to
  accidentally sign a shared living-room TV out), per-profile
  vote/comment visibility restrictions, hiding the "Cinema" toggle itself
  (there's nothing to toggle — TV is always in cinema mode).

### `cinemaMode` (`src/composables/useApp.ts`)

- A plain user preference, persisted to `localStorage`, toggleable via the
  "Cinema" button in Settings (hidden on TV — see above — since there's
  nothing to toggle there).
- Defaults to `true` automatically on TV (see the `watch` below), and to
  a UA-sniffing best-guess everywhere else — but the guess is just a
  starting point; the user can always override it. **A phone user can
  turn this on** to get the full-bleed, rail-navigated "theater" UI.
- **Use this to gate the cinema/theater UI itself** (the rail navigation,
  full-bleed video, D-pad-friendly layout) — anything that's a nice
  *experience* rather than a TV-only *capability*.

### The guarantee that keeps them in sync where it matters

```ts
// useApp.ts
watch([isTVPlatform, cinemaMode], ([isTV, cm]) => {
  if (isTV && !cm) setCinemaMode(true);
}, { immediate: true });
```

On real TV hardware, this **forces** `cinemaMode` on and keeps it on —
not just a UI nicety (the toggle button is hidden), an actual invariant:
nothing in the app can leave a TV sitting on the non-cinema UI, even
transiently. Off TV, this watcher never fires (`isTV` is always `false`),
so `cinemaMode` behaves exactly like an ordinary user setting.

## The rule of thumb

| Question | Use |
|---|---|
| "Does this only make sense because we're physically on a TV (shared device, remote control, living room)?" | `isTVPlatform` |
| "Is this about which visual *mode* the user is currently browsing in?" | `cinemaMode` |

When in doubt: **`isTVPlatform` is the one true "am I on a TV" check.**
Never infer TV-ness from `cinemaMode`, screen width, or anything else —
a phone user with `cinemaMode` on must never end up seeing TV-only UI
(profile PIN gate, etc.), and that's only guaranteed if TV-only features
check `isTVPlatform` directly rather than assuming `cinemaMode` implies TV.

## Not to be confused with: `.env.tv` / `npm run dev:tv`

This is a **separate, dev-only, build-time** convenience —
`VITE_FORCE_TV=true` (see `.env.tv`) forces `isTVPlatform` to `true` in a
regular desktop/mobile browser during local development, so TV-only UI
(device profiles, D-pad navigation) can be iterated on without needing
real TV hardware or an emulator running.

**It has no effect on the real APK.** A production build always uses the
real native plugin, regardless of which `npm run` script built the web
assets that got packaged into it. There is exactly one APK build; TV vs.
phone is decided by `PlatformInfoPlugin` at runtime, every time, on
whatever device the APK happens to be running on.
