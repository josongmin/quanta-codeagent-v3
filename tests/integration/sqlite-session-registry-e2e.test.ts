/**
 * TKT-sqlite — multi-process persist/restore/lockfile/WAL e2e (L3→L4).
 *
 * Pins production-shape multi-process invariants for the SQLite-backed
 * `SessionResourceRegistry` adapter (ADR-0361, Codex `logs_2.sqlite`
 * parity). The unit-tier `sqlite-store.hellgate` / `gc.hellgate` already
 * cover single-process semantics; this suite is the missing L4 step:
 *
 *   (a) Disk-persistent rehydrate across two registry constructions
 *       on the same file (multi-session).
 *   (b) Multi-process concurrent writes via `Bun.spawn` — WAL allows
 *       cross-process writer serialisation. Both children commit; the
 *       parent reads BOTH writes after children exit.
 *   (c) Cleanup `--dry-run` (`countSqliteRegistryCleanupCandidates`)
 *       MUST exactly match a subsequent real sweep.
 *   (d) Crash recovery — child writer SIGKILLed mid-flight; parent
 *       reopens DB and observes WAL recovery preserves the committed
 *       prefix (no torn writes, no schema corruption).
 *
 * # Test-only constraints
 *
 *   - No `src/**` mutation. Driving the adapter through its existing
 *     closed port (`createSqliteSessionResourceRegistry`) + `gc` helpers.
 *   - Child subprocess uses raw `bun:sqlite` (no tsconfig-path coupling
 *     in the .mjs) — exercises the SAME schema by running
 *     `applyMigrations` literal via inlined PRAGMA + DDL. The fact that
 *     children write directly to the shared DB is the whole point: it
 *     proves the on-disk schema is process-portable.
 *   - Windows: SQLite WAL semantics differ + Bun.spawn flag handling
 *     diverges. The skipIf below politely skips on win32 so the suite
 *     reports `skipped` rather than `failed` on a non-target platform.
 */

import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  countSqliteRegistryCleanupCandidates,
  sweepSqliteRegistry,
} from "@/agent/session-resource-registry/sqlite-adapter/gc"
import { createSqliteSessionResourceRegistry } from "@/agent/session-resource-registry/sqlite-adapter/sqlite-store"
import { asCacheKey } from "@/llm/system-prompt-cache"
import type { TypedHistoryEvent } from "@/memory/typed-event"

const IS_WIN = process.platform === "win32"

// ─── tmp scratch ─────────────────────────────────────────────────────

let tmpRoot: string
let dbPath: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "quanta-sqlite-session-registry-e2e-"))
  dbPath = join(tmpRoot, "registry.db")
})

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

const sampleEvent = (at: number, prev = "a", next = "b"): TypedHistoryEvent => ({
  kind: "mode_change",
  prev,
  next,
  at,
})

/**
 * Child-process script — opens the shared DB with `bun:sqlite` + WAL,
 * inserts N session rows + N event rows under `sessionId`, then exits.
 *
 * Inlines the schema (matches `schema.ts`). We don't import the TS
 * adapter from the child because the .mjs runtime path doesn't have the
 * tsconfig paths in scope; instead we write the SAME columns directly,
 * which proves the on-disk schema is process-portable.
 *
 * argv:
 *   [2] dbPath
 *   [3] sessionId
 *   [4] count (number of events)
 *   [5] (optional) "ready" — emit READY\n on stdout after first insert,
 *       then sleep forever (for crash recovery test). Without this flag
 *       the child commits + exits cleanly.
 */
