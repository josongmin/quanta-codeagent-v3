/**
 * ★ CONTRACT — RFC-01 A2 feeder: wire `captureCheckpoint` into the live loop so
 * `/rewind --restore-files` can actually restore.
 *
 * GAP this closes: `captureCheckpoint` had NO production caller, so
 * `SavedSession.rollbackCheckpoints` was ALWAYS empty and `/rewind
 * --restore-files` fail-closed at `missing-checkpoint`. `feedCheckpointCapture`
 * is the ONE feeder that binds the newest live-registry anchor SHA to the last
 * message id and folds a durable record onto the SavedSession snapshot.
 *
 * Blocks:
 *   A. FRONT-DOOR — a fed checkpoint makes `/rewind --restore-files` RESOLVE
 *      (the coordinator no longer returns `missing-checkpoint`); the durable
 *      `checkpointSha` matches the live registry so the restore succeeds. This
 *      is the same real coordinator + effect bridge the CLI wires.
 *   B. NO CAPTURE — no anchor (no mutation) / no message id ⇒ NOTHING recorded
 *      ⇒ `/rewind --restore-files` still fail-closes safe (`missing-checkpoint`).
 *   C. NON-THROWING — a store reject / registry-throw is swallowed to a typed
 *      `error`; it never rejects (a capture failure MUST NOT break the turn).
 *   D. RED-ON-INJECTION — dropping the feed call reverts /rewind to
 *      missing-checkpoint (proved by the B-vs-A contrast on the SAME session).
 *
 * Hermetic: real SavedSession atomic store over a tmp QUANTA_SESSIONS_DIR; the
 * registry + restore effect are hand-rolled fakes so the SHA→tag bridge outcome
 * is pinned deterministically (the feeder + coordinator ordering are REAL).
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
import { feedCheckpointCapture } from "@/agent/rewind-capture-feeder"
import {
  createSavedSessionRollbackStore,
  executeRollback,
  type RollbackEffectPort,
  type ThreadRollbackOutcome,
} from "@/agent/thread-rollback"
import type { Message } from "@/llm"
import {
  assignMessageIds,
  loadSessionById,
  type SavePayload,
  type SessionMeta,
  saveSessionById,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const ANCHOR_SHA = "a".repeat(40)
const WORKSPACE = "/tmp/ws"

const mkMeta = (id: string): SessionMeta => ({
  id,
  title: "T",
  cwd: WORKSPACE,
  createdAt: 1_000,
  lastTouched: 1_000,
  archived: false,
})

/** A fake registry with the given (sha,tag) anchors, newest-first. */
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

const fakeRestore = (ok: boolean): ThreeWayRestorePort => {
  const outcome: RestoreOutcome = ok
    ? { ok: true, message: "restored", tag: "t", filesChanged: ["src/a.ts"] }
    : { ok: false, message: "conflict", tag: "t", errorCode: "shadow-rewind-failed" }
  return {
    restoreFiles: async () => outcome,
    restoreTask: async () => outcome,
    restoreBoth: async () => outcome,
  }
}

/** Seed a 3-message session WITH ids; return the id-bearing messages. */
const seedSession = async (id: string): Promise<readonly Message[]> => {
  const withIds = assignMessageIds(
    [
      { role: "user", content: [{ type: "text", text: "m0" }] },
      { role: "assistant", content: [{ type: "text", text: "m1" }] },
      { role: "user", content: [{ type: "text", text: "m2" }] },
    ],
    (i) => `mid-${i}`,
  )
  const payload: SavePayload = { reason: "ok", turns: 1, messages: [...withIds] }
  await saveSessionById(mkMeta(id), payload)
  return withIds
}

/** The `newest anchor SHA` source over a fake registry. */
const shaSourceOf = (registry: GranularRegistry): (() => string | undefined) => {
  return () => registry.list()[0]?.sha
}

/** A library-level effect port that mirrors the CLI `buildRollbackEffectPort`:
 *  resolve the durable `checkpointSha` against the live registry, then restore.
 *  Kept here (not imported from `@/apps/cli`) so this test stays slice-clean. */
