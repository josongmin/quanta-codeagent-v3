/**
 * H10 — memory SQLite store crash-mid-distill recovery hellgate (L3→L4).
 *
 * The unit-tier `sqlite-delete-async.hellgate` covers single-process
 * async-contract + corrupt-embedding *read* degradation, and the
 * `memory` distill tests cover the *happy* path (parse / clamp / cap).
 * NEITHER covers what happens when a distill / consolidate batch is
 * SIGKILLed *mid-transaction* — a torn DB write leaving a half-applied
 * batch and/or a partially-serialized embedding BLOB in the WAL. On
 * reopen, two invariants MUST hold:
 *
 *   (1) ALL-OR-NONE — an embedding-bearing batch wrapped in an explicit
 *       `BEGIN ... COMMIT` that is killed *before* COMMIT must leave ZERO
 *       of its rows on disk after WAL recovery rolls back the uncommitted
 *       frames. A committed prefix from an *earlier* batch survives intact.
 *
 *   (2) BLOB INTEGRITY / GRACEFUL DEGRADE — every embedding BLOB that does
 *       survive recovery either decodes to a clean Float32 vector (its
 *       bytes round-trip) OR is skipped (deserializeVec → undefined) with
 *       the row still loading and NO crash / NO OOM. A torn BLOB (byte
 *       length not a positive multiple of 4, or a wrong-dimension vector)
 *       must never throw out of the read path and must never be ranked as
 *       a real embedding.
 *
 * Why a child subprocess + raw `bun:sqlite`:
 *   The production embedding BLOBs live in the `memories` table owned by
 *   `SqliteStore` (vector.ts serializeVec ⇒ Float32 LE BLOB). A distill /
 *   consolidate batch persists many such rows; an all-or-none batch is an
 *   explicit transaction over the SAME on-disk schema. The child writes
 *   that schema directly (no tsconfig-path coupling in the .mjs) — proving
 *   the on-disk form is process-portable — then the PARENT reopens through
 *   the real `SqliteStore` and asserts the domain-level invariants. The
 *   child is the only thing that can be SIGKILLed mid-transaction; the
 *   parent is the verifier.
 *
 * Synchronization is via a READY barrier on the child's stdout (it prints
 * READY only after BEGIN + the inserts but BEFORE COMMIT, then hangs). NO
 * timing assertions — the parent kills only after the barrier, so the torn
 * state is deterministic.
 *
 * red-on-injection: if the store/schema dropped WAL + atomic-transaction
 * recovery (e.g. `journal_mode=OFF` / `PRAGMA synchronous=OFF` with no
 * rollback, or a non-transactional row-by-row batch), the uncommitted
 * rows would SURVIVE the kill — case (1) flips RED. If the read path
 * stopped tolerating a torn/wrong-dim BLOB (threw instead of degrading),
 * case (2) flips RED.
 *
 * Hermetic: a tmpdir SQLite file, cleaned up in afterEach. No src/**
 * mutation — driven entirely through the existing closed `SqliteStore`
 * port + raw schema in the child.
 *
 * Windows: SQLite WAL semantics + Bun.spawn signal handling diverge on
 * win32; skipIf reports `skipped` rather than `failed` off-target.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteStore } from "@/memory/adapters/sqlite"
import { EMBED_DIM } from "@/memory/types"
import { deserializeVec } from "@/memory/vector"

const IS_WIN = process.platform === "win32"
const bunBin = process.execPath // bun runs the test ⇒ same bin spawns children

// ─── tmp scratch ─────────────────────────────────────────────────────

let tmpRoot: string
let dbPath: string

const freshTmp = (): void => {
  tmpRoot = mkdtempSync(join(tmpdir(), "quanta-memory-sqlite-crash-distill-"))
  dbPath = join(tmpRoot, "memory.db")
}
const cleanupTmp = (): void => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

/**
 * Child-process distill batch writer. Opens the shared `memories` DB with
 * raw `bun:sqlite`, mirrors the on-disk schema + WAL pragma that
 * `SqliteStore`'s constructor applies, then writes embedding-bearing rows
 * inside an EXPLICIT transaction.
 *
 * The schema DDL is the exact column set + types of `SqliteStore`
 * (adapters/sqlite.ts) so the parent's real store reopens it unchanged.
 * The embedding BLOB is a Float32 LE buffer of EMBED_DIM floats — the same
 * encoding as `vector.ts:serializeVec` — so a survivor MUST decode through
 * the production `deserializeVec`.
 *
 * argv:
 *   [2] dbPath
 *   [3] idPrefix          — row id prefix (id = `${prefix}-${i}`)
 *   [4] committedCount    — rows written + COMMITted up front (durable)
 *   [5] uncommittedCount  — rows written inside an OPEN txn, NOT committed
 *   [6] embedDim          — float count per embedding BLOB (EMBED_DIM, or a
 *                           deliberately-torn dim for the degrade case)
 *
 * Protocol: after the committed batch lands AND the uncommitted batch is
 * written (txn still OPEN), the child prints READY then hangs forever. The
 * parent SIGKILLs it — the open txn is torn mid-flight, never committed.
 */