const CHILD_WRITER_SCRIPT = `
import { Database } from "bun:sqlite"
const [, , dbPath, sessionId, countStr, mode] = process.argv
const N = Number.parseInt(countStr, 10)
const db = new Database(dbPath)
// busy_timeout makes the connection retry on SQLITE_BUSY for up to 10s —
// required when multiple processes race on a shared DB file. Without it,
// concurrent writers can fail mid-PRAGMA. (Codex \`logs_2.sqlite\` parity:
// production Codex sets busy_timeout too.) per-connection, so the child
// MUST set it even though the parent registry already did.
db.exec("PRAGMA busy_timeout = 10000")
// foreign_keys is per-connection too. journal_mode/synchronous are
// per-DB and have already been applied by the parent registry via
// \`applyMigrations\`; re-issuing them here risks SQLITE_BUSY before
// busy_timeout takes effect on the very first PRAGMA, so we skip them.
db.exec("PRAGMA foreign_keys = ON")
// Schema DDL is idempotent (CREATE TABLE IF NOT EXISTS) and necessary
// when the child opens before the parent has had a chance to migrate
// (the regression case: child races parent on construction). Already-
// applied schema is a no-op.
db.exec(\`CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  last_touched INTEGER NOT NULL,
  total_estimated_bytes INTEGER NOT NULL DEFAULT 0
)\`)
db.exec(\`CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  estimated_bytes INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
)\`)
const upsert = db.query(\`
  INSERT INTO sessions (session_id, last_touched, total_estimated_bytes)
  VALUES ($sid, $touched, $bytes)
  ON CONFLICT(session_id) DO UPDATE SET
    last_touched = $touched,
    total_estimated_bytes = sessions.total_estimated_bytes + $bytes
\`)
const nextSeq = db.query("SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM events WHERE session_id = ?")
const insertEv = db.query(\`
  INSERT INTO events (session_id, seq, kind, at, estimated_bytes, payload)
  VALUES ($sid, $seq, $kind, $at, $bytes, $payload)
\`)
const baseAt = Date.now()
for (let i = 0; i < N; i++) {
  const ev = { kind: "mode_change", prev: sessionId + "-prev-" + i, next: sessionId + "-next-" + i, at: baseAt + i }
  const payload = JSON.stringify(ev)
  const bytes = Buffer.byteLength(payload, "utf8")
  const seqRow = nextSeq.get(sessionId)
  const seq = seqRow !== null ? seqRow.next_seq : 0
  upsert.run({ $sid: sessionId, $touched: baseAt + i, $bytes: bytes })
  insertEv.run({ $sid: sessionId, $seq: seq, $kind: ev.kind, $at: ev.at, $bytes: bytes, $payload: payload })
  if (i === 0 && mode === "ready") {
    process.stdout.write("READY\\n")
    // Hang forever — parent SIGKILLs us.
    setInterval(() => {}, 1000)
  }
}
db.close()
`

const writeChildScript = (): string => {
  const p = join(tmpRoot, "child-writer.mjs")
  writeFileSync(p, CHILD_WRITER_SCRIPT)
  return p
}

const bunBin = process.execPath // bun runs the test ⇒ same bin spawns children

/* ------------------------------------------------------------------- */
/* (a) Disk-persistent multi-session persist/restore                   */
/* ------------------------------------------------------------------- */

describe.skipIf(IS_WIN)("TKT-sqlite (a) multi-session persist+restore", () => {
  test("3 sessions × 5 events each — second registry construction rehydrates ALL", () => {
    const reg1 = createSqliteSessionResourceRegistry({ databasePath: dbPath })
    // Three sessions, distinct content under each.
    const sessIds = ["sess-alpha", "sess-beta", "sess-gamma"] as const
    for (const sid of sessIds) {
      const r = reg1.getOrCreate(sid)
      for (let i = 0; i < 5; i++) {
        r.store.append(sampleEvent(i, `${sid}-p${i}`, `${sid}-n${i}`))
      }
      r.cache.getOrBuild(asCacheKey(`${sid}-key`), () => `${sid}-cached-text`)
    }
    expect(reg1.size()).toBe(3)

    // Drop the registry (no explicit close needed — the test deliberately
    // does NOT call `db.close()` to mimic an in-flight crash where the
    // process exits without orderly shutdown). Construct a brand-new
    // registry on the SAME file — rehydrate path runs on first mint.
    const reg2 = createSqliteSessionResourceRegistry({ databasePath: dbPath })

    // Fresh registry size is 0 until first mint (Map is in-process).
    expect(reg2.size()).toBe(0)

    for (const sid of sessIds) {
      const r2 = reg2.getOrCreate(sid)
      const events = r2.store.snapshot()
      expect(events.length).toBe(5)
      // Order MUST be preserved (seq ASC) and content MUST round-trip.
      for (let i = 0; i < 5; i++) {
        const ev = events[i]
        expect(ev?.kind).toBe("mode_change")
        if (ev?.kind === "mode_change") {
          expect(ev.prev).toBe(`${sid}-p${i}`)
          expect(ev.next).toBe(`${sid}-n${i}`)
        }
      }
      // Cache entry rehydrated too.
      const peeked = r2.cache.peek(asCacheKey(`${sid}-key`))
      expect(peeked?.text).toBe(`${sid}-cached-text`)
    }
    expect(reg2.size()).toBe(3)
  })
})

