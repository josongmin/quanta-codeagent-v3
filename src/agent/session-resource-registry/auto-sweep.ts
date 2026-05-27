/**
 * ADR-0369 — Auto-wire `sweepDiskRegistry` + `sweepSqliteRegistry` on
 * `getGlobalSessionResourceRegistry()` first call.
 *
 * # Context
 *
 * ADR-0348 (`sweepDiskRegistry`) + ADR-0361 (`sweepSqliteRegistry`) ship
 * the retention algorithms but NOTHING in the process calls them on a
 * schedule. The disk-store does run a per-`getOrCreate` lazy sweep, but
 * an idle process (no `getOrCreate` traffic) never reclaims. Worse,
 * `sweepSqliteRegistry` has no lazy hook at all. Net effect: unbounded
 * on-disk growth for any caller that opts into a persistent backend.
 *
 * This file owns the auto-wire seam: on `getGlobalSessionResourceRegistry()`
 * first call we may also start a periodic sweep handle. The handle is
 * env-gated so the in-memory default path stays byte-identical.
 *
 * # Trigger policy (env-gated)
 *
 *   - `QUANTA_SESSION_REGISTRY_DISK_DIR`         ⇒ schedule disk sweep
 *   - `QUANTA_SESSION_REGISTRY_SQLITE_PATH`      ⇒ schedule sqlite sweep
 *
 * If BOTH are set, BOTH are swept on every tick (one sweep does not
 * preclude the other — they target different backends). If NEITHER is
 * set, `startAutoSweep` returns a no-op handle and never schedules a
 * timer (no setInterval cost).
 *
 * Note: `QUANTA_SESSION_REGISTRY_SQLITE_PATH` does NOT swap the global
 * registry to the SQLite backend — that is out of scope for this ADR
 * (a follow-up ADR may add the swap on the ADR-0351 pattern). The env
 * var only tells THIS slice "if you are scheduling sweeps anyway,
 * include this path in the sqlite sweep". A composition root that
 * manually mounted the SQLite backend via the factory therefore opts
 * into retention by also setting the env var.
 *
 * # Timing
 *
 *   - On-startup sweep (1×) runs IMMEDIATELY on `startAutoSweep` so a
 *     long-idle process catches accumulated debt on next boot.
 *   - Periodic sweep runs every `intervalMs` (default 60_000 = 1 minute).
 *   - Default justification: 60s is short enough that a heavy-write
 *     burst is reclaimed within a turn or two, long enough that the
 *     CPU/IO budget per tick is < 1% on a steady workload. Codex's
 *     `logs_2.sqlite` daemon runs every 5–15 minutes (memory
 *     `codex-logs-retention-pattern`) but it is a separate process —
 *     in-process we choose a tighter cadence so a single-process
 *     deployment converges within one minute of a burst.
 *
 * # NO-THROW contract
 *
 * Every sweep call is wrapped: a sweep failure (disk full, corrupt DB,
 * permission error) is swallowed. The timer continues; the next tick
 * may succeed. The handle itself is also NO-THROW on `stop` (idempotent;
 * safe to call after construction failure).
 *
 * # Default-OFF
 *
 * `startAutoSweep` is a leaf — only `global.ts` calls it, and only when
 * one of the gated env vars is set. The in-memory default path never
 * hits this file's `setInterval`, so a process that never sets the env
 * var is byte-identical to pre-ADR-0369.
 *
 * # Test reset
 *
 * The companion `resetGlobalSessionResourceRegistry()` in `global.ts`
 * MUST also stop the in-flight handle so test isolation holds. See
 * `global.ts` for the wiring.
 *
 * # Slice fence
 *
 * Imports `./disk-adapter/gc` (sweepDiskRegistry) + `./sqlite-adapter/gc`
 * (sweepSqliteRegistry). No cross-slice imports. No mutation of any
 * existing port or factory.
 */

import { sweepDiskRegistry } from "./disk-adapter/gc"
import { sweepSqliteRegistry } from "./sqlite-adapter/gc"

/** Configuration for `startAutoSweep`. All fields optional. */
export interface AutoSweepConfig {
  /**
   * Interval between periodic sweeps in milliseconds. Default
   * {@link DEFAULT_AUTO_SWEEP_INTERVAL_MS} (60 000 ms). Values <= 0
   * disable the periodic timer (the on-startup sweep still runs).
   */
  readonly intervalMs?: number
  /**
   * Explicit override for the disk dir env var. When provided, used
   * verbatim (empty string still means "not set"). When omitted, the
   * value of `process.env.QUANTA_SESSION_REGISTRY_DISK_DIR` is read.
   */
  readonly diskDir?: string
  /**
   * Explicit override for the sqlite path env var. When provided, used
   * verbatim. When omitted,
   * `process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH` is read.
   */
  readonly sqlitePath?: string
  /**
   * Clock seam. Default `Date.now`. Only forwarded to the underlying
   * sweep configs (TTL math) — the timer itself uses the real clock.
   */
  readonly now?: () => number
  /**
   * Timer scheduler seam. Test override: replace with a fake
   * `setInterval` so the periodic tick is deterministic. Default:
   * global `setInterval`. The returned handle is passed verbatim to
   * `clearInterval` on `stop`.
   */
  readonly setIntervalImpl?: (fn: () => void, ms: number) => NodeJS.Timeout
  /**
   * Timer canceller seam. Default `clearInterval`. Paired with
   * `setIntervalImpl`.
   */
  readonly clearIntervalImpl?: (handle: NodeJS.Timeout) => void
}

