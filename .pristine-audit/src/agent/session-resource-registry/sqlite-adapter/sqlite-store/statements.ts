/**
 * Prepared-statement bundle + SQL strings for the SQLite-backed
 * `SessionResourceRegistry` adapter. Extracted verbatim from
 * `../sqlite-store.ts` (god-FUNCTION decomposition). All writes go
 * through these so the schema is single-sourced from `../schema.ts`
 * / `../serializer.ts`.
 */

import type { Database, Statement } from "bun:sqlite"

export const UPSERT_SESSION_SQL = `
    INSERT INTO sessions (session_id, last_touched, total_estimated_bytes)
    VALUES ($sid, $touched, $bytes)
    ON CONFLICT(session_id) DO UPDATE SET
      last_touched = $touched,
      total_estimated_bytes = sessions.total_estimated_bytes + $bytes
  `

export const TOUCH_SESSION_SQL = `
    INSERT INTO sessions (session_id, last_touched, total_estimated_bytes)
    VALUES ($sid, $touched, 0)
    ON CONFLICT(session_id) DO UPDATE SET last_touched = $touched
  `

export const NEXT_SEQ_SQL =
  "SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM events WHERE session_id = ?"

export const INSERT_EVENT_SQL = `
    INSERT INTO events (session_id, seq, kind, at, estimated_bytes, payload)
    VALUES ($sid, $seq, $kind, $at, $bytes, $payload)
  `

export const UPSERT_CACHE_SQL = `
    INSERT INTO cache_entries (
      session_id, cache_key, text, content_hash, built_at, estimated_bytes
    ) VALUES ($sid, $key, $text, $hash, $built, $bytes)
    ON CONFLICT(session_id, cache_key) DO UPDATE SET
      text = excluded.text,
      content_hash = excluded.content_hash,
      built_at = excluded.built_at,
      estimated_bytes = excluded.estimated_bytes
  `

export const SELECT_EVENTS_SQL = "SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC"
export const SELECT_CACHE_SQL =
  "SELECT * FROM cache_entries WHERE session_id = ? ORDER BY cache_key ASC"
export const DELETE_SESSION_SQL = "DELETE FROM sessions WHERE session_id = ?"
export const TRUNCATE_SESSIONS_SQL = "DELETE FROM sessions"
export const DELETE_EVENTS_SQL = "DELETE FROM events WHERE session_id = ?"
export const DELETE_CACHE_ENTRY_SQL =
  "DELETE FROM cache_entries WHERE session_id = ? AND cache_key = ?"
export const DELETE_CACHE_SESSION_SQL = "DELETE FROM cache_entries WHERE session_id = ?"

/**
 * Recompute `sessions.total_estimated_bytes` from the LIVE child rows
 * (events + cache_entries) for one session.
 *
 * `UPSERT_SESSION_SQL` only ever INCREMENTS the running total, so any
 * clear / invalidate / truncate of child rows leaves the session row's
 * total stale-high. The GC sliding-window (`gc.ts`) evicts on this
 * ever-growing total, so it must be reconciled with reality whenever
 * rows are removed. Recomputing from the surviving `estimated_bytes`
 * sums is self-correcting (no risk of drifting negative) and matches
 * the bytes that `UPSERT_SESSION_SQL` originally added per row.
 */
export const RECOMPUTE_SESSION_BYTES_SQL = `
    UPDATE sessions SET total_estimated_bytes =
      COALESCE((SELECT SUM(estimated_bytes) FROM events WHERE session_id = $sid), 0)
      + COALESCE((SELECT SUM(estimated_bytes) FROM cache_entries WHERE session_id = $sid), 0)
    WHERE session_id = $sid
  `

/** All prepared statements used by the registry methods. */
export interface PreparedStatements {
  readonly upsertSession: Statement
  readonly touchSession: Statement
  readonly nextSeq: Statement
  readonly insertEvent: Statement
  readonly upsertCache: Statement
  readonly selectEvents: Statement
  readonly selectCache: Statement
  readonly deleteSession: Statement
  readonly truncateSessions: Statement
}

/** Prepare all statements once on construction. */
export const prepareStatements = (db: Database): PreparedStatements => ({
  upsertSession: db.query(UPSERT_SESSION_SQL),
  touchSession: db.query(TOUCH_SESSION_SQL),
  nextSeq: db.query(NEXT_SEQ_SQL),
  insertEvent: db.query(INSERT_EVENT_SQL),
  upsertCache: db.query(UPSERT_CACHE_SQL),
  selectEvents: db.query(SELECT_EVENTS_SQL),
  selectCache: db.query(SELECT_CACHE_SQL),
  deleteSession: db.query(DELETE_SESSION_SQL),
  truncateSessions: db.query(TRUNCATE_SESSIONS_SQL),
})