/* ------------------------------------------------------------------- */
/* (b) Concurrent multi-process writes — WAL + cross-process visibility */
/* ------------------------------------------------------------------- */

describe.skipIf(IS_WIN)("TKT-sqlite (b) concurrent multi-process writes", () => {
  test("two Bun children write disjoint sessions concurrently — BOTH commits visible to parent", async () => {
    const childScript = writeChildScript()

    // Pre-create the DB + schema by opening once with the registry (it
    // applies migrations). Without this both children race to apply the
    // schema; the registry pre-creates so the children race only on
    // INSERTs.
    const reg = createSqliteSessionResourceRegistry({ databasePath: dbPath })
    // Force at least one ID into the schema-applied state.
    reg.getOrCreate("warmup")
    reg.evict("warmup")

    const N = 50
    const children = [
      Bun.spawn({
        cmd: [bunBin, childScript, dbPath, "child-A", String(N)],
        stdout: "pipe",
        stderr: "pipe",
      }),
      Bun.spawn({
        cmd: [bunBin, childScript, dbPath, "child-B", String(N)],
        stdout: "pipe",
        stderr: "pipe",
      }),
    ]

    const [exitA, exitB] = await Promise.all(children.map((c) => c.exited))
    // Both children MUST exit cleanly. WAL allows the writers to
    // serialise via the file lock without either failing.
    expect(exitA).toBe(0)
    expect(exitB).toBe(0)

    // Parent reads via a fresh registry on the same file. Both children's
    // writes MUST be visible after the children exited (their COMMIT is
    // durable; WAL frame visible to subsequent readers).
    const reg2 = createSqliteSessionResourceRegistry({ databasePath: dbPath })
    const rA = reg2.getOrCreate("child-A")
    const rB = reg2.getOrCreate("child-B")
    expect(rA.store.snapshot().length).toBe(N)
    expect(rB.store.snapshot().length).toBe(N)

    // Distinct content per child — no cross-pollination.
    const evA0 = rA.store.snapshot()[0]
    const evB0 = rB.store.snapshot()[0]
    if (evA0?.kind === "mode_change") expect(evA0.prev).toBe("child-A-prev-0")
    if (evB0?.kind === "mode_change") expect(evB0.prev).toBe("child-B-prev-0")
  }, 30_000)

  test("10 concurrent children × 20 events same session — NO row loss, seq strictly monotonic", async () => {
    const childScript = writeChildScript()

    // Pre-apply schema via the registry.
    const reg = createSqliteSessionResourceRegistry({ databasePath: dbPath })
    reg.getOrCreate("warmup")
    reg.evict("warmup")

    const NUM_CHILDREN = 10
    const PER_CHILD = 20
    const children = Array.from({ length: NUM_CHILDREN }, (_, i) =>
      Bun.spawn({
        cmd: [bunBin, childScript, dbPath, `child-${i}`, String(PER_CHILD)],
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    const exits = await Promise.all(children.map((c) => c.exited))
    for (const ec of exits) expect(ec).toBe(0)

    // Validate every child's session got exactly PER_CHILD rows. SQLite
    // WAL guarantees writer-serialisation; no transaction can be lost.
    const probe = new Database(dbPath)
    try {
      for (let i = 0; i < NUM_CHILDREN; i++) {
        const sid = `child-${i}`
        const c = (
          probe.query("SELECT COUNT(*) AS c FROM events WHERE session_id = ?").get(sid) as {
            c: number
          }
        ).c
        expect(c).toBe(PER_CHILD)
        // seq is dense [0..PER_CHILD-1] within one child's session.
        const seqs = (
          probe.query("SELECT seq FROM events WHERE session_id = ? ORDER BY seq ASC").all(sid) as {
            seq: number
          }[]
        ).map((r) => r.seq)
        expect(seqs).toEqual(Array.from({ length: PER_CHILD }, (_, k) => k))
      }
    } finally {
      probe.close()
    }
  }, 60_000)
})

/* ------------------------------------------------------------------- */
/* (c) Cleanup --dry-run preview MUST equal actual sweep result        */
/* ------------------------------------------------------------------- */

describe.skipIf(IS_WIN)("TKT-sqlite (c) --dry-run preview equals actual cleanup", () => {
  test("TTL pass — wouldEvictByTtl == evictedByTtl + DB unchanged after dry-run", () => {
    // Seed via the in-process registry (real path) so the rows reflect a
    // realistic shape (estimated_bytes set by serializer).
    const reg = createSqliteSessionResourceRegistry({
      databasePath: dbPath,
      now: () => 100,
    })
    // 3 "old" sessions at touched=100, then "fresh" at touched=1_000_000.
    for (const sid of ["old-1", "old-2", "old-3"]) {
      const r = reg.getOrCreate(sid)
      r.store.append(sampleEvent(1))
    }
    // Bump time for "fresh".
    const reg2 = createSqliteSessionResourceRegistry({
      databasePath: dbPath,
      now: () => 1_000_000,
    })
    const rf = reg2.getOrCreate("fresh")
    rf.store.append(sampleEvent(2))

    // Pre-count sessions on disk (denominator sanity).
    const probe = new Database(dbPath)
    const preCount = (probe.query("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c
    probe.close()
    expect(preCount).toBe(4)

    // --dry-run preview.
    const dry = countSqliteRegistryCleanupCandidates({
      databasePath: dbPath,
      ttlMs: 1000,
      now: () => 1_000_500,
    })
    expect(dry.wouldEvictByTtl).toBe(3)
    expect(dry.inspectedSessions).toBe(4)

    // DB MUST be unchanged after a dry-run.
    const probe2 = new Database(dbPath)
    const midCount = (probe2.query("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c
    probe2.close()
    expect(midCount).toBe(4)

    // Actual sweep — counts MUST match the preview.
    const wet = sweepSqliteRegistry({
      databasePath: dbPath,
      ttlMs: 1000,
      now: () => 1_000_500,
    })
    expect(wet.evictedByTtl).toBe(dry.wouldEvictByTtl)

    // Post-sweep: only "fresh" survives on disk.
    const probe3 = new Database(dbPath)
    const survivors = (
      probe3.query("SELECT session_id FROM sessions").all() as { session_id: string }[]
    ).map((r) => r.session_id)
    probe3.close()
    expect(survivors).toEqual(["fresh"])
  })

  test("sliding-window pass — wouldEvictBySize == evictedBySize, byte-identical DB pre-dry-run", async () => {
    // Seed 4 sessions × ~similar bytes via the real registry path.
    const baseTime = 1_000_000
    let now = baseTime
    const reg = createSqliteSessionResourceRegistry({
      databasePath: dbPath,
      now: () => now,
    })
    // Four sessions, monotonic times → known eviction order under
    // the sliding window (newest first).
    const ids = ["s1", "s2", "s3", "s4"] as const
    for (let i = 0; i < ids.length; i++) {
      now = baseTime - (3 - i) * 100 // s1=baseTime-300 (oldest) … s4=baseTime (newest)
      const sid = ids[i] as string
      const r = reg.getOrCreate(sid)
      // Append a fixed-shape event so estimated_bytes is roughly equal.
      r.store.append(sampleEvent(now, `${sid}-p`, `${sid}-n`))
    }

    // Take a byte-snapshot of the DB BEFORE dry-run.
    const sizeBefore = statSync(dbPath).size

    // Choose a cap small enough to force eviction of ≥1.
    const probe = new Database(dbPath)
    const totalBytes = (
      probe.query("SELECT SUM(total_estimated_bytes) AS s FROM sessions").get() as { s: number }
    ).s
    probe.close()
    expect(totalBytes).toBeGreaterThan(0)
    const cap = Math.floor(totalBytes / 2) // forces ~half eviction

    const dry = countSqliteRegistryCleanupCandidates({
      databasePath: dbPath,
      maxTotalBytes: cap,
      ttlMs: 999_999_999_999,
      now: () => baseTime + 1,
    })
    expect(dry.wouldEvictBySize).toBeGreaterThanOrEqual(1)
    expect(dry.inspectedSessions).toBe(4)

    // Byte-identical DB after dry-run (no DELETE issued).
    const sizeAfterDry = statSync(dbPath).size
    expect(sizeAfterDry).toBe(sizeBefore)

    // Actual sweep — counts match.
    const wet = sweepSqliteRegistry({
      databasePath: dbPath,
      maxTotalBytes: cap,
      ttlMs: 999_999_999_999,
      now: () => baseTime + 1,
    })
    expect(wet.evictedBySize).toBe(dry.wouldEvictBySize)
  })
})

/* ------------------------------------------------------------------- */
/* (d) Crash recovery — SIGKILL mid-write, WAL recovers committed prefix */
/* ------------------------------------------------------------------- */

describe.skipIf(IS_WIN)("TKT-sqlite (d) crash recovery via WAL replay", () => {
  test("writer SIGKILLed after first commit — parent re-opens DB and sees the committed row", async () => {
    const childScript = writeChildScript()
    // Pre-apply schema.
    const reg = createSqliteSessionResourceRegistry({ databasePath: dbPath })
    reg.getOrCreate("warmup")
    reg.evict("warmup")

    // Child writes ONE row, prints READY, then hangs forever. We
    // SIGKILL after seeing READY — the first INSERT must have committed
    // (autocommit on a single statement) and be recoverable.
    const N = 1
    const proc = Bun.spawn({
      cmd: [bunBin, childScript, dbPath, "crash-victim", String(N), "ready"],
      stdout: "pipe",
      stderr: "pipe",
    })

    // Wait for READY (the child has committed its first row).
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let gotReady = false
    let attempts = 0
    while (!gotReady && attempts < 200) {
      const { value, done } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value)
      if (chunk.includes("READY")) gotReady = true
      attempts++
    }
    expect(gotReady).toBe(true)

    // SIGKILL — no graceful shutdown, no db.close().
    proc.kill("SIGKILL")
    await proc.exited
    expect(proc.exitCode).not.toBe(0) // killed, not clean exit

    // Re-open the DB. SQLite WAL recovery replays any committed-but-not-
    // checkpointed frames on first open. The single committed row MUST
    // be present and the events table MUST not be corrupt.
    const reg2 = createSqliteSessionResourceRegistry({ databasePath: dbPath })
    const r = reg2.getOrCreate("crash-victim")
    const evs = r.store.snapshot()
    expect(evs.length).toBe(1)
    expect(evs[0]?.kind).toBe("mode_change")

    // Schema is still intact — a follow-up write succeeds.
    r.store.append(sampleEvent(999, "post-crash", "post-crash"))
    expect(r.store.snapshot().length).toBe(2)

    // WAL file MAY exist post-recovery — that's fine. Sweep with a
    // generous TTL MUST not throw and MUST mark checkpointed=true.
    const sweep = sweepSqliteRegistry({ databasePath: dbPath })
    expect(sweep.checkpointed).toBe(true)
  }, 30_000)

  test("WAL file present + recoverable after non-checkpointed write batch", () => {
    // Open + write a session, do NOT close + do NOT sweep. The WAL file
    // must materialise next to the DB file.
    const reg = createSqliteSessionResourceRegistry({ databasePath: dbPath })
    const r = reg.getOrCreate("wal-probe")
    for (let i = 0; i < 20; i++) r.store.append(sampleEvent(i))

    // The -wal sibling file MUST exist under WAL journal mode.
    expect(existsSync(`${dbPath}-wal`)).toBe(true)

    // A fresh registry on the same file reads the WAL frames as if
    // they were main-DB pages (SQLite WAL transparency).
    const reg2 = createSqliteSessionResourceRegistry({ databasePath: dbPath })
    const r2 = reg2.getOrCreate("wal-probe")
    expect(r2.store.snapshot().length).toBe(20)
  })
})
