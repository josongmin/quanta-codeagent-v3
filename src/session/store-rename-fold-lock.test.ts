/**
 * R4 fix rail — SECONDARY TOCTOU (renameSession vs coordinator rollback fold) CLOSED
 * via atomic read-modify-write. Originally an ATTACK 3 characterization of a LIVE
 * P1; now asserts both fields survive (red-on-injection: neutralize the lock).
 *
 * `renameSession` (and archive/unarchive/rewind) do a load→modify→write
 * OUTSIDE `withSessionSaveLock`, via a full-snapshot spread `{...existing,
 * meta}` + `writeSessionFile`. `renameSession` is REACHABLE from a DETACHED,
 * fire-and-forget path: the opt-in AI auto-titler (`createAutoTitlePort`) kicks
 * off on the first turn, does a (≤15s) LLM call the turn NEVER awaits, then
 * calls `renameSession`. If a coordinator rollback fold lands in the gap
 * between that rename's load and its write, the rename's stale full-snapshot
 * write CLOBBERS the fold's just-committed rollback ledger — data-loss the
 * per-id save lock cannot see (rename doesn't take it).
 *
 * This test forces the exact interleave with a test-only barrier on the
 * rename's post-read await (production untouched), and demonstrates the fold's
 * op is LOST. Rated P1 (reachable, but requires the opt-in auto-title feature +
 * a concurrent rollback; full-snapshot means only records added in the window
 * are lost, not the transcript). It is a CHARACTERIZATION test of a real gap —
 * NOT a claim the R3-A lock regressed.
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
  root = mkdtempSync(join(tmpdir(), "r4a-rename-toctou-"))
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

test("R4 fix — renameSession under withSessionSaveLock: a coordinator rollback fold is NOT clobbered (secondary TOCTOU closed)", async () => {
  const service = await import("@/storage/service")
  const realReadFile = service.readFile
  const realWriteFile = service.writeFile

  // Barrier: gate the rename's load (readSavedSession → readFile) of the target
  // session, hold it AFTER capturing bytes, release only after a coordinator
  // fold has fully committed. This reproduces rename's own load→write TOC→TOU.
  let release: (() => void) | undefined
  const barrier = new Promise<void>((r) => {
    release = r
  })
  const armed = { value: false }
  const hitOnce = { value: false }
  const order: string[] = []

  const patchedReadFile = async (p: string): Promise<string> => {
    if (armed.value && !hitOnce.value && p.endsWith("sess-rn.json")) {
      hitOnce.value = true
      const bytes = await realReadFile(p) // T-of-Check
      order.push("rename-read-parked")
      await barrier
      order.push("rename-read-released")
      return bytes // rename proceeds with STALE snapshot (no fold visible)
    }
    return realReadFile(p)
  }
  const patchedWriteFile = async (p: string, body: string): Promise<void> => {
    if (p.includes("sess-rn.json.tmp")) {
      const ops = (() => {
        try {
          return (JSON.parse(body).rollbackOperations ?? []).map(
            (o: { operationId: string }) => o.operationId,
          )
        } catch {
          return ["<x>"]
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

  const store = await import("./store")
  const { createSavedSessionRollbackStore } = await import("@/agent/thread-rollback")
  const { ROLLBACK_RECORD_VERSION } = await import("./types")

  const id = "sess-rn"
  const m = {
    id,
    title: "Untitled 2026-01-01 00:00",
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

  // (0) Seed: session with one durable rollback op.
  await store.saveSessionById(m, {
    reason: "seed",
    turns: 1,
    messages: [],
    rollbackOperations: [op1],
  })

  // (1) Arm + launch the DETACHED rename (auto-title shape). Its load reads
  //     {op1} then parks before its write.
  armed.value = true
  const rename = store.renameSession(id, "AI Title")
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 20))
  expect(order).toContain("rename-read-parked")

  // (2) While rename is parked (holding the per-session lock — R4 fix now wraps
  //     renameSession too), LAUNCH a coordinator fold of op-2 WITHOUT awaiting.
  //     Its saveSessionById must QUEUE behind the parked rename.
  const coord = createSavedSessionRollbackStore()
  const coordFold = coord.saveOperations(id, [op1, op2])

  // DISCRIMINATING CHECK (red-on-injection): with rename under the shared save
  // lock, the coordinator's fold write CANNOT land while rename is parked. WITHOUT
  // the lock on renameSession, the fold writes here and rename's later stale write
  // clobbers it (the demonstrated P1). Assert the fold has NOT landed mid-window.
  await new Promise((r) => setTimeout(r, 20))
  expect(order).not.toContain("write:[op-1,op-2]")

  // (3) Release rename: it writes its (now atomic) snapshot, then the queued
  //     coordinator fold writes [op1,op2]. op-2 SURVIVES.
  release?.()
  await Promise.all([rename, coordFold])

  const disk = await store.loadSessionById(id)
  const finalIds = disk?.rollbackOperations?.map((o) => o.operationId) ?? []

  // Rename DID apply (title changed) AND the coordinator fold survived — the
  // secondary TOCTOU is closed by routing rename through withSessionSaveLock.
  expect(disk?.meta.title).toBe("AI Title")
  expect(finalIds).toEqual(["op-1", "op-2"])
})
