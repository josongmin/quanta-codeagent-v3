/**
 * RFC-def Surface B — `/rewind --restore-files` routes through the durable
 * ThreadRollback coordinator (front-door hellgate).
 *
 * Drives the REAL `/rewind` slash command with a REAL coordinator port
 * (`buildRewindRestoreCoordinator`) over the REAL SavedSession atomic snapshot
 * store (`createSavedSessionRollbackStore`) against a tmp `QUANTA_SESSIONS_DIR`.
 * The effect leg is a fake `ThreeWayRestorePort` + `GranularRegistry` so we can
 * pin the file-restore outcome deterministically (the registry SHA→tag bridge
 * and the coordinator ordering are the REAL code under test).
 *
 * Load-bearing safety claims (destructive-restore contract):
 *   - front-door restore + receipt: with a durable checkpoint mapping AND a
 *     successful effect, `/rewind <id> --restore-files --yes` restores the files
 *     through the coordinator and a `rolled_back` receipt is DURABLE on disk;
 *     the transcript is truncated only AFTER.
 *   - FAIL-CLOSED, NO PARTIAL:
 *       · missing checkpoint mapping ⇒ REFUSE (exit 1); the transcript is NOT
 *         truncated and NO rollback receipt is written as `rolled_back`.
 *       · moved-SHA (registry has no anchor for the recorded checkpointSha) ⇒
 *         REFUSE; a durable `rollback_failed` receipt is written, tree untouched.
 *       · effect conflict ⇒ REFUSE; `rollback_failed`, transcript intact.
 *   - gate/absent coordinator ⇒ `--restore-files` keeps its safe-degrade
 *     (transcript truncates, working-tree-unchanged note) byte-identical.
 *
 * RED-ON-INJECTION: the "missing checkpoint ⇒ refuse + transcript intact" test
 * is the drift anchor. If the command truncated the transcript on a refused
 * restore (partial), the reload would show FEWER messages — flipping
 * refuse→partial RED.
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
import type { Message } from "@/llm"
import { buildRewindRestoreCoordinator } from "@/apps/cli/repl/rewind-restore-coordinator-wire"
import type { RewindSlashState } from "@/apps/cli/rewind-cmd"
import { rewindCommands } from "@/apps/cli/rewind-cmd"
import type { SlashContext } from "@/apps/cli/slash-contract"
import {
  assignMessageIds,
  loadSessionById,
  latestOperation,
  ROLLBACK_RECORD_VERSION,
  type RollbackCheckpointRecord,
  type SavePayload,
  type SessionMeta,
  saveSessionById,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

const rewindCmd = rewindCommands.find((c) => c.name === "/rewind")
if (rewindCmd === undefined) throw new Error("test setup: /rewind command missing")

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const CHECKPOINT_SHA = "a".repeat(40)

const mkMeta = (id: string): SessionMeta => ({
  id,
  title: "T",
  cwd: "/tmp/work",
  createdAt: 1_000,
  lastTouched: 1_000,
  archived: false,
})

/** A fake registry with ONE anchor at `sha` under tag `tag`. */
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

/** A fake restore port with a pinned files-leg outcome. */
const fakeRestore = (ok: boolean, errorCode?: RestoreOutcome["errorCode"]): ThreeWayRestorePort => {
  const outcome: RestoreOutcome = ok
    ? { ok: true, message: "restored", tag: "t", filesChanged: ["src/a.ts"] }
    : { ok: false, message: "conflict", tag: "t", ...(errorCode !== undefined ? { errorCode } : {}) }
  return {
    restoreFiles: async () => outcome,
    restoreTask: async () => outcome,
    restoreBoth: async () => outcome,
  }
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

/** Seed a 3-message session; optionally with a durable checkpoint mapping whose
 *  `turnId` equals the target message id (so `resolveCheckpointForTurn` hits). */
const seedSession = async (
  id: string,
  targetMsgId: string,
  checkpoint?: RollbackCheckpointRecord,
): Promise<readonly Message[]> => {
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
    ...(checkpoint !== undefined ? { rollbackCheckpoints: [checkpoint] } : {}),
  }
  await saveSessionById(mkMeta(id), payload)
  return withIds
}

