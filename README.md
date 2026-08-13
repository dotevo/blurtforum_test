# BlurtForum — Vite + Vue 3 + TypeScript

A decentralised community forum powered by the [Blurt blockchain](https://blurt.blog).

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | Vue 3 (Composition API, `<script setup>`) |
| Language | TypeScript (strict mode) |
| Build tool | Vite |
| Styling | Plain CSS (original `style.css` — unchanged) |
| Blockchain client | `@beblurt/dblurt` (loaded from CDN) |
| Markdown | `marked` + `DOMPurify` |
| Crypto | `crypto-js` |

## Project structure

```
src/
├── main.ts                  # App entry point
├── style.css                # All styles (unchanged from original)
├── env.d.ts                 # Vite + CDN global type declarations
├── App.vue                  # Root component — full Vue template
├── types/
│   └── index.ts             # Shared TypeScript types
├── modules/
│   ├── auth.ts              # PIN-based key encryption (AuthService)
│   ├── community.ts         # Community list & subscription (BFCommunity)
│   ├── parser.ts            # Markdown + media embedding (Parser)
│   ├── player.ts            # Audio/video PiP player (BFPlayer)
│   ├── utils.ts             # Date, permlink, payout helpers (BFUtils)
│   ├── translations.ts      # i18n facade
│   ├── translations.raw.ts  # Raw translation strings (en / pl / eo)
│   └── whalevault.ts        # WhaleVault extension interface + polyfill
└── composables/
    ├── useApp.ts            # Main app logic (orchestration)
    ├── useAuth.ts           # Authentication and multi-account logic
    ├── useGlobalActivity.ts # Global activity feed management
    ├── useNotifications.ts  # Notifications management logic
    ├── useProfile.ts        # User profile and earnings logic
    ├── useTitle.ts          # Document title management logic
    ├── useVote.ts           # Voting logic and modal state
    └── useWallet.ts         # Wallet operations (transfers, power)
```

## Local development

```bash
npm install
npm run dev        # Vite dev server at http://localhost:5173
npm run dev:tv     # same, but forces TV-only UI (device profiles, etc.)
                    # without needing real TV hardware -- see docs/tv-vs-phone.md
```

This app ships as a single APK that behaves differently on phones vs.
Android TV **at runtime**, not via separate builds — see
[`docs/tv-vs-phone.md`](docs/tv-vs-phone.md) before touching anything
gated on `isTVPlatform` or `cinemaMode`.

## Build

```bash
npm run build      # type-check + production build → dist/
npm run preview    # serve dist/ locally
```

## Routing & SEO

The application is a Single Page Application (SPA) designed to be hosted on GitHub Pages without a backend.
To optimize search engine indexing (specifically for Googlebot, which runs client-side JavaScript) and prevent duplicate content penalties:
- **Crawlable Navigation**: All major transitions (changing communities, categories, forums, topics, and profiles) use standard HTML anchor tags (`<a>`) with valid `href` query parameters (e.g., `?community=...&view=...`).
- **SPA Interception**: When users click these links, Vue event handlers intercept the clicks (`@click.prevent`) to transition instantly without a page reload, while crawlers can discover and extract the `href` paths to index the entire forum graph.
- **URL Cleanups & Canonical Scope**: To prevent indexing a single topic/post under 500 different community parameters (duplicate content), the `community` parameter is dropped from URLs during exploration/virtual forum browsing, profile views, and when a topic does not belong to the active community. Similarly, generated template links `<a>` to profiles and non-community-matching posts do not include the `community` parameter.

## GitHub Pages deployment

The workflow at `.github/workflows/deploy.yml` handles everything automatically.

### One-time setup

1. Go to **Settings → Pages** and set **Source** to **GitHub Actions**.
2. *(Project sites only)* The workflow auto-detects the repo name and sets `VITE_BASE`
   to `/<repo-name>/`. If you use a **custom domain** or a **user/org site** (served at `/`),
   add a repository **Variable** named `VITE_BASE` with value `/`.

### Workflow summary

| Trigger | Steps |
|---------|-------|
| Push to `main` | `npm ci` → type-check → Vite build → deploy to Pages |
| Manual (Actions tab) | Same via "Run workflow" button |
