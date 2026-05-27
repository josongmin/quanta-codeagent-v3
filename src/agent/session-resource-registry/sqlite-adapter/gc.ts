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
}

const EMPTY_RESULT: SweepResult = {
  evictedByTtl: 0,
  evictedBySize: 0,
  checkpointed: false,
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

  try {
    db.close()
  } catch {
    // NO-THROW.
  }

  return { evictedByTtl, evictedBySize, checkpointed }
}
