/**
 * modules/player/webtorrent-shims.d.ts
 *
 * Neither `webtorrent` (v3.x, ESM-only) nor `indexeddb-chunk-store` ship
 * TypeScript types, and there's no @types package for either. We only ever
 * touch them through webtorrent-pool.ts, and everything there is already
 * typed `any` at the boundary on purpose — these declarations just tell TS
 * the modules exist, so `import()` doesn't fail the build with TS7016.
 */
declare module 'webtorrent';
declare module 'indexeddb-chunk-store';
