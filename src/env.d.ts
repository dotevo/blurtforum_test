/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev-only override for isTVPlatform() -- see .env.tv and `npm run dev:tv`.
   *  Vite substitutes this at build time; a normal `npm run dev`/`build`
   *  (no `--mode tv`) never defines it, so the override branch is
   *  statically dead code on any real/production build. */
  readonly VITE_FORCE_TV?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Allow dynamic property access on window
interface Window {
  [key: string]: unknown;
  app?: { openProfile: (username: string) => void };
  __bfPlayerEnabled?: boolean;
  YT?: import('./modules/player').YTNamespace;
  onYouTubeIframeAPIReady?: () => void;
  whalevault?: import('./modules/whalevault').WVPublicInterface;
  wv_set_polyfill?: (walletName: string, useCid: string, useUrl: string) => void;
  steem_keychain?: Record<string, unknown>;
  hive_keychain?: Record<string, unknown>;
  blurt_keychain?: Record<string, unknown>;
}
