/**
 * `@/apps/web-daemon` — local types.
 *
 * The web daemon is a thin process that publishes the existing `RuntimeFacade`
 * (constructed by the composition root) over WebSocket so the Tauri shell and
 * the web frontend can drive a real agent session via `SessionTransport`
 * messages (the same wire format the CLI tests exercise).
 *
 * Default-OFF: the daemon is opt-in. No file in `src/apps/cli/`,
 * `src/sdk/`, `src/ipc/`, or `src/protocol/` is modified by this slice; the
 * daemon depends on those barrels from the outside only.
 */

import type { RuntimeFacade, RuntimeSessionConfig } from "@/sdk/runtime"

/**
 * Closed config shape for the daemon. The composition root injects the
 * `runtimeFactory` (so we don't couple to any specific runtime build path);
 * env / argv parsing belongs to the entry script, not to the server itself.
 */
export interface WebDaemonConfig {
  /** TCP port to bind. Default `4096`. */
  readonly port: number
  /** Interface to bind. Default `"127.0.0.1"` (loopback only). */
  readonly bind: string
  /**
   * Optional bearer token. When set, every WS upgrade must carry
   * `Authorization: Bearer <token>` OR `?token=<token>` in the query string
   * (browsers cannot set custom upgrade headers). Compared in constant time.
   */
  readonly authToken: string | undefined
  /**
   * Factory that produces a `RuntimeFacade` for the daemon. We accept a
   * factory (not a built facade) so test code can hand in a stub and the
   * production composition root can hand in the real CLI runtime.
   */
  readonly runtimeFactory: () => Promise<RuntimeFacade>
  /**
   * Default `RuntimeSessionConfig` applied when the client does not (yet)
   * carry one in the upgrade request. Production callers can pass `{}`.
   */
  readonly sessionConfig: RuntimeSessionConfig
}

/** Numbers reported on `GET /health`. */
export interface WebDaemonHealth {
  readonly status: "ok"
  readonly sessions: number
  readonly uptime_ms: number
}

/**
 * Handle returned by `startWebDaemon` so callers (entry script, tests) can
 * stop the server cleanly.
 */
export interface WebDaemonHandle {
  /** Port the server actually bound to (resolves `0` to the OS-chosen port). */
  readonly port: number
  /** Bind address the server actually used. */
  readonly hostname: string
  /** Current count of active WebSocket → session pairs. */
  activeSessions(): number
  /** ms since `startWebDaemon` resolved. */
  uptimeMs(): number
  /** Close every active session AND stop the HTTP/WS listener. Idempotent. */
  stop(): Promise<void>
}
