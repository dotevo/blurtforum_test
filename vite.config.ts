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
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        manualChunks: () => 'index.js',
        entryFileNames: `assets/[name].js`,
        chunkFileNames: `assets/[name].js`,
        assetFileNames: `assets/[name].[ext]`,
      },
    },
  },
});