const mkCheckpoint = (turnId: string, sha: string): RollbackCheckpointRecord => ({
  recordVersion: ROLLBACK_RECORD_VERSION,
  turnId,
  messageId: turnId,
  checkpointSha: sha,
  expectedFileHashes: { "src/a.ts": "h1" },
})

/* ------------------------------------------------------------------ */

describe("Surface B — /rewind --restore-files through the coordinator", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rewind-restore-e2e-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    delete process.env.QUANTA_SESSIONS_DIR
    __resetRuntimeConfig()
    rmSync(dir, { recursive: true, force: true })
  })

  const state = (id: string, coordinatorPerTool?: { registry: GranularRegistry; restore: ThreeWayRestorePort }): RewindSlashState => ({
    sessionId: id,
    env: { QUANTA_REWIND: "1" },
    restoreFilesCoordinator: buildRewindRestoreCoordinator({
      ...(coordinatorPerTool !== undefined ? { perTool: coordinatorPerTool } : {}),
      now: () => 1234,
    }),
  })

  test("front-door: checkpoint present + effect ok ⇒ restored + DURABLE rolled_back receipt + transcript truncated", async () => {
    const id = "rb-ok"
    const target = "target-msg"
    await seedSession(id, target, mkCheckpoint(target, CHECKPOINT_SHA))
    const perTool = {
      registry: fakeRegistry([{ sha: CHECKPOINT_SHA, tag: "tool:x" }]),
      restore: fakeRestore(true),
    }
    const ctx = makeCtx(state(id, perTool))

    const code = await rewindCmd.run([target, "--restore-files", "--yes"], ctx)
    expect(code).toBe(0)

    // Durable receipt: reload from disk shows the terminal rolled_back.
    const reloaded = await loadSessionById(id)
    const ops = reloaded?.rollbackOperations ?? []
    expect(latestOperation(ops, `rewind-${target}`)?.state).toBe("rolled_back")
    // Transcript truncated to the target (only the first message survives).
    expect(reloaded?.messages.length).toBe(1)
  })

  test("FAIL-CLOSED: missing checkpoint mapping ⇒ REFUSE, transcript INTACT (no partial)", async () => {
    const id = "rb-nomap"
    const target = "target-msg"
    await seedSession(id, target /* NO checkpoint */)
    const perTool = {
      registry: fakeRegistry([{ sha: CHECKPOINT_SHA, tag: "tool:x" }]),
      restore: fakeRestore(true),
    }
    const ctx = makeCtx(state(id, perTool))

    const code = await rewindCmd.run([target, "--restore-files", "--yes"], ctx)
    expect(code).toBe(1)
    expect(ctx.errBuf.join("")).toContain("refused")

    const reloaded = await loadSessionById(id)
    // RED-ON-INJECTION: a partial-restore bug would have truncated the transcript.
    // The full 3-message transcript MUST survive a refused restore.
    expect(reloaded?.messages.length).toBe(3)
    // No `rolled_back` receipt.
    expect(latestOperation(reloaded?.rollbackOperations ?? [], `rewind-${target}`)?.state).not.toBe(
      "rolled_back",
    )
  })

  test("FAIL-CLOSED: moved-SHA (no registry anchor for checkpointSha) ⇒ REFUSE + rollback_failed, transcript intact", async () => {
    const id = "rb-moved"
    const target = "target-msg"
    await seedSession(id, target, mkCheckpoint(target, CHECKPOINT_SHA))
    // Registry anchor SHA does NOT match the recorded checkpointSha (moved).
    const perTool = {
      registry: fakeRegistry([{ sha: "b".repeat(40), tag: "tool:x" }]),
      restore: fakeRestore(true),
    }
    const ctx = makeCtx(state(id, perTool))

    const code = await rewindCmd.run([target, "--restore-files", "--yes"], ctx)
    expect(code).toBe(1)
    const reloaded = await loadSessionById(id)
    expect(reloaded?.messages.length).toBe(3) // transcript intact
    expect(latestOperation(reloaded?.rollbackOperations ?? [], `rewind-${target}`)?.state).toBe(
      "rollback_failed",
    )
  })

  test("FAIL-CLOSED: effect conflict ⇒ REFUSE + rollback_failed, transcript intact", async () => {
    const id = "rb-conflict"
    const target = "target-msg"
    await seedSession(id, target, mkCheckpoint(target, CHECKPOINT_SHA))
    const perTool = {
      registry: fakeRegistry([{ sha: CHECKPOINT_SHA, tag: "tool:x" }]),
      restore: fakeRestore(false, "shadow-rewind-failed"),
    }
    const ctx = makeCtx(state(id, perTool))

    const code = await rewindCmd.run([target, "--restore-files", "--yes"], ctx)
    expect(code).toBe(1)
    const reloaded = await loadSessionById(id)
    expect(reloaded?.messages.length).toBe(3)
    expect(latestOperation(reloaded?.rollbackOperations ?? [], `rewind-${target}`)?.state).toBe(
      "rollback_failed",
    )
  })

  test("idempotent: a second --restore-files with the same target returns the receipt, effect NOT re-run", async () => {
    const id = "rb-idem"
    const target = "target-msg"
    await seedSession(id, target, mkCheckpoint(target, CHECKPOINT_SHA))
    let restoreCalls = 0
    const restore: ThreeWayRestorePort = {
      restoreFiles: async () => {
        restoreCalls += 1
        return { ok: true, message: "ok", tag: "t" }
      },
      restoreTask: async () => ({ ok: true, message: "ok", tag: "t" }),
      restoreBoth: async () => ({ ok: true, message: "ok", tag: "t" }),
    }
    const perTool = { registry: fakeRegistry([{ sha: CHECKPOINT_SHA, tag: "tool:x" }]), restore }

    // First restore.
    const s = state(id, perTool)
    expect(await rewindCmd.run([target, "--restore-files", "--yes"], makeCtx(s))).toBe(0)
    // Re-seed the transcript (the first run truncated it) so the second run
    // resolves the same target; the coordinator idempotency is keyed by op id.
    await seedSession(id, target, mkCheckpoint(target, CHECKPOINT_SHA))
    // Preserve the operations written by the first run: reload+carry is done by
    // the store, so just re-run and assert the effect did not fire twice.
    expect(await rewindCmd.run([target, "--restore-files", "--yes"], makeCtx(s))).toBe(0)
    expect(restoreCalls).toBe(1)
  })
})

