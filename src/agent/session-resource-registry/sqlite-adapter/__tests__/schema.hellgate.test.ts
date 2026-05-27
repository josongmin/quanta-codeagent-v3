/**
 * ★ HELLGATE — ADR-0361 schema + PRAGMA.
 *
 * Pins the migration ladder + PRAGMA contract that the SQLite adapter
 * depends on. Drift here surfaces as a sqlite-store hellgate failure
 * (FK cascade, WAL mode, etc.) — these tests cover the lower-level
 * primitive directly.
 *
 * Coverage (6 cases):
 *   1. applyMigrations on a fresh DB creates all 3 tables
 *   2. applyMigrations idempotent (second call no-ops)
 *   3. PRAGMA journal_mode = wal
 *   4. PRAGMA synchronous = NORMAL (==1)
 *   5. PRAGMA foreign_keys = ON (==1)
 *   6. FK cascade: deleting a session drops dependent events + cache
 */

import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyMigrations } from "../schema"

const makeDb = (): { db: Database; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-adr0361-schema-"))
  const db = new Database(join(dir, "x.db"))
  return {
    db,
    cleanup: () => {
      try {
        db.close()
      } catch {
        // best-effort
      }
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    },
  }
}

describe("ADR-0361 schema — hellgate", () => {
  test("[1] applyMigrations creates sessions / events / cache_entries", () => {
    const { db, cleanup } = makeDb()
    applyMigrations(db)
    const names = (
      db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(names).toContain("sessions")
    expect(names).toContain("events")
    expect(names).toContain("cache_entries")
    cleanup()
  })

  test("[2] applyMigrations idempotent (second call no-ops)", () => {
    const { db, cleanup } = makeDb()
    applyMigrations(db)
    expect(() => applyMigrations(db)).not.toThrow()
    expect(() => applyMigrations(db)).not.toThrow()
    cleanup()
  })

  test("[3] PRAGMA journal_mode = wal", () => {
    const { db, cleanup } = makeDb()
    applyMigrations(db)
    const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string }
    expect(row.journal_mode.toLowerCase()).toBe("wal")
    cleanup()
  })

  test("[4] PRAGMA synchronous = NORMAL (==1)", () => {
    const { db, cleanup } = makeDb()
    applyMigrations(db)
    const row = db.query("PRAGMA synchronous").get() as { synchronous: number }
    expect(row.synchronous).toBe(1)
    cleanup()
  })

  test("[5] PRAGMA foreign_keys = ON (==1)", () => {
    const { db, cleanup } = makeDb()
    applyMigrations(db)
    const row = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }
    expect(row.foreign_keys).toBe(1)
    cleanup()
  })

  test("[6] FK cascade: deleting a session drops events + cache_entries", () => {
    const { db, cleanup } = makeDb()
    applyMigrations(db)
    db.exec(
      "INSERT INTO sessions (session_id, last_touched, total_estimated_bytes) VALUES ('s1', 1, 0)",
    )
    db.exec(
      "INSERT INTO events (session_id, seq, kind, at, estimated_bytes, payload) VALUES ('s1', 0, 'mode_change', 1, 1, '{}')",
    )
    db.exec(
      "INSERT INTO cache_entries (session_id, cache_key, text, content_hash, built_at, estimated_bytes) VALUES ('s1', 'k', 't', 'h', 1, 1)",
    )
    db.exec("DELETE FROM sessions WHERE session_id = 's1'")
    const ec = (db.query("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c
    const cc = (db.query("SELECT COUNT(*) AS c FROM cache_entries").get() as { c: number }).c
    expect(ec).toBe(0)
    expect(cc).toBe(0)
    cleanup()
  })
})
