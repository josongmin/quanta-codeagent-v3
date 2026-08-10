/**
 * RFC01-3 crash-recovery — `/rewind --recover` resumes a rollback interrupted
 * BETWEEN the durable `requested` intent-persist and the terminal receipt.
 *
 * The dead seam this closes: `resumePendingRollback` / `pendingOperationIds`
 * wrote a durable recovery breadcrumb but NOTHING read it on restart. A crash
 * mid-rollback left a durable `requested` op that was never resumed. This suite
 * drives the REAL coordinator wire (`buildRewindRestoreCoordinator`) + the REAL
 * SavedSession atomic snapshot store against a tmp `QUANTA_SESSIONS_DIR`, then:
 *
 *   1) SIMULATE a crash: persist a `requested` breadcrumb (intent, no terminal)
 *      via the REAL coordinator (an effect that THROWS after the intent) — the
 *      exact "crashed between intent and receipt" state.
 *   2) FRESH RESUME: build a NEW coordinator (as a restart would) and run
 *      `/rewind --recover` → assert the pending op is driven to a TERMINAL
 *      receipt (rolled_back) and no longer pending.
 *
 * RED-ON-INJECTION anchor: the "resume runs recovery" test. If the wire is
 * removed (recoverPending returns `{recovered:[]}` / never calls
 * resumePendingRollback), the breadcrumb stays `requested` and the assertions
 * (recovered non-empty + terminal receipt) flip RED.
 *
 * Crash-consistency:
 *   - IDEMPOTENT: a SECOND `--recover` after a completed one is a no-op (nothing
 *     pending; the effect does NOT re-fire).
 *   - PARTIAL-RESTORE CRASH MID-RECOVERY: an effect that fails on resume writes a
 *     `rollback_failed` terminal (fail-closed) — the op is resolved, not left
 *     dangling, and the tree is NOT restored over.
 *   - No pending ⇒ empty recovery (default-OFF / clean-session no-op).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  GranularCheckpointEntry,
  GranularRegistry,
  RestoreOutcome,
  ThreeWayRestorePort,
} from "@/agent/per-tool-checkpoint"
import { buildRewindRestoreCoordinator } from "@/apps/cli/repl/rewind-restore-coordinator-wire"
import type { RewindSlashState } from "@/apps/cli/rewind-cmd"
import { rewindCommands } from "@/apps/cli/rewind-cmd"
import type { SlashContext } from "@/apps/cli/slash-contract"
import {
  assignMessageIds,
  latestOperation,
  loadSessionById,
  pendingOperationIds,
  ROLLBACK_RECORD_VERSION,
  type RollbackCheckpointRecord,
  type SavePayload,
  type SessionMeta,
  saveSessionById,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

const rewindCmd = rewindCommands.find((c) => c.name === "/rewind")
if (rewindCmd === undefined) throw new Error("test setup: /rewind command missing")

const CHECKPOINT_SHA = "a".repeat(40)

const mkMeta = (id: string): SessionMeta => ({
  id,
  title: "T",
  cwd: "/tmp/work",
  createdAt: 1_000,
  lastTouched: 1_000,
  archived: false,
})

const fakeRegistry = (entries: readonly { sha: string; tag: string }[]): GranularRegistry => {
  const list: GranularCheckpointEntry[] = entries.map((e) => ({
    tag: e.tag,
    granularity: "tool",
    sha: e.sha,
    takenAt: 1,
  }))
  return {
    list: () => list,
    lookup: (tag) => list.find((e) => e.tag === tag) ?? null,
    stats: () => ({ entryCount: list.length, entryCap: 50, counterCount: 0, counterCap: 50 }),
    clear: () => {},
  }
}

/** A restore port whose files-leg outcome is pinned and whose call count is
 *  observable (so idempotency = "effect not re-fired" is provable). */
const countingRestore = (
  outcome: RestoreOutcome,
): { port: ThreeWayRestorePort; calls: () => number } => {
  let calls = 0
  const port: ThreeWayRestorePort = {
    restoreFiles: async () => {
      calls += 1
      return outcome
    },
    restoreTask: async () => outcome,
    restoreBoth: async () => outcome,
  }
  return { port, calls: () => calls }
}

interface CapturedCtx extends SlashContext {
  readonly outBuf: string[]
  readonly errBuf: string[]
}

const makeCtx = (state: RewindSlashState): CapturedCtx => {
  const outBuf: string[] = []
  const errBuf: string[] = []
  return {
    outBuf,
    errBuf,
    out: (s: string) => {
      outBuf.push(s)
    },
    err: (s: string) => {
      errBuf.push(s)
    },
    rewindSession: state,
  } as CapturedCtx
}

