/**
 * ADR-0361 — SQLite adapter for `SessionResourceRegistry` (types).
 *
 * Codex `logs_2.sqlite` parity:
 *   - `journal_mode = WAL`           — concurrent readers + non-blocking writer
 *   - `synchronous = NORMAL`         — safe under WAL, faster than FULL
 *   - `foreign_keys = ON`            — cascading deletes on session evict
 *   - `PRAGMA wal_checkpoint(PASSIVE)` — non-blocking WAL drain in sweep
 *
 * Defaults mirror Codex's observed steady-state (cumulative ~14 GB DB
 * after ~10 days of heavy usage stabilises by the sliding-window GC).
 * See `memory/codex-logs-retention-pattern.md` for the verbatim
 * production calibration (4.4 M rows × 3.6 KB avg, 14.8 GB DB + 14 GB
 * WAL).
 *
 * The default `maxTotalBytes` (14 GB) and `ttlMs` (14 d) MAY be
 * overridden by callers — the values are tunables, not invariants. Both
 * apply in `sweepSqliteRegistry`; the steady-state is
 * `min(ttl-cutoff, sliding-window-cutoff)`.
 *
 * # R10 retry note (this slice is ADR-0361, not the aborted ADR-0357)
 *
 * The R10 worktree (commit 034b7f43) introduced a *self-shaped* port
 * (`recordEvent` / `recordCache` / `loadEvents`) that did not match
 * main's ADR-0345 `SessionResourceRegistry` (`getOrCreate` / `peek` /
 * `evict` / `size` / `clear`) — cherry-pick aborted. This slice
 * implements the SQLite backend behind the SAME `SessionResourceRegistry`
 * port the in-memory + disk-jsonl siblings already satisfy.
 */

/** Tunable knobs for the SQLite adapter. */
export interface SqliteRegistryConfig {
  /**
   * Absolute path to the SQLite database file. `":memory:"` is supported
   * for tests; production callers MUST pass a real path so WAL works.
   * The parent directory MUST exist; the adapter does NOT mkdir.
   */
  readonly databasePath: string
  /**
   * Time-to-live for a session in milliseconds. Sessions whose
   * `last_touched` is older than `now() - ttlMs` are evicted by
   * `sweepSqliteRegistry`. Defaults to {@link DEFAULT_TTL_MS} (14 days).
   */
  readonly ttlMs?: number
  /**
   * Maximum total `estimated_bytes` across all sessions. When the
   * cumulative sum (ORDER BY last_touched DESC) exceeds this, older
   * sessions are evicted by `sweepSqliteRegistry`. Defaults to
   * {@link DEFAULT_MAX_TOTAL_BYTES} (14 GB — Codex production
   * calibration).
   */
  readonly maxTotalBytes?: number
  /**
   * Clock injection seam. Defaults to `Date.now`. Tests override to
   * exercise TTL / sliding-window deterministically.
   */
  readonly now?: () => number
  /**
   * ADR-0375 — WAL-size escalation threshold (bytes). When provided AND
   * the `<databasePath>-wal` file exceeds this size at sweep time,
   * `sweepSqliteRegistry` upgrades the PASSIVE checkpoint to RESTART so
   * the WAL is fully drained.
   *
   * Codex `logs_2.sqlite` production calibration: 14.8 GB DB + 14 GB
   * WAL after ~10 days. PASSIVE may complete without shrinking the WAL
   * (writers proceed concurrently; the WAL keeps growing). RESTART
   * blocks new writers until the WAL is drained — safe but briefly
   * pauses writes. Sibling TRUNCATE (drop WAL to size 0) is intentionally
   * NOT done here; see ADR-0375 §Non-goals.
   *
   * Absent ⇒ PASSIVE-only (ADR-0361 byte-identical behaviour).
   */
  readonly walSizeThresholdBytes?: number
}

/**
 * 14 days. Matches Codex `logs_2.sqlite` empirical ~10-day stabilisation
 * with headroom for weekend bursts.
 */
export const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000

/**
 * 14 GB — matches Codex `logs_2.sqlite` empirical cap after ~10 days of
 * heavy use (14.8 GB DB + 14 GB WAL stabilisation point). The sliding
 * window in `sweepSqliteRegistry` clips total bytes back below this.
 */
export const DEFAULT_MAX_TOTAL_BYTES = 14 * 1024 * 1024 * 1024
