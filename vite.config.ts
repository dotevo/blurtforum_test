import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { viteExternalsPlugin } from 'vite-plugin-externals';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
 
const compilerOptions = {
  isCustomElement: (tag: string) => tag.startsWith('forum-')
};
 
// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    // Must run first: it needs to intercept module resolution/esbuild
    // pre-bundling *before* other plugins touch the code, or the Buffer/
    // process/global injection silently doesn't apply to deps like webtorrent.
    nodePolyfills({
      include: ['buffer', 'events', 'stream', 'process', 'util', 'path', 'http', 'https', 'fs', 'os'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      protocolImports: true, // handles `node:buffer` style imports some deps use
    }),
    vue({ template: { compilerOptions } }),
    viteExternalsPlugin({
      '@beblurt/dblurt': 'dblurt',
    }),
    basicSsl(),
    // NOTE: there used to be a viteStaticCopy() step here copying
    // node_modules/webtorrent/dist/sw.min.js into the build output, with a
    // comment claiming it "ends up served at ${BASE_URL}sw.min.js, matching
    // SW_PATH in modules/player/webtorrent-pool.ts". Verified false on both
    // counts while investigating a font-subsetting question: (1)
    // webtorrent-pool.ts passes `swPath: './sw.js'` explicitly -- the app
    // has its own hand-built service worker at public/sw.js (see its own
    // header comment, build tag "wtp-sw-3-fixed-verbose-en"), copied to
    // dist/ automatically by Vite's normal public/ handling, no plugin
    // needed; sw.min.js was never registered by anything. (2) even the copy
    // itself wasn't landing where the comment said -- `dest: '.'` with this
    // plugin version preserved the full source path, so it actually ended
    // up at dist/node_modules/webtorrent/dist/sw.min.js, not dist/sw.min.js.
    // Removed entirely, along with the `webtorrent` and
    // `vite-plugin-static-copy` packages from package.json (neither is
    // referenced by anything else -- webtorrent itself is loaded from a CDN
    // URL at runtime by torrent-lib.js, see that file's own header comment).
  ],
  server: {
    host: true, // Listen on all interfaces (needed for mobile testing)
  },
  // Set base to './' for local file serving, or override with VITE_BASE env var.
  // GitHub Pages deploys to /<repo-name>/ so the workflow sets base via env.
  base: process.env.VITE_BASE ?? './',
  build: {
    outDir: 'dist',
    // NOTE: removed `cssCodeSplit: false` and the `manualChunks: () => 'index.js'` /
    // fixed filename overrides that used to be here. That config forced every
    // route, every modal, and every heavy on-demand dependency (apexcharts,
    // the whole player+webtorrent stack) into a single JS/CSS file loaded on
    // first paint — which silently defeated all the defineAsyncComponent()
    // lazy-loading already written in App.vue. Letting Rollup's default
    // output naming + chunking do its job (content-hashed filenames, one
    // chunk per async import) cuts the initial transfer from ~478 KB gzip
    // down to ~310 KB gzip with zero other code changes, since apexcharts
    // (~136 KB gzip) and the player (~17 KB gzip) now only load when their
    // async component is actually mounted.
    //
    // If you want the async chunks placed in a subfolder for tidiness, use
    // `chunkFileNames: 'assets/chunks/[name]-[hash].js'` instead of removing
    // this block entirely — just don't collapse everything back into one
    // name.
  },
});