const mkCheckpoint = (turnId: string, sha: string): RollbackCheckpointRecord => ({
  recordVersion: ROLLBACK_RECORD_VERSION,
  turnId,
  messageId: turnId,
  checkpointSha: sha,
  expectedFileHashes: { "src/a.ts": "h1" },
})

/** Seed a 3-message session with a durable checkpoint mapping keyed at
 *  `targetMsgId` (so `resolveRollbackTarget` hits on recovery). */
const seedSession = async (id: string, targetMsgId: string): Promise<void> => {
  const withIds = assignMessageIds(
    [
      { role: "user", content: [{ type: "text", text: "m0" }] },
      { role: "assistant", content: [{ type: "text", text: "m1" }] },
      { role: "user", content: [{ type: "text", text: "m2" }] },
    ],
    (i) => (i === 0 ? targetMsgId : `mid-${i}`),
  )
  const payload: SavePayload = {
    reason: "ok",
    turns: 1,
    messages: withIds,
    rollbackCheckpoints: [mkCheckpoint(targetMsgId, CHECKPOINT_SHA)],
  }
  await saveSessionById(mkMeta(id), payload)
}

const OK_RESTORE: RestoreOutcome = { ok: true, message: "restored", tag: "t", filesChanged: [] }

/**
 * SIMULATE A CRASH: use a REAL coordinator whose effect THROWS to leave a durable
 * `requested` intent with NO terminal receipt — the exact "crashed between intent
 * and receipt" breadcrumb (executeRollback persists the intent BEFORE the effect,
 * and on an effect throw persists a `rollback_failed`... so to get a stuck
 * `requested` we must interrupt AFTER intent, BEFORE terminal). We do that by
 * driving `restoreToMessage` with an effect that throws AND swallowing the throw,
 * then hand-verifying the on-disk state is `requested`.
 *
 * NOTE: executeRollback's own catch converts a thrown effect into a
 * `rollback_failed` terminal. So to get a genuinely-stuck `requested` op we
 * persist the intent through the REAL store the coordinator uses, WITHOUT a
 * terminal — mirroring a process kill between the two persists.
 */
const persistCrashedIntent = async (id: string, target: string): Promise<void> => {
  const saved = await loadSessionById(id)
  if (saved === undefined) throw new Error("test setup: session missing")
  const operations = [
    ...(saved.rollbackOperations ?? []),
    {
      recordVersion: ROLLBACK_RECORD_VERSION,
      operationId: `rewind-${target}`,
      targetTurnId: target,
      state: "requested" as const,
      requestedAt: 1_000,
    },
  ]
  await saveSessionById(mkMeta(id), {
    reason: "crash-sim",
    turns: 1,
    messages: saved.messages,
    rollbackCheckpoints: saved.rollbackCheckpoints ?? [],
    rollbackOperations: operations,
  })
}

const state = (
  id: string,
  perTool?: { registry: GranularRegistry; restore: ThreeWayRestorePort },
): RewindSlashState => ({
  sessionId: id,
  env: { QUANTA_REWIND: "1" },
  restoreFilesCoordinator: buildRewindRestoreCoordinator({
    ...(perTool !== undefined ? { perTool } : {}),
    now: () => 4242,
  }),
})

