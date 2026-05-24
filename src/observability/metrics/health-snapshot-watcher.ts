/**
 * ADR-0183: Periodic re-emit + SIGHUP hot-reload watcher around ADR-0180's
 * file-based health snapshot. ADR-0180 writes once at composition time;
 * operators that scrape `~/.quanta/health.json` over a long-running daemon
 * (K8s livenessProbe `periodSeconds: 30`, cron, ad-hoc shell loop) need the
 * file to *track* wiring changes — not freeze at startup.
 *
 * Three-tier drift defense (cited in ADR-0183):
 *   1. **Interval** (default 30s — K8s liveness norm). Catches drift even if
 *      no external trigger fires. systemd `notify` socket parallel: a tiny
 *      well-known file refreshed on heartbeat.
 *   2. **SIGHUP** (POSIX hot-reload convention). Operator scripts and
 *      orchestrators can force a re-emit without waiting for the interval.
 *   3. **Manual `emitNow()`** handle method. Admin RPC + test seam.
 *
 * Parallels with Cursor's 4-tier drift-defense model (cursor-localization.md
 * §17): event-driven (#1 recent_edits overlay, #4 handshake) + interval-driven
 * (#3 60s subtree-walk). Different domain (file-sync vs health-surface) but
 * the *layering* is the absorbed lesson — never trust one channel; combine
 * timer + signal + manual.
 *
 * Plane-clean: imports ONLY `./health-snapshot` (builder/writer) and
 * `./observability-helper` (ObservabilityBag *type*). No `node:os` / `node:fs`
 * direct (delegates to the writer injected via `HealthSnapshotOpts.writeFile`
 * or to the default writer inside `writeHealthSnapshot`). Process API access
 * (`process.on("SIGHUP", ...)`, `setInterval`, `clearInterval`) ONLY when the
 * caller does NOT inject the corresponding test seam.
 *
 * Default-OFF: the snapshot file's lifecycle is unchanged unless the caller
 * explicitly invokes `startHealthSnapshotWatcher()`. ADR-0180's
 * construction-time write semantics are preserved verbatim.
 */

import {
  buildHealthSnapshot,
  type HealthSnapshotOpts,
  writeHealthSnapshot,
} from "./health-snapshot"
import type { ObservabilityBag } from "./observability-helper"

/** Default re-emit cadence: 30s mirrors Kubernetes `periodSeconds: 30` for
 *  livenessProbe — operators that scrape on the same interval see a fresh
 *  snapshot every poll without doubling I/O. */
const DEFAULT_INTERVAL_MS = 30_000

/** Bag accessor shape — same shape as `buildHealthSnapshot`'s `bag` arg.
 *  Per-slot `undefined` signals "this slice not wired right now"; the
 *  watcher polls the accessor on every emit so subsequent wire-ups are
 *  reflected without restart. */
export type BagAccessor = () => {
  readonly [K in keyof ObservabilityBag]: ObservabilityBag[K] | undefined
}

export interface WatcherOpts {
  /** Source of truth: bag accessor. Watcher polls this every interval +
   *  on SIGHUP + on `emitNow()`. NO memoization — late-bound subsystems
   *  appear in the next snapshot. */
  readonly getBag: BagAccessor
  /** Snapshot writer options forwarded to `writeHealthSnapshot` (path,
   *  version, injected writeFile, etc.). When absent the writer's defaults
   *  apply (`~/.quanta/health.json`). */
  readonly snapshot?: HealthSnapshotOpts
  /** Re-emit interval ms. Default 30_000 (K8s liveness norm). Values <= 0
   *  disable the timer (signal + manual still work) — useful when callers
   *  want SIGHUP-only refresh. */
  readonly intervalMs?: number
  /** When true (default), register a `SIGHUP` listener that calls
   *  `emitNow()`. Set false for environments where SIGHUP is reserved
   *  (e.g. shell `disown`'d daemons) or where the caller drives refresh
   *  via a different signal. */
  readonly hotReloadOnSighup?: boolean
  /** Test seam — inject the signal handler registrar. Default uses
   *  `process.on("SIGHUP", handler)`. */
  readonly onSignal?: (sig: "SIGHUP", handler: () => void) => void
  /** Test seam — inject the signal de-registrar. Default uses
   *  `process.removeListener("SIGHUP", handler)`. */
  readonly offSignal?: (sig: "SIGHUP", handler: () => void) => void
  /** Test seam — inject the interval setter. Default uses `setInterval`. */
  readonly setInterval?: (handler: () => void, ms: number) => unknown
  /** Test seam — inject the interval clearer. Default uses
   *  `clearInterval`. */
  readonly clearInterval?: (handle: unknown) => void
  /** Optional warn sink for write failures. Default noop — snapshot is an
   *  operator convenience; a transient write failure must never poison the
   *  watcher (state-cleared on every emit). */
  readonly warn?: (msg: string) => void
}

export interface WatcherHandle {
  /** Stop the watcher: clears the interval timer + removes the SIGHUP
   *  listener. Idempotent — safe to call multiple times. After `stop()`,
   *  the `emitNow()` method is still callable (the primitive lives), but
   *  no automatic re-emits fire. */
  stop(): void
  /** Force immediate re-emit (admin RPC, test seam, or post-config-change
   *  manual trigger). Returns a Promise that resolves AFTER the write
   *  completes — callers can `await` for deterministic confirmation. */
  emitNow(): Promise<void>
}

/** Spawn a watcher that periodically re-writes the snapshot to disk +
 *  re-emits on SIGHUP. Does not own the `MetricsRegistry` — only the
 *  snapshot file's refresh cadence. */
export const startHealthSnapshotWatcher = (opts: WatcherOpts): WatcherHandle => {
  const warn = opts.warn ?? ((_: string) => undefined)
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const hotReloadOnSighup = opts.hotReloadOnSighup ?? true

  const emitNow = async (): Promise<void> => {
    try {
      const bag = opts.getBag()
      const snap = buildHealthSnapshot(bag)
      await writeHealthSnapshot(snap, opts.snapshot)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warn(`health-snapshot-watcher: emit failed: ${msg}`)
      // State NOT poisoned — next interval/signal/manual call retries
      // with fresh bag. Snapshot is operator-facing convenience; a
      // transient EROFS / EACCES must not kill the watcher.
    }
  }

  // Timer wiring (test seam takes precedence over process.setInterval).
  let intervalHandle: unknown = null
  if (intervalMs > 0) {
    const fire = (): void => {
      void emitNow()
    }
    intervalHandle =
      opts.setInterval !== undefined
        ? opts.setInterval(fire, intervalMs)
        : setInterval(fire, intervalMs)
  }

  // SIGHUP wiring (test seam takes precedence over process.on).
  let sigHandler: (() => void) | null = null
  if (hotReloadOnSighup) {
    sigHandler = (): void => {
      void emitNow()
    }
    if (opts.onSignal !== undefined) {
      opts.onSignal("SIGHUP", sigHandler)
    } else {
      process.on("SIGHUP", sigHandler)
    }
  }

  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (intervalHandle !== null) {
      if (opts.clearInterval !== undefined) {
        opts.clearInterval(intervalHandle)
      } else {
        clearInterval(intervalHandle as ReturnType<typeof setInterval>)
      }
      intervalHandle = null
    }
    if (sigHandler !== null) {
      if (opts.offSignal !== undefined) {
        opts.offSignal("SIGHUP", sigHandler)
      } else {
        process.removeListener("SIGHUP", sigHandler)
      }
      sigHandler = null
    }
  }

  return { stop, emitNow }
}
