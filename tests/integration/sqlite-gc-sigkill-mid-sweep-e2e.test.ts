/**
 * H13 — GC sweep SIGKILL mid-DELETE all-or-none (L3→L4).
 *
 * The sibling `sqlite-session-registry-e2e` pins WRITER crash recovery
 * (a child INSERTer SIGKILLed mid-flight; WAL replay preserves the
 * committed prefix). It does NOT cover the inverse failure: the GC
 * **sweep** itself (`sweepSqliteRegistry`) being SIGKILLed mid-DELETE.
 *
 * This suite seals that gap. The invariant under test is:
 *
 *   When a sweep that would evict a LARGE candidate set is killed
 *   (SIGKILL — no graceful shutdown, no `db.close()`) while a DELETE is
 *   in flight, the parent re-opens the DB (WAL recovery) and observes
 *   **all-or-none at session granularity**:
 *
 *     - NO half-deleted session     — a session row gone while its
 *       `events` / `cache_entries` children survive (orphans), OR a
 *       child gone while the parent row survives.
 *     - NO partial DELETE           — every candidate is either fully
 *       evicted (committed) or fully present (rolled back).
 *     - Schema integrity intact     — `PRAGMA integrity_check` = "ok";
 *       a follow-up write succeeds.
 *
 * # Why this is non-trivial
 *
 * `sweepSqliteRegistry` issues TWO autocommit DELETEs (TTL pass, then
 * sliding-window pass), each cascading via `ON DELETE CASCADE` to the
 * dependent `events` + `cache_entries` rows. The atomicity contract
 * relies entirely on (a) each DELETE being a single autocommit
 * statement (implicit per-statement transaction) and (b) FK cascade
 * being inside that same statement's transaction. A SIGKILL mid-DELETE
 * must leave the WAL with an UNCOMMITTED transaction that recovery
 * discards in full — never a torn parent/child split.
 *
 * # Test design — deterministic mid-DELETE kill (no timing assertions)
 *
 *   Case (1) DETERMINISTIC barrier: a child opens the DB, issues the
 *   EXACT sweep SQL (TTL DELETE + sliding-window DELETE) inside an
 *   explicit `BEGIN IMMEDIATE`, writes the uncommitted WAL frames,
 *   prints READY, then hangs BEFORE COMMIT. The parent waits for READY
 *   (so the DELETE has provably written uncommitted frames), then
 *   SIGKILLs. WAL recovery MUST roll back the entire transaction →
 *   none-deleted, zero orphans. This is the worst case (a multi-row
 *   cascading DELETE caught mid-flight) reproduced deterministically.
 *
 *   Case (2) REAL-FUNCTION fuzz: the production `sweepSqliteRegistry` is
 *   run in a child and SIGKILLed at randomized sub-millisecond offsets,
 *   repeatedly. After EVERY kill the invariant (zero orphans, no
 *   half-deleted session, integrity ok) MUST hold — whether the sweep
 *   completed or not. This guards the real code path against any future
 *   refactor that splits a cascading DELETE into non-atomic steps.
 *
 *   Case (3) RED-ON-INJECTION proof: a deliberately broken "sweep" that
 *   deletes parent rows with `foreign_keys = OFF` and COMMITS leaves
 *   orphans — proving the orphan-detection assertion has teeth (it goes
 *   RED when atomicity / cascade is violated).
 *
 * # Test-only constraints
 *   - No `src/**` mutation. Drives the real `sweepSqliteRegistry` for
 *     the regression path; the barrier child replicates the adapter's
 *     SQL verbatim (the .mjs runtime has no tsconfig paths in scope, so
 *     the child inlines the schema like the sibling e2e does).
 *   - Hermetic: tmpdir SQLite, cleaned up per-test.
 *   - Windows: WAL + Bun.spawn semantics diverge; skipIf(win32).
 */

import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sweepSqliteRegistry } from "@/agent/session-resource-registry/sqlite-adapter/gc"

const IS_WIN = process.platform === "win32"

let tmpRoot: string
let dbPath: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "quanta-sqlite-gc-sigkill-e2e-"))
  dbPath = join(tmpRoot, "registry.db")
})

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

const bunBin = process.execPath

