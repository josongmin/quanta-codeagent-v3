/**
 * #15 — scriptable statusLine DRIVER (the missing production consumer).
 *
 * `status-command-runner.ts` built `runStatusCommand` / `buildStatusPayload`
 * but NOTHING in prod called them (built-not-wired). This driver closes that
 * gap: on each tick it assembles a fresh {@link SessionStatusView}, runs the
 * operator's statusLine command, and routes the rendered line INTO the pills
 * composer (NOT `statusBar.setDefault` directly — the pills row owns that slot,
 * so a direct write would clobber it). The status line therefore renders as an
 * extra pills SEGMENT, visible alongside the workspace / mode / skills pills.
 *
 * Cadence: an initial {@link StatusLineDriver.tick} paints the line at session
 * start (mirrors how pills paint at t0); when the operator config carries a
 * `refreshInterval`, {@link StatusLineDriver.start} arms a poll at the clamped
 * interval ({@link resolveRefreshIntervalMs}, min 1s). With NO `refreshInterval`
 * the line is painted ONCE at start and on each explicit `tick()` — there is no
 * per-turn event refresh yet (a documented follow-up, not a silent cap).
 *
 * DOUBLE-gated default-OFF upstream: `runtimeConfig().statusLineConfig` is
 * `undefined` unless BOTH `QUANTA_STATUS_LINE` is on AND a valid
 * `QUANTA_STATUS_LINE_CONFIG` JSON parses, so the composition root only
 * constructs a driver when the config exists — byte-identical when OFF.
 */

import {
  buildStatusPayload,
  resolveRefreshIntervalMs,
  runStatusCommand,
  type SessionStatusView,
  type StatusLineConfig,
  type StatusSpawner,
} from "./status-command-runner"
import type { StatusPills } from "./status-pills"

export interface StatusLineDriver {
  /** Run the command once and route its first line into the pills segment.
   *  Never throws (a status line must not break the REPL). A degraded /
   *  empty result leaves the prior segment untouched (no clobber). */
  tick(): Promise<void>
  /** Arm the poll timer iff the config carries a `refreshInterval`. Idempotent
   *  — a second call while armed is a no-op. */
  start(): void
  /** Disarm the poll timer. Idempotent. */
  stop(): void
}

export interface CreateStatusLineDriverOpts {
  /** Operator statusLine config (already gated/parsed upstream — defined). */
  readonly cfg: StatusLineConfig
  /** LIVE view thunk — re-read on every tick so cost / effort stay current. */
  readonly view: () => SessionStatusView
  /** Sink: only `update` is used — the status line is one pills SEGMENT. */
  readonly pills: Pick<StatusPills, "update">
  /** Truncation width (visible cols). Defaults to the status row width. */
  readonly width?: number
  /** Test seam — deterministic spawner (no real subprocess). */
  readonly spawn?: StatusSpawner
}

export const createStatusLineDriver = (opts: CreateStatusLineDriverOpts): StatusLineDriver => {
  const intervalMs = resolveRefreshIntervalMs(opts.cfg.refreshInterval)
  let timer: ReturnType<typeof setInterval> | undefined

  const tick = async (): Promise<void> => {
    const payload = buildStatusPayload(opts.view())
    const res = await runStatusCommand(opts.cfg, payload, {
      ...(opts.width !== undefined ? { width: opts.width } : {}),
      ...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
    })
    // Only paint a NON-degraded, non-empty line. A degrade (timeout / spawn
    // error / non-zero exit) keeps the prior pills row — never blank it out.
    if (!res.degraded && res.text !== "") {
      opts.pills.update({ statusLine: res.text })
    }
  }

  return {
    tick,
    start: (): void => {
      if (intervalMs === undefined || timer !== undefined) return
      timer = setInterval(() => void tick(), intervalMs)
      // Don't keep the event loop alive solely for the status poll.
      ;(timer as { unref?: () => void }).unref?.()
    },
    stop: (): void => {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    },
  }
}
