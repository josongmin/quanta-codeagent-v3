/**
 * ADR-0361 — Sliding-window + TTL GC for the SQLite adapter.
 *
 * Codex `logs_2.sqlite` verbatim retention SQL (memory
 * `codex-logs-retention-pattern`):
 *
 * ```sql
 * SELECT … , SUM(estimated_bytes) OVER (…) AS cumulative_estimated_bytes
 *   FROM feedback_logs
 *   WHERE cumulative_estimated_bytes <= ?
 * DELETE FROM logs WHERE ts < ?
 * PRAGMA wal_checkpoint(PASSIVE)
 * ```
 *
 * Codex applies (1) a cumulative-bytes sliding window to keep the
 * total under a configured cap and (2) a TTL fallback to drop rows
 * older than N days regardless of size. We replicate both, but at
 * SESSION granularity (not per-row) because the registry's unit of
 * eviction is a whole session.
 *
 * The order matters:
 *   1. **TTL cutoff first**     — drop sessions older than the cutoff
 *      so they cannot consume budget below.
 *   2. **Sliding window**       — `SUM(total_estimated_bytes) OVER (ORDER BY
 *      last_touched DESC)` so the OLDEST sessions get evicted first.
 *   3. **PASSIVE checkpoint**   — non-blocking WAL drain so the
 *      delete actually shrinks the on-disk DB.
 *
 * # Sliding-window SQL — how it differs from Codex
 *
 * Codex's `WHERE cumulative_estimated_bytes <= ?` KEEPS rows under the
 * cap. We use the inverse — `WHERE cum > ?` — to identify rows TO
 * EVICT, then `DELETE FROM sessions WHERE session_id IN (...)` with
 * the FK cascade dropping the dependent `events` + `cache_entries`.
 * Functionally equivalent; the inverse form is easier to express with
 * a `DELETE`.
 *
 * `ORDER BY last_touched DESC` makes the window prefer to keep RECENT
 * sessions; the cumulative sum walks from newest → oldest, so once
 * the cumulative-sum exceeds the cap, every OLDER session is
 * candidate for eviction.
 *
 * # NO-THROW
 *
 * Every step is wrapped: a corrupt DB / locked table / disk-full
 * degrades to "no rows evicted". The checkpoint specifically NO-THROWS
 * because PASSIVE is allowed to be a no-op (some SQLite builds report
 * SQLITE_BUSY when the WAL is mid-write — that is the expected non-
 * blocking failure mode).
 */

import { Database } from "bun:sqlite"
import { statSync } from "node:fs"
import { applyMigrations } from "./schema"
import { DEFAULT_MAX_TOTAL_BYTES, DEFAULT_TTL_MS, type SqliteRegistryConfig } from "./types"

/** Result of one `sweepSqliteRegistry` invocation, for observability. */
export interface SweepResult {
  /** Sessions evicted by the TTL cutoff. */
  readonly evictedByTtl: number
  /** Sessions evicted by the cumulative-bytes sliding window. */
  readonly evictedBySize: number
  /** `true` iff the PASSIVE checkpoint reported success. */
  readonly checkpointed: boolean
  /**
   * ADR-0375 — `true` iff a RESTART checkpoint actually ran (i.e. the
   * `<databasePath>-wal` file was over `walSizeThresholdBytes` AND the
   * RESTART call did not throw). Always `false` when
   * `walSizeThresholdBytes` is absent.
   */
  readonly walRestarted: boolean
}

const EMPTY_RESULT: SweepResult = {
  evictedByTtl: 0,
  evictedBySize: 0,
  checkpointed: false,
  walRestarted: false,
}

/**
 * ADR-0375 — Read WAL file size on disk. NO-THROW: a missing WAL file
 * (DB never wrote anything, or it was checkpointed away) reports size 0.
 * Other stat errors (permission, broken symlink) are treated as
 * "unobservable" and return -1 so the caller can skip the RESTART path
 * without false-positives.
 */