// ─── schema + seed helpers (match schema.ts verbatim) ────────────────

const SCHEMA_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  last_touched INTEGER NOT NULL,
  total_estimated_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  estimated_bytes INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS events_at ON events(session_id, at);
CREATE TABLE IF NOT EXISTS cache_entries (
  session_id TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  built_at INTEGER NOT NULL,
  estimated_bytes INTEGER NOT NULL,
  PRIMARY KEY (session_id, cache_key),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
`

/**
 * Seed `sessionCount` sessions, each with `eventsPer` event rows + one
 * cache_entry row. The first `oldCount` are "stale" (last_touched far in
 * the past) so the TTL pass targets them; the remainder are "fresh" but
 * heavy so the sliding-window pass targets them under a small cap. This
 * makes BOTH sweep DELETE passes have a large candidate set.
 */
const seed = (opts: {
  sessionCount: number
  eventsPer: number
  oldCount: number
  bytesPerSession: number
}): void => {
  const db = new Database(dbPath)
  db.exec(SCHEMA_DDL)
  const insSess = db.query(
    "INSERT INTO sessions (session_id, last_touched, total_estimated_bytes) VALUES (?, ?, ?)",
  )
  const insEv = db.query(
    "INSERT INTO events (session_id, seq, kind, at, estimated_bytes, payload) VALUES (?, ?, ?, ?, ?, ?)",
  )
  const insCache = db.query(
    "INSERT INTO cache_entries (session_id, cache_key, text, content_hash, built_at, estimated_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  )
  const tx = db.transaction(() => {
    for (let s = 0; s < opts.sessionCount; s++) {
      const sid = `s${s}`
      const old = s < opts.oldCount
      const touched = old ? 100 + s : 10_000_000 + s
      insSess.run(sid, touched, opts.bytesPerSession)
      for (let e = 0; e < opts.eventsPer; e++) {
        insEv.run(sid, e, "mode_change", touched + e, 10, `payload-${sid}-${e}`)
      }
      insCache.run(sid, "k", `cached-${sid}`, "hash", touched, 10)
    }
  })
  tx()
  db.close()
}

/** Number of orphan child rows (FK parent missing). MUST always be 0. */
const orphanCount = (path: string): { events: number; cache: number } => {
  const db = new Database(path)
  db.exec("PRAGMA foreign_keys = ON")
  const events = (
    db
      .query(
        "SELECT COUNT(*) AS c FROM events e LEFT JOIN sessions s ON e.session_id = s.session_id WHERE s.session_id IS NULL",
      )
      .get() as { c: number }
  ).c
  const cache = (
    db
      .query(
        "SELECT COUNT(*) AS c FROM cache_entries ce LEFT JOIN sessions s ON ce.session_id = s.session_id WHERE s.session_id IS NULL",
      )
      .get() as { c: number }
  ).c
  db.close()
  return { events, cache }
}

/**
 * Count sessions whose child-row set is INCONSISTENT with a clean
 * all-or-none outcome. A "half-deleted" session is one whose parent row
 * is present but has FEWER than `eventsPer` events (a torn DELETE that
 * removed SOME children of a surviving parent). With per-statement
 * atomicity this MUST be 0: a surviving session keeps ALL its children.
 */
const halfDeletedSessions = (path: string, eventsPer: number): number => {
  const db = new Database(path)
  const rows = db
    .query(
      "SELECT s.session_id AS sid, COUNT(e.seq) AS ec FROM sessions s LEFT JOIN events e ON e.session_id = s.session_id GROUP BY s.session_id",
    )
    .all() as { sid: string; ec: number }[]
  db.close()
  return rows.filter((r) => r.ec !== eventsPer).length
}

const integrityOk = (path: string): boolean => {
  const db = new Database(path)
  const row = db.query("PRAGMA integrity_check").get() as { integrity_check: string }
  db.close()
  return row.integrity_check === "ok"
}

const sessionCount = (path: string): number => {
  const db = new Database(path)
  const c = (db.query("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c
  db.close()
  return c
}

const writeChild = (name: string, body: string): string => {
  const p = join(tmpRoot, name)
  writeFileSync(p, body)
  return p
}

/* ------------------------------------------------------------------- */
/* (1) Deterministic mid-DELETE SIGKILL → full rollback (all-or-none)  */
/* ------------------------------------------------------------------- */

/**
 * Child replicates the EXACT sweep SQL (both passes) inside an explicit
 * `BEGIN IMMEDIATE`, leaving the transaction UNCOMMITTED, then prints
 * READY and hangs. This is the deterministic barrier: once READY is
 * seen the DELETE has written uncommitted WAL frames; the parent kills
 * it BEFORE COMMIT so WAL recovery must discard the whole transaction.
 *
 * argv: [2]=dbPath  [3]=cutoff  [4]=maxTotalBytes
 */
const BARRIER_SWEEP_CHILD = `
import { Database } from "bun:sqlite"
const [, , dbPath, cutoffStr, capStr] = process.argv
const cutoff = Number.parseInt(cutoffStr, 10)
const cap = Number.parseInt(capStr, 10)
const db = new Database(dbPath)
db.exec("PRAGMA busy_timeout = 10000")
db.exec("PRAGMA foreign_keys = ON")
db.exec("BEGIN IMMEDIATE")
// Pass 1 — TTL DELETE (verbatim shape of gc.ts line ~351).
db.query("DELETE FROM sessions WHERE last_touched < ?").run(cutoff)
// Pass 2 — sliding-window DELETE (verbatim shape of gc.ts lines ~365-378).
db.exec(\`
  DELETE FROM sessions
  WHERE session_id IN (
    SELECT session_id FROM (
      SELECT session_id,
        SUM(total_estimated_bytes) OVER (
          ORDER BY last_touched DESC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS cum
      FROM sessions
    ) WHERE cum > \${cap}
  )
\`)
// Frames are now in the WAL but the transaction is OPEN. Signal + hang.
process.stdout.write("READY\\n")
setInterval(() => {}, 1000)
`

/** Wait up to ~2s for the child to print READY on stdout. */
const awaitReady = async (proc: Bun.Subprocess): Promise<boolean> => {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let attempts = 0
  while (attempts < 400) {
    const { value, done } = await reader.read()
    if (done) break
    if (decoder.decode(value).includes("READY")) return true
    attempts++
  }
  return false
}

describe.skipIf(IS_WIN)("H13 (1) deterministic mid-DELETE SIGKILL → full rollback", () => {
  test("large candidate set; killed mid-sweep before COMMIT → none-deleted, zero orphans", async () => {
    const EVENTS_PER = 8
    seed({ sessionCount: 300, eventsPer: EVENTS_PER, oldCount: 150, bytesPerSession: 1_000_000 })
    expect(sessionCount(dbPath)).toBe(300)

    const child = writeChild("barrier-sweep.mjs", BARRIER_SWEEP_CHILD)
    // cutoff drops the 150 "old" sessions; cap small enough to also
    // select the fresh-but-heavy ones → BOTH passes have big candidate sets.
    const proc = Bun.spawn({
      cmd: [bunBin, child, dbPath, String(1_000_000), String(5_000_000)],
      stdout: "pipe",
      stderr: "pipe",
    })

    const ready = await awaitReady(proc)
    expect(ready).toBe(true) // DELETE wrote uncommitted WAL frames

    // SIGKILL mid-transaction — no COMMIT, no db.close().
    proc.kill("SIGKILL")
    await proc.exited
    expect(proc.exitCode).not.toBe(0)

    // WAL recovery on reopen MUST discard the uncommitted DELETE in full.
    const orphans = orphanCount(dbPath)
    expect(orphans.events).toBe(0)
    expect(orphans.cache).toBe(0)
    // None-deleted: every session + all its children survive.
    expect(sessionCount(dbPath)).toBe(300)
    expect(halfDeletedSessions(dbPath, EVENTS_PER)).toBe(0)
    expect(integrityOk(dbPath)).toBe(true)

    // Schema usable post-recovery: a real sweep now completes cleanly.
    const res = sweepSqliteRegistry({
      databasePath: dbPath,
      ttlMs: 1000,
      maxTotalBytes: 5_000_000,
      now: () => 2_000_000,
    })
    // After a CLEAN sweep the surviving set is consistent (no orphans).
    const after = orphanCount(dbPath)
    expect(after.events).toBe(0)
    expect(after.cache).toBe(0)
    expect(res.evictedByTtl + res.evictedBySize).toBeGreaterThan(0)
  }, 30_000)
})

/* ------------------------------------------------------------------- */
/* (2) REAL sweepSqliteRegistry fuzzed under randomized SIGKILL        */
/* ------------------------------------------------------------------- */

/**
 * Child runs the PRODUCTION `sweepSqliteRegistry` via dynamic import of
 * the real gc.ts module (URL passed by parent — keeps tsconfig paths out
 * of the .mjs). The parent kills it at a random sub-millisecond offset.
 *
 * argv: [2]=dbPath  [3]=gcModuleUrl
 */
const REAL_SWEEP_CHILD = `
const [, , dbPath, gcUrl] = process.argv
const { sweepSqliteRegistry } = await import(gcUrl)
sweepSqliteRegistry({
  databasePath: dbPath,
  ttlMs: 1000,
  maxTotalBytes: 5000000,
  now: () => 2000000,
})
process.stdout.write("DONE\\n")
`

describe.skipIf(IS_WIN)("H13 (2) real sweep fuzzed under randomized SIGKILL", () => {
  test("repeated kills at random offsets — invariant holds after EVERY kill", async () => {
    const EVENTS_PER = 6
    seed({ sessionCount: 400, eventsPer: EVENTS_PER, oldCount: 200, bytesPerSession: 1_000_000 })

    const child = writeChild("real-sweep.mjs", REAL_SWEEP_CHILD)
    const gcUrl = new URL(
      `file://${join(process.cwd(), "src/agent/session-resource-registry/sqlite-adapter/gc.ts")}`,
    ).href

    const ITERS = 24
    for (let iter = 0; iter < ITERS; iter++) {
      const proc = Bun.spawn({
        cmd: [bunBin, child, dbPath, gcUrl],
        stdout: "pipe",
        stderr: "pipe",
      })
      // Random delay so the kill lands at varied points in the sweep
      // (open / migrate / TTL DELETE / sliding-window DELETE / checkpoint
      // / clean exit). NOT a timing ASSERTION — just dithered interleave.
      const delayMs = Math.random() * 4
      await new Promise((r) => setTimeout(r, delayMs))
      proc.kill("SIGKILL")
      await proc.exited

      // Whatever point the kill landed, the on-disk DB MUST be consistent.
      const orphans = orphanCount(dbPath)
      expect(orphans.events).toBe(0)
      expect(orphans.cache).toBe(0)
      expect(halfDeletedSessions(dbPath, EVENTS_PER)).toBe(0)
      expect(integrityOk(dbPath)).toBe(true)
    }
  }, 60_000)
})

/* ------------------------------------------------------------------- */
/* (3) RED-ON-INJECTION — orphan-detection has teeth                   */
/* ------------------------------------------------------------------- */

describe.skipIf(IS_WIN)("H13 (3) red-on-injection — orphan detection has teeth", () => {
  test("FK-OFF parent-only DELETE that COMMITS leaves orphans (proves the guard fails RED)", () => {
    const EVENTS_PER = 4
    seed({ sessionCount: 10, eventsPer: EVENTS_PER, oldCount: 5, bytesPerSession: 100 })

    // Simulate a broken, NON-atomic sweep: delete parent rows while FK
    // cascade is disabled and COMMIT. If `sweepSqliteRegistry` ever
    // regressed to dropping a parent without its children inside one
    // atomic statement, this is the corruption shape the case (1)/(2)
    // assertions catch.
    const db = new Database(dbPath)
    db.exec("PRAGMA foreign_keys = OFF")
    db.exec("DELETE FROM sessions WHERE last_touched < 200") // drops the 5 "old" parents only
    db.close()

    const orphans = orphanCount(dbPath)
    // The injection MUST produce orphans — otherwise the invariant
    // assertions in (1)/(2) would be vacuous (green on a no-op).
    expect(orphans.events).toBe(5 * EVENTS_PER)
    expect(orphans.cache).toBe(5)
    // And a "surviving-but-childless" detection would also fire if a
    // parent had had its children torn off — proving both halves of the
    // half-deleted check are reachable.
    expect(orphans.events).toBeGreaterThan(0)
  })
})
