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
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return
          if (
            id.includes("/react-markdown/") ||
            id.includes("/remark-gfm/") ||
            id.includes("/react-syntax-highlighter/") ||
            id.includes("/refractor/") ||
            id.includes("/prismjs/") ||
            id.includes("/micromark/") ||
            id.includes("/mdast-util-") ||
            id.includes("/hast-util-") ||
            id.includes("/unist-util-") ||
            id.includes("/remark-") ||
            id.includes("/rehype-")
          ) {
            return "vendor-markdown"
          }
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