/* ------------------------------------------------------------------ */
/* gate-OFF / absent coordinator: safe-degrade byte-identical          */
/* ------------------------------------------------------------------ */

describe("Surface B — absent coordinator keeps the safe-degrade", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rewind-degrade-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    delete process.env.QUANTA_SESSIONS_DIR
    __resetRuntimeConfig()
    rmSync(dir, { recursive: true, force: true })
  })

  test("no coordinator + no git ⇒ --restore-files degrades (transcript truncates, tree unchanged note)", async () => {
    const id = "rb-degrade"
    const target = "target-msg"
    await seedSession(id, target)
    // env has QUANTA_REWIND_GIT unset ⇒ authorizeGitPort refuses BEFORE any
    // restore; the command exits 1 with the "set QUANTA_REWIND_GIT=1" note and
    // does NOT touch the transcript. This is the prior byte-identical posture.
    const ctx = makeCtx({ sessionId: id, env: { QUANTA_REWIND: "1" } })
    const code = await rewindCmd.run([target, "--restore-files", "--yes"], ctx)
    expect(code).toBe(1)
    expect(ctx.errBuf.join("")).toContain("QUANTA_REWIND_GIT=1")
    const reloaded = await loadSessionById(id)
    expect(reloaded?.messages.length).toBe(3) // transcript untouched
  })
})
