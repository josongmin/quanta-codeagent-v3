/**
 * R2 ADVERSARIAL RE-AUDIT — cross-RFC interaction (RFC01 rollback records ×
 * per-turn auto-save).
 *
 * SCENARIO (reachable, happy-path-adjacent, NOT covered by any single-lens audit):
 *   1. A session captures durable rollback state (RFC01-A2 checkpoints +
 *      operations on the SavedSession) — e.g. the user does a `/rewind`.
 *   2. The user CONTINUES the session (types another message → one more turn).
 *   3. The id-mode per-turn auto-save (`persistTurn` → `saveSessionById`) fires.
 *
 * `persistTurn` builds a SavePayload with ONLY {reason,turns,messages}. It does
 * NOT read the on-disk rollback records. `saveSessionById` overwrites the WHOLE
 * SavedSession file with a fresh object and only conditionally spreads the
 * rollback fields IF the payload carries them. Therefore the very next turn-save
 * after a rollback SILENTLY DROPS the durable rollbackCheckpoints +
 * rollbackOperations from disk → data loss of the rollback ledger + a crash
 * between turns can no longer be reconciled (RFC01 recovery invariant broken).
 *
 * Contrast: the RFC01 rollback store (`createSavedSessionRollbackStore`) and the
 * RFC06 worktree `persistOwnership` BOTH do a full read-modify-write that
 * re-spreads the rollback fields — so THEY are safe. The turn auto-save is the
 * one write path on the hot loop that does not, which is exactly the
 * inter-dimension gap a single-owner / happy-path lens misses.
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadSessionById,
  markSessionInterrupted,
  ROLLBACK_RECORD_VERSION,
  type RollbackCheckpointRecord,
  type RollbackOperationRecord,
  type SessionMeta,
  saveSessionById,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"
import { persistTurn } from "./persist-turn"

let root: string
let priorEnv: string | undefined

beforeEach(() => {
  priorEnv = process.env.QUANTA_SESSIONS_DIR
  root = mkdtempSync(join(tmpdir(), "r2-rollback-drop-"))
  process.env.QUANTA_SESSIONS_DIR = root
  __resetRuntimeConfig()
})

afterEach(() => {
  if (priorEnv === undefined) delete process.env.QUANTA_SESSIONS_DIR
  else process.env.QUANTA_SESSIONS_DIR = priorEnv
  __resetRuntimeConfig()
  rmSync(root, { recursive: true, force: true })
})

const meta = (id: string): SessionMeta => ({
  id,
  title: "t",
  cwd: "/tmp",
  createdAt: 1,
  lastTouched: 1,
  archived: false,
})

const checkpoint: RollbackCheckpointRecord = {
  recordVersion: ROLLBACK_RECORD_VERSION,
  turnId: "turn-1",
  messageId: "msg-1",
  checkpointSha: "deadbeef",
  expectedFileHashes: { "a.ts": "h1" },
}
const operation: RollbackOperationRecord = {
  recordVersion: ROLLBACK_RECORD_VERSION,
  operationId: "op-1",
  targetTurnId: "turn-1",
  state: "rolled_back",
  requestedAt: 10,
  terminalAt: 20,
}

test("PROVES BUG: per-turn id-mode auto-save DROPS durable rollback records that were on disk", async () => {
  const id = "sess-rollback-drop"
  const m = meta(id)

  // (1) A rollback wrote durable checkpoints + operations onto the snapshot.
  await saveSessionById(m, {
    reason: "rollback",
    turns: 1,
    messages: [],
    rollbackCheckpoints: [checkpoint],
    rollbackOperations: [operation],
  })

  // Precondition: the rollback ledger IS durable on disk.
  const before = await loadSessionById(id)
  expect(before?.rollbackCheckpoints).toEqual([checkpoint])
  expect(before?.rollbackOperations).toEqual([operation])

  // (2)+(3) The user continues; the id-mode per-turn auto-save fires.
  await persistTurn({
    state: undefined,
    idMeta: m,
    sessionId: id,
    messages: [],
    outcome: { reason: "done", turns: 2 } as never,
  })

  // (4) The bug: the rollback ledger is GONE — the turn-save clobbered it.
  const after = await loadSessionById(id)

  // These are the load-bearing assertions. On the CURRENT (buggy) production
  // code they FAIL (records are undefined). The structural fix — have
  // persistTurn read-modify-write the rollback fields like every other saver —
  // makes them pass. This is the PROOF the interaction bug exists.
  expect(after?.rollbackCheckpoints).toEqual([checkpoint])
  expect(after?.rollbackOperations).toEqual([operation])
})

test("PROVES BUG: crash-resume markSessionInterrupted (RFC crash-recovery × RFC01) DROPS rollback records", async () => {
  const id = "sess-crashmark-drop"
  const m = meta(id)

  await saveSessionById(m, {
    reason: "rollback",
    turns: 1,
    messages: [],
    rollbackCheckpoints: [checkpoint],
    rollbackOperations: [operation],
  })
  const before = await loadSessionById(id)
  expect(before?.rollbackOperations).toEqual([operation])

  // The crash-resume marker RMW writes the interrupted-turn marker at turn
  // START (gate ON). It only re-threads meta — NOT the top-level rollback
  // fields — so writing the marker WIPES the rollback ledger.
  await markSessionInterrupted(
    id,
    {
      userText: "u",
      partialAssistantText: "a",
      reason: "crash",
      interruptedAt: 1,
    },
    { env: { QUANTA_CRASH_RESUME: "1" } },
  )

  const after = await loadSessionById(id)
  // Sanity: the marker WAS written (the RMW ran, not a no-op).
  expect(after?.meta.interruptedTurn?.reason).toBe("crash")
  // The bug: the rollback ledger is gone even though we only meant to add a marker.
  expect(after?.rollbackCheckpoints).toEqual([checkpoint])
  expect(after?.rollbackOperations).toEqual([operation])
})