describe("RFC01-3 — /rewind --recover resumes a crash-interrupted rollback", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rewind-recover-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    delete process.env.QUANTA_SESSIONS_DIR
    __resetRuntimeConfig()
    rmSync(dir, { recursive: true, force: true })
  })

  test("RESUME RUNS RECOVERY: a persisted `requested` breadcrumb → --recover drives it to a terminal rolled_back receipt", async () => {
    const id = "rec-ok"
    const target = "target-msg"
    await seedSession(id, target)
    await persistCrashedIntent(id, target)

    // Precondition: the op is genuinely stuck `requested` on disk (a crashed
    // rollback breadcrumb that nothing has read yet).
    const before = await loadSessionById(id)
    expect(pendingOperationIds(before?.rollbackOperations ?? [])).toEqual([`rewind-${target}`])

    // FRESH RESUME: a NEW coordinator (as a restart builds) + the recovery verb.
    const { port, calls } = countingRestore(OK_RESTORE)
    const ctx = makeCtx(
      state(id, {
        registry: fakeRegistry([{ sha: CHECKPOINT_SHA, tag: "tool:x" }]),
        restore: port,
      }),
    )
    const code = await rewindCmd.run(["--recover", "--yes"], ctx)

    expect(code).toBe(0)
    expect(ctx.outBuf.join("")).toContain("rolled_back")
    // The wire actually ran the resume effect exactly once.
    expect(calls()).toBe(1)

    // Durable: the breadcrumb is now a terminal rolled_back receipt, no longer pending.
    const after = await loadSessionById(id)
    expect(latestOperation(after?.rollbackOperations ?? [], `rewind-${target}`)?.state).toBe(
      "rolled_back",
    )
    expect(pendingOperationIds(after?.rollbackOperations ?? [])).toEqual([])
  })

  test("IDEMPOTENT: a SECOND --recover after a completed one is a no-op (effect NOT re-fired)", async () => {
    const id = "rec-idem"
    const target = "target-msg"
    await seedSession(id, target)
    await persistCrashedIntent(id, target)

    const { port, calls } = countingRestore(OK_RESTORE)
    const perTool = {
      registry: fakeRegistry([{ sha: CHECKPOINT_SHA, tag: "tool:x" }]),
      restore: port,
    }
    // First recovery completes it.
    expect(await rewindCmd.run(["--recover"], makeCtx(state(id, perTool)))).toBe(0)
    expect(calls()).toBe(1)

    // Second recovery on the SAME session: nothing pending ⇒ no-op, effect not re-run.
    const ctx2 = makeCtx(state(id, perTool))
    const code2 = await rewindCmd.run(["--recover"], ctx2)
    expect(code2).toBe(0)
    expect(ctx2.outBuf.join("")).toContain("nothing to recover")
    expect(calls()).toBe(1) // NOT re-fired
  })

  test("PARTIAL-RESTORE CRASH MID-RECOVERY: an effect that fails on resume writes a fail-closed rollback_failed (op resolved, not dangling)", async () => {
    const id = "rec-fail"
    const target = "target-msg"
    await seedSession(id, target)
    await persistCrashedIntent(id, target)

    const failOutcome: RestoreOutcome = {
      ok: false,
      message: "conflict",
      tag: "t",
      errorCode: "shadow-rewind-failed",
    }
    const { port } = countingRestore(failOutcome)
    const ctx = makeCtx(
      state(id, {
        registry: fakeRegistry([{ sha: CHECKPOINT_SHA, tag: "tool:x" }]),
        restore: port,
      }),
    )
    const code = await rewindCmd.run(["--recover"], ctx)

    // The op is DRIVEN TO A TERMINAL (rollback_failed) — resolved, not left pending.
    expect(code).toBe(0) // the recovery ran; the individual op resolved (failed)
    expect(ctx.outBuf.join("")).toContain("rollback_failed")
    const after = await loadSessionById(id)
    expect(latestOperation(after?.rollbackOperations ?? [], `rewind-${target}`)?.state).toBe(
      "rollback_failed",
    )
    expect(pendingOperationIds(after?.rollbackOperations ?? [])).toEqual([])
  })

  test("NO PENDING: a clean session --recover is a no-op (nothing recovered)", async () => {
    const id = "rec-clean"
    const target = "target-msg"
    await seedSession(id, target) // NO crashed intent

    const { port, calls } = countingRestore(OK_RESTORE)
    const ctx = makeCtx(
      state(id, {
        registry: fakeRegistry([{ sha: CHECKPOINT_SHA, tag: "tool:x" }]),
        restore: port,
      }),
    )
    const code = await rewindCmd.run(["--recover"], ctx)

    expect(code).toBe(0)
    expect(ctx.outBuf.join("")).toContain("nothing to recover")
    expect(calls()).toBe(0)
  })

  test("GATE / absent coordinator: --recover refuses with a clear note (byte-identical no-op)", async () => {
    const id = "rec-nowire"
    const target = "target-msg"
    await seedSession(id, target)
    await persistCrashedIntent(id, target)

    // No restoreFilesCoordinator wired (QUANTA_REWIND_GIT off in production).
    const ctx = makeCtx({ sessionId: id, env: { QUANTA_REWIND: "1" } })
    const code = await rewindCmd.run(["--recover"], ctx)
    expect(code).toBe(1)
    expect(ctx.errBuf.join("")).toContain("QUANTA_REWIND_GIT=1")

    // The breadcrumb is UNTOUCHED (nothing mutated).
    const after = await loadSessionById(id)
    expect(pendingOperationIds(after?.rollbackOperations ?? [])).toEqual([`rewind-${target}`])
  })
})