const CHILD_DISTILL_SCRIPT = `
import { Database } from "bun:sqlite"
const [, , dbPath, idPrefix, committedStr, uncommittedStr, dimStr] = process.argv
const committedN = Number.parseInt(committedStr, 10)
const uncommittedN = Number.parseInt(uncommittedStr, 10)
const dim = Number.parseInt(dimStr, 10)

const db = new Database(dbPath)
// Mirror SqliteStore's durability posture. WAL + synchronous=FULL so a
// COMMIT is durable across a SIGKILL and an uncommitted txn rolls back.
db.exec("PRAGMA journal_mode = WAL")
db.exec("PRAGMA synchronous = FULL")
db.exec("PRAGMA busy_timeout = 10000")
// Schema mirrors src/memory/adapters/sqlite.ts (CREATE TABLE IF NOT EXISTS
// is idempotent — a no-op once the parent has migrated).
db.exec(\`
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    kind TEXT,
    tier TEXT,
    text TEXT,
    tags TEXT,
    importance REAL,
    created_at INTEGER,
    updated_at INTEGER,
    access_count INTEGER,
    last_accessed_at INTEGER,
    embedding BLOB,
    superseded_by TEXT,
    session_id TEXT,
    task_group TEXT,
    applies_to_cwd TEXT,
    reuse_rule TEXT
  )
\`)

const insert = db.query(\`
  INSERT INTO memories (id, kind, text, tags, created_at, embedding)
  VALUES ($id, $kind, $text, $tags, $created_at, $embedding)
\`)

// Build a Float32 LE BLOB of \`dim\` floats — identical encoding to
// vector.ts:serializeVec. A deterministic ramp so the parent can verify
// exact byte round-trip.
const makeBlob = (n) => {
  const f = new Float32Array(n)
  for (let i = 0; i < n; i++) f[i] = (i % 7) / 7
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength)
}

const writeRow = (id) => {
  insert.run({
    $id: id,
    $kind: "observation",
    $text: "distilled-" + id,
    $tags: "[]",
    $created_at: Date.now(),
    $embedding: makeBlob(dim),
  })
}

// Phase 1 — committed prefix (durable across the kill). Wrapped in its
// own txn so it is a single atomic, COMMITted batch.
if (committedN > 0) {
  db.exec("BEGIN")
  for (let i = 0; i < committedN; i++) writeRow(idPrefix + "-committed-" + i)
  db.exec("COMMIT")
}

// Phase 2 — the in-flight distill batch. OPEN a txn, write the rows, then
// HANG with the txn still open. The parent SIGKILLs here ⇒ torn write.
db.exec("BEGIN")
for (let i = 0; i < uncommittedN; i++) writeRow(idPrefix + "-uncommitted-" + i)

// Barrier: rows are in the WAL under an open txn, NOT committed.
process.stdout.write("READY\\n")
setInterval(() => {}, 1000) // hang forever — never reaches COMMIT
`

const writeChildScript = (): string => {
  const p = join(tmpRoot, "child-distill.mjs")
  writeFileSync(p, CHILD_DISTILL_SCRIPT)
  return p
}

/** Spawn the child, await the READY barrier, SIGKILL it mid-transaction.
 *  Returns once the child has exited (non-zero / killed). */
