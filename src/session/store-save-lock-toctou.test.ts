/**
 * R3 ADVERSARIAL RE-AUDIT of fix 663e58e25 (saveSessionById read-modify-write
 * rollback preservation).
 *
 * ATTACK (a) TOCTOU: the fix reads the on-disk rollback ledger, then LATER
 * overwrites the whole file. There is NO lock. If a COORDINATOR fold
 * (createSavedSessionRollbackStore.saveOperations) commits a NEW rollback record
 * to disk in the await-gap BETWEEN this omitting-save's read and its write, the
 * omitting-save computes `payload(undefined) ?? preserved(STALE)` and its final
 * writeSessionFile clobbers the coordinator's just-written fold — silent
 * data-loss of the durable rollback ledger.
 *
 * This test forces that exact interleaving with a test-only barrier on the
 * storage readFile (production code untouched). The barrier gates ONLY the
 * omitting-save's rollback-preserve read of the target session file, releasing
 * it AFTER a real coordinator fold has fully committed a second operation.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetRuntimeConfig } from "@/shared"

let root: string
let priorEnv: string | undefined

beforeEach(() => {
  priorEnv = process.env.QUANTA_SESSIONS_DIR
  root = mkdtempSync(join(tmpdir(), "r3a-toctou-"))
  process.env.QUANTA_SESSIONS_DIR = root
  __resetRuntimeConfig()
})

afterEach(() => {
  if (priorEnv === undefined) delete process.env.QUANTA_SESSIONS_DIR
  else process.env.QUANTA_SESSIONS_DIR = priorEnv
  __resetRuntimeConfig()
  rmSync(root, { recursive: true, force: true })
  mock.restore()
})

test("store per-session save lock: a coordinator fold is NOT clobbered by a concurrent omitting save (TOCTOU closed)", async () => {
  // --- Test-only barrier over storage.readFile -------------------------------
  // We intercept ONLY the omitting-save's preserve-read of the session file and
  // hold it open until a coordinator fold has committed a second operation.
  const service = await import("@/storage/service")
  const realReadFile = service.readFile

  let releaseBarrier: (() => void) | undefined
  const barrierArmed = { value: false }
  const barrierHitOnce = { value: false }
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve
  })

  const order: string[] = []
  const patchedReadFile = async (p: string): Promise<string> => {
    // Gate only the FIRST session-file read that happens while the barrier is
    // armed (this is the omitting-save's readExistingRollback). Everything else
    // — including the coordinator's own load — passes straight through.
    //
    // CRITICAL: read the CURRENT bytes FIRST (this is the "T of C" — the value the
    // omitting-save will use), THEN park. Releasing later lets the coordinator's
    // write land in between, so the omitting-save proceeds with STALE content —
    // the genuine time-of-check-to-time-of-use gap.
    if (barrierArmed.value && !barrierHitOnce.value && p.endsWith("sess-toctou.json")) {
      barrierHitOnce.value = true
      const bytesAtCheck = await realReadFile(p)
      order.push("omitting-read-parked")
      await barrier
      order.push("omitting-read-released")
      return bytesAtCheck
    }
    return realReadFile(p)
  }

  const realWriteFile = service.writeFile
  const patchedWriteFile = async (p: string, body: string): Promise<void> => {
    // Session writes go to a per-writer `.tmp.<pid>.<rand>` then rename. Record
    // when the tmp for the target session is written to establish write order.
    if (p.includes("sess-toctou.json.tmp")) {
      const ops = (() => {
        try {
          return (JSON.parse(body).rollbackOperations ?? []).map(
            (o: { operationId: string }) => o.operationId,
          )
        } catch {
          return ["<unparsed>"]
        }
      })()
      order.push(`write:[${ops.join(",")}]`)
    }
    return realWriteFile(p, body)
  }

  mock.module("@/storage/service", () => ({
    ...service,
    readFile: patchedReadFile,
    writeFile: patchedWriteFile,
  }))

  // Re-import store AFTER the mock so it binds the patched readFile.
  const store = await import("./store")
  const { createSavedSessionRollbackStore } = await import("@/agent/thread-rollback")
  const { ROLLBACK_RECORD_VERSION } = await import("./types")

  const id = "sess-toctou"
  const m = {
    id,
    title: "t",
    cwd: "/tmp",
    createdAt: 1,
    lastTouched: 1,
    archived: false,
  } as const

  const op1 = {
    recordVersion: ROLLBACK_RECORD_VERSION,
    operationId: "op-1",
    targetTurnId: "turn-1",
    state: "rolled_back" as const,
    requestedAt: 10,
    terminalAt: 20,
  }
  const op2 = {
    recordVersion: ROLLBACK_RECORD_VERSION,
    operationId: "op-2",
    targetTurnId: "turn-2",
    state: "rolled_back" as const,
    requestedAt: 30,
    terminalAt: 40,
  }

  // (0) Seed the session with ONE operation already durable on disk.
  await store.saveSessionById(m, {
    reason: "rollback",
    turns: 1,
    messages: [],
    rollbackOperations: [op1],
  })

  // (1) Arm the barrier, then launch the OMITTING save (persist-turn shape:
  //     no rollback fields). Its readExistingRollback will read [op1] then park
  //     on the barrier before its write.
  barrierArmed.value = true
  const omittingSave = store.saveSessionById(m, {
    reason: "done",
    turns: 2,
    messages: [],
    // NO rollback fields — this is the hot-loop per-turn auto-save shape.
  })

  // Give the omitting save a chance to reach + park on the barrier.
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 20))

  // (2) While the omitting-save is parked at its post-read await, LAUNCH a
  //     COORDINATOR fold of a SECOND operation (do NOT await — under the store
  //     per-session save lock it must QUEUE behind the parked omitting save; the
  //     coordinator's own saveSessionById cannot land until the omitting save
  //     releases the lock).
  const coord = createSavedSessionRollbackStore()
  const coordFold = coord.saveOperations(id, [op1, op2])

  // Give the coordinator a chance to run. DISCRIMINATING CHECK (red-on-injection):
  // the omitting save is parked INSIDE its saveSessionById (holding the per-session
  // lock), so the coordinator's own saveSessionById MUST be blocked — its write
  // cannot have landed yet. WITHOUT the lock the coordinator writes [op-1,op-2]
  // right here (into the omitting save's TOC→TOU window) and this assertion fails.
  await new Promise((r) => setTimeout(r, 20))
  expect(order).not.toContain("write:[op-1,op-2]")

  // (3) Release the omitting-save. It writes its (stale) preserved [op1] FIRST,
  //     then the coordinator's queued fold writes [op1,op2]. Both settle.
  releaseBarrier?.()
  await Promise.all([omittingSave, coordFold])

  // (4) VERDICT: the coordinator's op-2 SURVIVES — the lock made the omitting
  //     save's read→write atomic, so it could not clobber a fold that landed in
  //     the (now impossible) TOC→TOU window.
  const finalDisk = await store.loadSessionById(id)
  const finalIds = finalDisk?.rollbackOperations?.map((o) => o.operationId) ?? []

  // NON-VACUITY: prove the omitting save's preserve-read DID park on the barrier
  // (the race window was genuinely engaged). Without the lock this same interleave
  // loses op-2 (finalIds === ["op-1"]) — proven by R3-A's characterization; the
  // lock flips it to the correct ["op-1","op-2"] (red-on-injection: remove the
  // withSessionSaveLock wrapper in store.ts and this assertion goes red).
  expect(barrierHitOnce.value).toBe(true)
  expect(order).toContain("omitting-read-parked")
  expect(finalIds).toEqual(["op-1", "op-2"])
})