/**
 * Handle for a running auto-sweep loop. Returned by `startAutoSweep`.
 * `stop()` and `sweepNow()` are both NO-THROW + idempotent so callers
 * (test harnesses, shutdown hooks) need not branch on "was the timer
 * actually started" state.
 */
export interface AutoSweepHandle {
  /**
   * Stop the periodic timer. Idempotent + NO-THROW: calling `stop()`
   * twice (or on a handle whose env was unset) is a no-op.
   */
  readonly stop: () => void
  /**
   * Force one immediate sweep on all configured backends. Returns a
   * promise that resolves once every backend's sweep settles. NO-THROW:
   * any failure inside a sweep is swallowed and the returned promise
   * still resolves.
   */
  readonly sweepNow: () => Promise<void>
  /**
   * Convenience read for tests + observability: was the periodic timer
   * actually scheduled? `false` when env was unset OR `intervalMs <= 0`.
   */
  readonly scheduled: boolean
}

/**
 * Default sweep cadence (60 000 ms). See file-header §Timing for the
 * justification. Tunable via `AutoSweepConfig.intervalMs`.
 */
export const DEFAULT_AUTO_SWEEP_INTERVAL_MS = 60_000

/**
 * Idempotent no-op handle returned when no env var is set (so no
 * sweep is required). Sharing one constant avoids allocating a closure
 * per call when neither backend is gated.
 */
const NOOP_HANDLE: AutoSweepHandle = {
  stop: () => {
    // No-op — timer was never scheduled.
  },
  sweepNow: async () => {
    // No-op — nothing to sweep.
  },
  scheduled: false,
}

/** Env var names — kept here so the wire is single-sourced. */
const DISK_DIR_ENV = "QUANTA_SESSION_REGISTRY_DISK_DIR"
const SQLITE_PATH_ENV = "QUANTA_SESSION_REGISTRY_SQLITE_PATH"

const resolveDiskDir = (cfg: AutoSweepConfig | undefined): string => {
  // Explicit cfg field wins over env. Empty string is treated as unset
  // (same convention as ADR-0351's disk-dir env var).
  if (typeof cfg?.diskDir === "string") return cfg.diskDir
  const fromEnv = process.env[DISK_DIR_ENV]
  return typeof fromEnv === "string" ? fromEnv : ""
}

const resolveSqlitePath = (cfg: AutoSweepConfig | undefined): string => {
  if (typeof cfg?.sqlitePath === "string") return cfg.sqlitePath
  const fromEnv = process.env[SQLITE_PATH_ENV]
  return typeof fromEnv === "string" ? fromEnv : ""
}

/**
 * Run one sweep over both configured backends. NO-THROW: any error
 * inside `sweepDiskRegistry` or `sweepSqliteRegistry` is swallowed so
 * the timer survives.
 */
const sweepOnce = async (diskDir: string, sqlitePath: string, now: () => number): Promise<void> => {
  if (diskDir.length > 0) {
    try {
      await sweepDiskRegistry({ storageDir: diskDir, now })
    } catch {
      // NO-THROW.
    }
  }
  if (sqlitePath.length > 0) {
    try {
      sweepSqliteRegistry({ databasePath: sqlitePath, now })
    } catch {
      // NO-THROW.
    }
  }
}

/**
 * Start the auto-sweep loop.
 *
 * Behaviour:
 *   - If neither env var is set ⇒ returns a no-op handle. No timer
 *     scheduled, no on-startup sweep.
 *   - If at least one env var is set ⇒ run one immediate sweep
 *     (fire-and-forget; the returned `sweepNow()` can be awaited to
 *     synchronise) AND schedule a periodic sweep every `intervalMs`.
 *
 * The returned handle's `stop()` cancels the timer. Calling
 * `startAutoSweep` twice without calling `stop()` on the first handle
 * schedules TWO timers; callers (only `global.ts`) gate by the
 * singleton's null-check to avoid this.
 *
 * NO-THROW on construction. A misconfigured env var that points to a
 * filesystem the adapter cannot reach degrades to "sweep does nothing"
 * — the timer keeps ticking so a later filesystem change can take effect.
 */
export const startAutoSweep = (cfg?: AutoSweepConfig): AutoSweepHandle => {
  const diskDir = resolveDiskDir(cfg)
  const sqlitePath = resolveSqlitePath(cfg)

  if (diskDir.length === 0 && sqlitePath.length === 0) {
    return NOOP_HANDLE
  }

  const intervalMs = cfg?.intervalMs ?? DEFAULT_AUTO_SWEEP_INTERVAL_MS
  const now = cfg?.now ?? Date.now
  const sched = cfg?.setIntervalImpl ?? setInterval
  const cancel = cfg?.clearIntervalImpl ?? clearInterval

  // On-startup sweep. Fire-and-forget; callers can `await sweepNow()`
  // to synchronise. We DO NOT await here to keep `startAutoSweep`
  // itself synchronous + cheap.
  void sweepOnce(diskDir, sqlitePath, now)

  let timer: NodeJS.Timeout | null = null
  let stopped = false

  if (intervalMs > 0) {
    timer = sched(() => {
      if (stopped) return
      void sweepOnce(diskDir, sqlitePath, now)
    }, intervalMs)
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timer !== null) {
      try {
        cancel(timer)
      } catch {
        // NO-THROW — clearInterval should not throw, but contracts
        // are kept tight regardless.
      }
      timer = null
    }
  }

  const sweepNow = async (): Promise<void> => {
    await sweepOnce(diskDir, sqlitePath, now)
  }

  return { stop, sweepNow, scheduled: timer !== null }
}