const effectPortOf = (
  registry: GranularRegistry,
  restore: ThreeWayRestorePort,
): RollbackEffectPort => ({
  async restoreToCheckpoint(checkpoint) {
    const entry = registry.list().find((e) => e.sha === checkpoint.checkpointSha)
    if (entry === undefined) return { ok: false, code: "checkpoint-anchor-missing" }
    const outcome = await restore.restoreFiles(entry.tag)
    return outcome.ok ? { ok: true } : { ok: false, code: outcome.errorCode ?? "restore-failed" }
  },
})

/** Drive the REAL `executeRollback` over the REAL SavedSession rollback store —
 *  the exact ordering the CLI coordinator uses (this proves the durable mapping
 *  the feeder wrote is resolvable end-to-end, without a CLI-slice import). */
const restoreVia = (
  registry: GranularRegistry,
  restore: ThreeWayRestorePort,
): ((req: {
  sessionId: string
  operationId: string
  targetId: string
}) => Promise<ThreadRollbackOutcome>) => {
  const store = createSavedSessionRollbackStore()
  const effect = effectPortOf(registry, restore)
  return (req) =>
    executeRollback(
      { store, effect, now: () => 1234 },
      { sessionId: req.sessionId, operationId: req.operationId, targetTurnId: req.targetId },
    )
}

/* ------------------------------------------------------------------ */

describe("rewind-capture feeder — front-door (RFC01-2 wiring)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ckpt-feeder-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    delete process.env.QUANTA_SESSIONS_DIR
    __resetRuntimeConfig()
    rmSync(dir, { recursive: true, force: true })
  })

  test("A1: fed checkpoint ⇒ durable record on disk, keyed by the LAST message id", async () => {
    const id = "feed-ok"
    const msgs = await seedSession(id)
    const registry = fakeRegistry([{ sha: ANCHOR_SHA, tag: "tool:x" }])

    const result = await feedCheckpointCapture({
      sessionId: id,
      workspace: WORKSPACE,
      messages: msgs,
      latestAnchorSha: shaSourceOf(registry),
    })
    expect(result.kind).toBe("captured")

    const reloaded = await loadSessionById(id)
    const cps = reloaded?.rollbackCheckpoints ?? []
    expect(cps.length).toBe(1)
    // Bound to the LAST message id (mid-2), and the SHA is the registry anchor.
    expect(cps[0]?.turnId).toBe("mid-2")
    expect(cps[0]?.messageId).toBe("mid-2")
    expect(cps[0]?.checkpointSha).toBe(ANCHOR_SHA)
  })

  test("A2: FRONT-DOOR — after a feed, /rewind --restore-files RESOLVES (no longer missing-checkpoint) and restores", async () => {
    const id = "feed-restore"
    const msgs = await seedSession(id)
    const registry = fakeRegistry([{ sha: ANCHOR_SHA, tag: "tool:x" }])
    // The restore effect resolves the durable checkpointSha against THIS registry —
    // the SAME executeRollback ordering the CLI coordinator wires.
    const restore = restoreVia(registry, fakeRestore(true))

    // BEFORE the feed: the coordinator fails closed at missing-checkpoint.
    const before = await restore({ sessionId: id, operationId: "op-before", targetId: "mid-2" })
    expect(before.kind).toBe("rollback_failed")
    if (before.kind === "rollback_failed") expect(before.errorCode).toBe("missing-checkpoint")

    // Feed the checkpoint (the production wiring under test).
    const fed = await feedCheckpointCapture({
      sessionId: id,
      workspace: WORKSPACE,
      messages: msgs,
      latestAnchorSha: shaSourceOf(registry),
    })
    expect(fed.kind).toBe("captured")

    // AFTER the feed: the SAME target now RESTORES (durable rolled_back receipt).
    const after = await restore({ sessionId: id, operationId: "op-after", targetId: "mid-2" })
    expect(after.kind).toBe("rolled_back")
  })
})