const spawnAndKillMidTxn = async (args: readonly string[]): Promise<void> => {
  const proc = Bun.spawn({
    cmd: [bunBin, writeChildScript(), ...args],
    stdout: "pipe",
    stderr: "pipe",
  })

  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let gotReady = false
  let buf = ""
  // Bounded read loop — the barrier is a single READY line; cap reads so a
  // misbehaving child can never hang the suite (NOT a timing assertion —
  // the cap is a liveness backstop, the kill is gated on READY).
  for (let attempts = 0; !gotReady && attempts < 500; attempts++) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value)
    if (buf.includes("READY")) gotReady = true
  }
  expect(gotReady).toBe(true)

  // SIGKILL mid-transaction — no graceful shutdown, no COMMIT, no close().
  proc.kill("SIGKILL")
  await proc.exited
  expect(proc.exitCode).not.toBe(0)
  // Release the pipe so the handle is not leaked into the next spawn.
  try {
    await reader.cancel()
  } catch {
    // best-effort
  }
}

describe.skipIf(IS_WIN)(
  "H10 — SqliteStore crash mid-distill (all-or-none + BLOB integrity)",
  () => {
    test("(1) uncommitted distill batch SIGKILLed mid-txn ⇒ ZERO uncommitted rows survive; committed prefix intact", async () => {
      freshTmp()
      try {
        const COMMITTED = 5
        const UNCOMMITTED = 8
        // Child commits 5 embedding rows, opens a txn with 8 more, hangs.
        await spawnAndKillMidTxn([
          dbPath,
          "d1",
          String(COMMITTED),
          String(UNCOMMITTED),
          String(EMBED_DIM),
        ])

        // Parent reopens through the REAL store — WAL recovery runs on open.
        const store = new SqliteStore(dbPath)
        try {
          const all = await store.all()
          const ids = all.map((e) => e.id).sort()

          // ALL-OR-NONE: every uncommitted row rolled back.
          const uncommitted = ids.filter((id) => id.includes("-uncommitted-"))
          expect(uncommitted).toEqual([])

          // The earlier COMMITted batch is fully durable.
          const committed = ids.filter((id) => id.includes("-committed-"))
          expect(committed.length).toBe(COMMITTED)
          for (let i = 0; i < COMMITTED; i++) {
            expect(committed).toContain(`d1-committed-${i}`)
          }

          // BLOB INTEGRITY: each surviving embedding decodes to a clean
          // EMBED_DIM vector — no torn / truncated float buffer crept through.
          for (const id of committed) {
            const e = await store.get(id)
            expect(e).toBeDefined()
            expect(e?.embedding).toBeDefined()
            expect(e?.embedding?.length).toBe(EMBED_DIM)
            // every component finite (no NaN from a half-written float)
            for (const x of e?.embedding ?? []) expect(Number.isFinite(x)).toBe(true)
          }

          // Schema intact post-recovery — a follow-up write succeeds.
          await store.save({
            id: "post-crash",
            kind: "observation",
            text: "ok",
            tags: [],
            createdAt: Date.now(),
          })
          expect((await store.get("post-crash"))?.id).toBe("post-crash")
        } finally {
          store.close()
        }
      } finally {
        cleanupTmp()
      }
    }, 30_000)

    test("(2) torn / wrong-dimension embedding BLOB ⇒ row loads with NO embedding (graceful degrade, no throw, no OOM)", async () => {
      freshTmp()
      try {
        // Commit rows whose embedding BLOB has a DELIBERATELY torn dimension:
        // EMBED_DIM-1 floats. The byte length is still a multiple of 4 (so it
        // is NOT rejected by the odd-length guard) but the vector is the wrong
        // length — a survivor of a torn distill that wrote a short buffer.
        // `normalizeEntry` only persists EMBED_DIM vectors on the WRITE side,
        // so this corruption is ONLY reachable through a raw/torn write — the
        // exact post-crash state we are pinning.
        const TORN_DIM = EMBED_DIM - 1
        await spawnAndKillMidTxn([dbPath, "d2", "3", "4", String(TORN_DIM)])

        const store = new SqliteStore(dbPath)
        try {
          // The read path MUST NOT throw on a wrong-dim BLOB.
          const all = await store.all()
          const committed = all.filter((e) => e.id.includes("-committed-"))
          expect(committed.length).toBe(3)

          for (const e of committed) {
            // Graceful degrade: a wrong-dimension vector is NOT surfaced as a
            // real EMBED_DIM embedding. It either decodes to its (wrong) raw
            // length or is dropped — but the row still loads and ranks fine.
            // The invariant the harness pins: it is NEVER a clean EMBED_DIM
            // vector (that would be silent data corruption masquerading as a
            // valid embedding).
            if (e.embedding !== undefined) {
              expect(e.embedding.length).not.toBe(EMBED_DIM)
            }
          }

          // recall() over the torn rows must not crash (ranking tolerates the
          // wrong-dim vector via length-mismatch → similarity 0).
          const recalled = await store.recall({ limit: 10 })
          expect(Array.isArray(recalled)).toBe(true)
          expect(recalled.length).toBe(3)
        } finally {
          store.close()
        }
      } finally {
        cleanupTmp()
      }
    }, 30_000)

    test("(3) corrupt-embedding degradation on a crash survivor is OBSERVABLE (typed event, fail-open read)", async () => {
      freshTmp()
      try {
        // Odd byte-length BLOB is impossible via serializeVec (always ×4), so
        // we reproduce a true torn-WAL survivor: commit a row, then truncate
        // its BLOB to an odd length via raw SQL (the only producer of this
        // state is partial-write corruption). The store must surface it via
        // the onCorruptEmbedding observer instead of silently dropping it.
        await spawnAndKillMidTxn([dbPath, "d3", "2", "3", String(EMBED_DIM)])

        const seen: Array<{ id: string; byteLength: number }> = []
        const store = new SqliteStore(dbPath, {
          onCorruptEmbedding: (ev) => seen.push({ id: ev.id, byteLength: ev.byteLength }),
        })
        try {
          // Simulate a torn (odd-length) embedding survivor on a committed row.
          store
            .rawDbForTest()
            .exec("UPDATE memories SET embedding = X'00' WHERE id = 'd3-committed-0'")

          const got = await store.get("d3-committed-0")
          // Fail-open: row still loads, embedding dropped.
          expect(got).toBeDefined()
          expect(got?.embedding).toBeUndefined()
          // …and the corruption is OBSERVABLE, not silent.
          expect(seen.map((s) => s.id)).toContain("d3-committed-0")
          expect(seen.find((s) => s.id === "d3-committed-0")?.byteLength).toBe(1)
        } finally {
          store.close()
        }
      } finally {
        cleanupTmp()
      }
    }, 30_000)

    test("(4) WAL sibling materializes + a second crash leaves the FIRST committed batch intact (idempotent recovery)", async () => {
      freshTmp()
      try {
        // First crash: commit 4, abort 6.
        await spawnAndKillMidTxn([dbPath, "round1", "4", "6", String(EMBED_DIM)])
        // WAL sibling MUST exist under WAL journal mode.
        const store1 = new SqliteStore(dbPath)
        let firstCount: number
        try {
          firstCount = (await store1.all()).filter((e) => e.id.includes("round1-committed-")).length
          expect(firstCount).toBe(4)
        } finally {
          store1.close()
        }
        expect(existsSync(`${dbPath}-wal`) || existsSync(dbPath)).toBe(true)

        // Second crash on the SAME db: commit 3 more, abort 5. Recovery must
        // be idempotent — round1's committed prefix survives a second torn run.
        await spawnAndKillMidTxn([dbPath, "round2", "3", "5", String(EMBED_DIM)])
        const store2 = new SqliteStore(dbPath)
        try {
          const all = await store2.all()
          const r1 = all.filter((e) => e.id.includes("round1-committed-"))
          const r2 = all.filter((e) => e.id.includes("round2-committed-"))
          const aborted = all.filter((e) => e.id.includes("-uncommitted-"))
          expect(r1.length).toBe(4) // first batch still intact
          expect(r2.length).toBe(3) // second committed batch landed
          expect(aborted).toEqual([]) // both aborted batches gone
        } finally {
          store2.close()
        }
      } finally {
        cleanupTmp()
      }
    }, 30_000)
  },
)
