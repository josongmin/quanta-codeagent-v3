/**
 * `@/apps/web-daemon` — bun process that publishes the agent SDK over WS.
 *
 * Default-OFF surface. Run:
 *   `bun run src/apps/web-daemon/index.ts`
 * or via the `web:daemon` script in `package.json`.
 *
 * Env knobs (all optional):
 *   QUANTA_WEB_PORT        - TCP port (default `4096`)
 *   QUANTA_WEB_BIND        - bind address (default `0.0.0.0` so LAN
 *                            devices on the same Wi-Fi reach the daemon;
 *                            set `127.0.0.1` to restrict to loopback)
 *   QUANTA_WEB_AUTH_TOKEN  - bearer token; when set, every WS upgrade
 *                            must carry `Authorization: Bearer <token>`
 *                            or `?token=<token>` in the URL
 *
 * The daemon remains library-shaped first, but when no explicit
 * `runtimeFactory` override is supplied we lazily load the production
 * composition root. This keeps tests injectable while making compiled
 * sidecar binaries independent of `import.meta.main` quirks.
 */

import { createObservabilityEmitter } from "./observability-emitter"
import { startWebDaemon } from "./server"
import type { WebDaemonConfig, WebDaemonHandle } from "./types"

const DEFAULT_PORT = 4096
const DEFAULT_BIND = "0.0.0.0"

const parsePort = (raw: string | undefined): number => {
  if (raw === undefined || raw.length === 0) return DEFAULT_PORT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`web-daemon: invalid QUANTA_WEB_PORT="${raw}" — must be integer 0..65535`)
  }
  return n
}

const parseBind = (raw: string | undefined): string => {
  if (raw === undefined || raw.length === 0) return DEFAULT_BIND
  return raw
}

const parseAuthToken = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw.length === 0) return undefined
  return raw
}

/**
 * Boot the daemon. Accepts an optional override so test code (and a future
 * composition root) can inject a real `runtimeFactory` without parsing env.
 *
 * Without an injected factory, the entry script throws — better to fail loud
 * than to boot a daemon that cannot serve a session.
 */
export const main = async (overrides?: Partial<WebDaemonConfig>): Promise<WebDaemonHandle> => {
  const runtimeFactory =
    overrides?.runtimeFactory ?? (await import("./runtime-factory")).buildProductionRuntimeFactory()
  const config: WebDaemonConfig = {
    port: overrides?.port ?? parsePort(process.env.QUANTA_WEB_PORT),
    bind: overrides?.bind ?? parseBind(process.env.QUANTA_WEB_BIND),
    authToken:
      overrides?.authToken !== undefined
        ? overrides.authToken
        : parseAuthToken(process.env.QUANTA_WEB_AUTH_TOKEN),
    runtimeFactory,
    sessionConfig: overrides?.sessionConfig ?? {},
  }

  // Port-collision fallback: if the requested port is taken (EADDRINUSE
  // surfaces as `Failed to start server. Is port X in use?` from Bun),
  // retry with `port: 0` so the OS picks a free port. The actual bound
  // port is exposed on `handle.port` for the shell to publish to the
  // frontend. Opt out with `QUANTA_WEB_STRICT_PORT=1`.
  let handle: WebDaemonHandle
  try {
    handle = await startWebDaemon(config)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const strict = process.env.QUANTA_WEB_STRICT_PORT === "1"
    if (strict || !msg.toLowerCase().includes("port")) throw error
    process.stderr.write(
      `web-daemon: port ${config.port} in use — falling back to OS-picked port\n`,
    )
    handle = await startWebDaemon({ ...config, port: 0 })
  }
  process.stderr.write(`web-daemon: listening on ${handle.hostname}:${handle.port}\n`)

  // ADR-0406 — observability emitter (Running/Waiting/Completed + Objective +
  // Approvals pane on the frontend). Default-OFF: the emitter only ticks when
  // `QUANTA_OBSERVABILITY=on` AND ports are injected by the composition root.
  // Wiring the runtime-side ports is a follow-up; here we initialise the
  // scaffold so the env knob is real today and the no-port path stays silent.
  if (process.env.QUANTA_OBSERVABILITY === "on") {
    createObservabilityEmitter({})
    process.stderr.write("web-daemon: observability emitter scaffold ready\n")
  }

  const shutdown = async (sig: NodeJS.Signals): Promise<void> => {
    try {
      await handle.stop()
    } finally {
      // Exit code 0 — graceful shutdown is the happy path.
      void sig
      process.exit(0)
    }
  }

  // Only install signal handlers when running as a script — tests use
  // `main({...})` and tear down via `handle.stop()`.
  if (import.meta.main) {
    process.once("SIGINT", () => void shutdown("SIGINT"))
    process.once("SIGTERM", () => void shutdown("SIGTERM"))
  }

  return handle
}

if (import.meta.main) {
  void (async (): Promise<void> => {
    try {
      await main()
    } catch (error: unknown) {
      process.stderr.write(
        `web-daemon: fatal: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exit(1)
    }
  })()
}
