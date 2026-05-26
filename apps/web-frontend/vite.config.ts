import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * Vite config — apps/web-frontend.
 *
 * Build output: `apps/web-frontend/dist/` (default). Worker D's Tauri shell
 * will point `tauri.conf.json#distDir` at this path so the bundled binary
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
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
  // vitest config — co-located so a single `vitest` invocation picks up the
  // same module resolution as the dev/build pipeline.
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
})
