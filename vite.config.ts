import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { viteExternalsPlugin } from 'vite-plugin-externals';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { viteStaticCopy } from 'vite-plugin-static-copy'; // npm i -D vite-plugin-static-copy
 
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
    // WebTorrent's Service Worker (required for file.streamTo() playback in
    // webtorrent >=2.0) must be served as a plain, unbundled static file at
    // the app's root — Vite doesn't pull files out of node_modules on its
    // own, so we copy it explicitly. This re-copies from whatever
    // `webtorrent` version is actually installed on every dev start / build,
    // so it can never silently go stale after a dependency bump.
    // Ends up served at `${BASE_URL}sw.min.js`, matching SW_PATH in
    // modules/player/webtorrent-pool.ts.
    viteStaticCopy({
      targets: [
        { src: 'node_modules/webtorrent/dist/sw.min.js', dest: '.' },
      ],
    }),
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