describe("rewind-capture feeder — NO capture ⇒ /rewind stays fail-closed safe", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ckpt-feeder-neg-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    delete process.env.QUANTA_SESSIONS_DIR
    __resetRuntimeConfig()
    rmSync(dir, { recursive: true, force: true })
  })

  test("B1: no anchor (no mutation this turn) ⇒ NOTHING recorded ⇒ /rewind fail-closes at missing-checkpoint", async () => {
    const id = "feed-noanchor"
    const msgs = await seedSession(id)
    const emptyRegistry = fakeRegistry([])

    const result = await feedCheckpointCapture({
      sessionId: id,
      workspace: WORKSPACE,
      messages: msgs,
      latestAnchorSha: shaSourceOf(emptyRegistry),
    })
    expect(result.kind).toBe("no-anchor")

    const reloaded = await loadSessionById(id)
    expect(reloaded?.rollbackCheckpoints ?? []).toEqual([])

    // RED-ON-INJECTION anchor (D): with NO fed record, /rewind fail-closes.
    const restore = restoreVia(
      fakeRegistry([{ sha: ANCHOR_SHA, tag: "tool:x" }]),
      fakeRestore(true),
    )
    const outcome = await restore({ sessionId: id, operationId: "op-x", targetId: "mid-2" })
    expect(outcome.kind).toBe("rollback_failed")
    if (outcome.kind === "rollback_failed") expect(outcome.errorCode).toBe("missing-checkpoint")
  })

  test("B2: id-less transcript ⇒ no-message-id ⇒ NOTHING recorded", async () => {
    const id = "feed-noid"
    // Seed WITHOUT ids (legacy transcript).
    const payload: SavePayload = {
      reason: "ok",
      turns: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "m0" }] }],
    }
    await saveSessionById(mkMeta(id), payload)
    const registry = fakeRegistry([{ sha: ANCHOR_SHA, tag: "tool:x" }])

    const result = await feedCheckpointCapture({
      sessionId: id,
      workspace: WORKSPACE,
      messages: [{}], // id-less
      latestAnchorSha: shaSourceOf(registry),
    })
    expect(result.kind).toBe("no-message-id")
    const reloaded = await loadSessionById(id)
    expect(reloaded?.rollbackCheckpoints ?? []).toEqual([])
  })
})

describe("rewind-capture feeder — best-effort / NON-throwing", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ckpt-feeder-throw-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    delete process.env.QUANTA_SESSIONS_DIR
    __resetRuntimeConfig()
    rmSync(dir, { recursive: true, force: true })
  })

  test("C1: a THROWING registry sha-source is swallowed to a typed error — never rejects", async () => {
    const id = "feed-throw"
    const msgs = await seedSession(id)
    const throwing = (): string | undefined => {
      throw new Error("registry-boom")
    }
    // MUST NOT reject.
    const result = await feedCheckpointCapture({
      sessionId: id,
      workspace: WORKSPACE,
      messages: msgs,
      latestAnchorSha: throwing,
    })
    expect(result.kind).toBe("error")
    if (result.kind === "error") expect(result.reason).toContain("registry-boom")
    // The session is untouched (no partial record).
    const reloaded = await loadSessionById(id)
    expect(reloaded?.rollbackCheckpoints ?? []).toEqual([])
  })

  test("C2: a missing session ⇒ typed session-missing (the fold could not apply)", async () => {
    const registry = fakeRegistry([{ sha: ANCHOR_SHA, tag: "tool:x" }])
    const result = await feedCheckpointCapture({
      sessionId: "does-not-exist",
      workspace: WORKSPACE,
      messages: assignMessageIds(
        [{ role: "user", content: [{ type: "text", text: "x" }] }],
        (i) => `mid-${i}`,
      ),
      latestAnchorSha: shaSourceOf(registry),
    })
    expect(result.kind).toBe("session-missing")
  })

  test("C3: re-feed the SAME boundary REPLACES (newest SHA wins), does NOT duplicate", async () => {
    const id = "feed-replace"
    const msgs = await seedSession(id)
    const first = fakeRegistry([{ sha: ANCHOR_SHA, tag: "tool:x" }])
    const second = fakeRegistry([{ sha: "b".repeat(40), tag: "tool:y" }])

    await feedCheckpointCapture({
      sessionId: id,
      workspace: WORKSPACE,
      messages: msgs,
      latestAnchorSha: shaSourceOf(first),
    })
    await feedCheckpointCapture({
      sessionId: id,
      workspace: WORKSPACE,
      messages: msgs,
      latestAnchorSha: shaSourceOf(second),
    })

    const reloaded = await loadSessionById(id)
    const cps = reloaded?.rollbackCheckpoints ?? []
    expect(cps.length).toBe(1) // same (turnId,messageId) ⇒ replaced
    expect(cps[0]?.checkpointSha).toBe("b".repeat(40)) // newest SHA authoritative
  })
})
