import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * Vite config — apps/web-frontend.
 *
 * Build output: `apps/web-frontend/dist/` (default). The Tauri shell
 * points `tauri.conf.json#build.frontendDist` at this path so the bundled binary
 * serves the same SPA the dev server does.
 *
 * Env knobs (build-time, prefix VITE_ as required by Vite):
 *   VITE_QUANTA_WS_URL   — WebSocket URL (default ws://127.0.0.1:4096/)
 *   VITE_QUANTA_AUTH_TOKEN — optional bearer token for daemon auth
 *
 * Dev server port: 5173 (Vite default). Worker D / docs should reference
 * this for the live-reload Tauri dev experience.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    // Bind 0.0.0.0 so phones / other LAN devices on the same Wi-Fi can hit
    // the SPA. The daemon defaults to 0.0.0.0 too; together they let the
    // header's URL pill render a working LAN URL (e.g. http://192.168.x.y:5173/).
    host: true,
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: "dist",
    // "hidden" still emits .map files (for manual/error-reporter upload) but
    // drops the `//# sourceMappingURL=` comment from the shipped JS, so a client
    // opening devtools no longer auto-fetches full un-minified source. Set to
    // `false` if you want to further shrink the Tauri-bundled dist (no prod maps).
    sourcemap: "hidden",
    target: "es2022",
    rollupOptions: {
      output: {
        // IMPORTANT: do NOT manual-chunk the markdown/prism family. `MarkdownMessage`
        // is loaded via `lazy(() => import("./MarkdownMessage"))` (MessageBubble.tsx),
        // and it is the ONLY importer of react-markdown / remark-gfm /
        // react-syntax-highlighter (+ refractor/prismjs/micromark/…). Left un-grouped,
        // Rollup keeps that whole family inside MarkdownMessage's async chunk, so it
        // stays BEHIND the lazy boundary and is fetched only when the first assistant
        // markdown message renders. A previous `vendor-markdown` manualChunk defeated
        // this: it pinned Rollup's `__vitePreload` helper into that chunk and made the
        // entry `modulepreload` it — eagerly loading ~75 KB gzip of markdown/prism on
        // first paint. Regression guard: after `bun run build`, `dist/index.html` must
        // NOT contain a `modulepreload` for a markdown/prism chunk.
        manualChunks(id) {
          if (!id.includes("node_modules")) return
          // Split ONLY react itself into an eager vendor chunk (the entry imports it
          // directly, so it is legitimately part of first paint).
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/scheduler/")
          ) {
            return "vendor-react"
          }
        },
      },
    },
  },
  // vitest config — co-located so a single `vitest` invocation picks up the
  // same module resolution as the dev/build pipeline.
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
})