const readWalSize = (databasePath: string): number => {
  try {
    return statSync(`${databasePath}-wal`).size
  } catch {
    // ENOENT (no WAL yet) and any other stat error ⇒ treat as 0.
    // This is the right call for case-BB (WAL missing): the WAL is
    // logically "drained" and the threshold check naturally evaluates
    // `0 > threshold` ⇒ false, so RESTART does not fire.
    return 0
  }
}

/**
 * One sweep of the registry GC. Idempotent: safe to call on an empty
 * DB or a freshly-swept DB (every step is a no-op when there is
 * nothing to evict).
 *
 * Opens the DB itself so it can be scheduled from a worker /
 * background timer without holding the registry's prepared statements.
 * The constructor applies migrations to keep schema drift impossible.
 */
export const sweepSqliteRegistry = (cfg: SqliteRegistryConfig): SweepResult => {
  let db: Database
  try {
    db = new Database(cfg.databasePath)
    applyMigrations(db)
  } catch {
    return EMPTY_RESULT
  }

  const now = cfg.now ?? Date.now
  const ttlMs = cfg.ttlMs ?? DEFAULT_TTL_MS
  const maxTotalBytes = cfg.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES

  let evictedByTtl = 0
  let evictedBySize = 0
  let checkpointed = false
  let walRestarted = false

  // 1. TTL eviction.
  try {
    const cutoff = now() - ttlMs
    const before = (db.query("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c
    db.query("DELETE FROM sessions WHERE last_touched < ?").run(cutoff)
    const after = (db.query("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c
    evictedByTtl = Math.max(0, before - after)
  } catch {
    // NO-THROW.
  }

  // 2. Sliding-window eviction by cumulative bytes (Codex parity).
  //
  // The SUM OVER walks sessions newest → oldest; once the cumulative
  // total exceeds `maxTotalBytes` every subsequent (older) session
  // is selected for delete. FK cascade drops the dependent rows.
  try {
    const before = (db.query("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c
    db.exec(`
      DELETE FROM sessions
      WHERE session_id IN (
        SELECT session_id FROM (
          SELECT
            session_id,
            SUM(total_estimated_bytes) OVER (
              ORDER BY last_touched DESC
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS cum
          FROM sessions
        ) WHERE cum > ${maxTotalBytes}
      )
    `)
    const after = (db.query("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c
    evictedBySize = Math.max(0, before - after)
  } catch {
    // NO-THROW.
  }

  // 3. PASSIVE WAL checkpoint. Non-blocking — may report SQLITE_BUSY
  //    if the WAL is mid-write; that is the expected non-fatal path
  //    for a long-running writer (Codex parity).
  try {
    db.exec("PRAGMA wal_checkpoint(PASSIVE)")
    checkpointed = true
  } catch {
    checkpointed = false
  }

  // 4. ADR-0375 — WAL-size-threshold RESTART escalation. PASSIVE is
  //    non-blocking but may leave the WAL on disk (writers in flight).
  //    RESTART force-drains the WAL so the file shrinks; it briefly
  //    blocks new writers, hence opt-in via `walSizeThresholdBytes`.
  //
  //    Codex `logs_2.sqlite` field data: 14.8 GB DB + 14 GB WAL after
  //    ~10 days of heavy use ⇒ PASSIVE-only is insufficient at scale.
  //
  //    The check is `> threshold` (strict): threshold 0 + non-empty WAL
  //    ⇒ RESTART (edge case DD); threshold 0 + empty WAL ⇒ no-op.
  if (typeof cfg.walSizeThresholdBytes === "number") {
    const walSize = readWalSize(cfg.databasePath)
    if (walSize > cfg.walSizeThresholdBytes) {
      try {
        db.exec("PRAGMA wal_checkpoint(RESTART)")
        walRestarted = true
      } catch {
        // NO-THROW — RESTART may report SQLITE_BUSY under concurrent
        // writers; we degrade silently and leave the PASSIVE outcome
        // in place.
      }
    }
  }

  try {
    db.close()
  } catch {
    // NO-THROW.
  }

  return { evictedByTtl, evictedBySize, checkpointed, walRestarted }
}
