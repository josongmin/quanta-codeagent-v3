/**
 * ADR-0361 — schema + PRAGMA setup for the SQLite adapter.
 *
 * Schema verbatim:
 *
 * ```sql
 * CREATE TABLE IF NOT EXISTS sessions (
 *   session_id TEXT PRIMARY KEY,
 *   last_touched INTEGER NOT NULL,
 *   total_estimated_bytes INTEGER NOT NULL DEFAULT 0
 * );
 *
 * CREATE TABLE IF NOT EXISTS events (
 *   session_id TEXT NOT NULL,
 *   seq INTEGER NOT NULL,
 *   kind TEXT NOT NULL,
 *   at INTEGER NOT NULL,
 *   estimated_bytes INTEGER NOT NULL,
 *   payload TEXT NOT NULL,
 *   PRIMARY KEY (session_id, seq),
 *   FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
 * );
 * CREATE INDEX IF NOT EXISTS events_at ON events(session_id, at);
 *
 * CREATE TABLE IF NOT EXISTS cache_entries (
 *   session_id TEXT NOT NULL,
 *   cache_key TEXT NOT NULL,
 *   text TEXT NOT NULL,
 *   content_hash TEXT NOT NULL,
 *   built_at INTEGER NOT NULL,
 *   estimated_bytes INTEGER NOT NULL,
 *   PRIMARY KEY (session_id, cache_key),
 *   FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
 * );
 * ```
 *
 * Migration story: this slice is born at v1. The constructor runs
 * `applyMigrations(db)` which is idempotent on a fresh DB and a no-op
 * on a v1 DB. Future v2 schemas MUST extend the migration ladder, not
 * mutate existing rows — see Codex `logs_2.sqlite` migration #2
 * (`estimated_bytes` column add) for the pattern.
 *
 * `PRAGMA foreign_keys = ON` is necessary for the cascading delete in
 * `evict(sessionId)` — by default SQLite has FK enforcement OFF. We set
 * it during `applyMigrations` so callers that re-open the DB always pay
 * the pragma.
 */

import type { Database } from "bun:sqlite"

/**
 * Apply PRAGMAs + schema. Idempotent: safe to call on fresh, v1, or
 * partially-migrated DBs.
 *
 * The PRAGMA order matches Codex `logs_2.sqlite`:
 *   1. `journal_mode = WAL`     — must be set before any write
 *   2. `synchronous = NORMAL`   — safe under WAL
 *   3. `foreign_keys = ON`      — required for cascade deletes
 */
export const applyMigrations = (db: Database): void => {
  // PRAGMA order matters: WAL must be set before the first write.
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("PRAGMA foreign_keys = ON")

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      last_touched INTEGER NOT NULL,
      total_estimated_bytes INTEGER NOT NULL DEFAULT 0
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      at INTEGER NOT NULL,
      estimated_bytes INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (session_id, seq),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    )
  `)
  db.exec("CREATE INDEX IF NOT EXISTS events_at ON events(session_id, at)")

  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      session_id TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      built_at INTEGER NOT NULL,
      estimated_bytes INTEGER NOT NULL,
      PRIMARY KEY (session_id, cache_key),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    )
  `)
}
