/**
 * GOAL-01 hellgate — persisted objective snapshot v1 -> v2 migration.
 *
 * A real v1 SavedSession file (the on-disk shape minted before GOAL-01) must load
 * through the session store, reach the runner/assemble adapter, and migrate ONCE
 * into the v2 authority shape: deterministic legacy id, `createdBy: system` +
 * `migrationSource: legacy-v1`, explicit `completed` DISCARDED (re-derived from
 * receipts), receipts bound to the migrated objective id. v2 round-trips byte-
 * equivalently including a null TOMBSTONE thread.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asObjectiveAuthority, legacyObjectiveId } from "@/objective"
import {
  buildObjectiveAuthority,
  encodeObjectiveSnapshot,
  normalizeObjectiveSnapshot,
} from "@/runner/assemble/session-authorities"
import {
  loadSessionById,
  OBJECTIVE_SNAPSHOT_VERSION,
  type PersistedObjectiveSnapshotV1,
  type SessionMeta,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

const mkMeta = (id: string): SessionMeta => ({
  id,
  title: `T-${id}`,
  cwd: "/tmp/work",
  createdAt: 1_000,
  lastTouched: 1_000,
  archived: false,
})

const v1Snapshot = (): PersistedObjectiveSnapshotV1 => ({
  version: 1,
  threads: [
    {
      threadId: "thr-1",
      revision: 7,
      goal: "legacy goal",
      successCriteria: [
        {
          id: "c-1",
          text: "done",
          met: true,
          completion: { source: "manual", actor: "model", objectiveRevision: 3, verifiedAt: 9 },
        },
      ],
      status: "completed",
      explicitStatus: "completed",
      budget: { tokensUsed: 5, turnsUsed: 2, maxTurns: 10 },
      blockers: [],
      nextActions: ["n"],
      createdAt: 100,
      updatedAt: 200,
      progressReceipts: [
        {
          attemptKey: "k1",
          objectiveRevisionBefore: 6,
          objectiveRevisionAfter: 7,
          turnOutcome: "completed",
          criterionTransitions: ["c-1"],
          verifierReceiptRefs: [],
          remainingCriterionIds: [],
          recordedAt: 150,
        },
      ],
    },
    {
      threadId: "thr-2",
      revision: 2,
      goal: "explicitly completed with zero criteria",
      successCriteria: [],
      status: "completed",
      explicitStatus: "completed",
      budget: { tokensUsed: 0, turnsUsed: 0 },
      blockers: [],
      nextActions: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ],
})

describe("GOAL-01 — v1 -> v2 snapshot migration", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv
  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "obj-migrate-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) if (!(key in envSnapshot)) delete process.env[key]
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
  })

  test("the current snapshot version is 2 and normalize is idempotent on v2", () => {
    expect(OBJECTIVE_SNAPSHOT_VERSION).toBe(2)
    const v2 = normalizeObjectiveSnapshot(v1Snapshot())
    expect(v2.version).toBe(2)
    expect(normalizeObjectiveSnapshot(v2)).toEqual(v2)
  })

  test("a real v1 SavedSession file loads, migrates deterministically, and re-derives completion", async () => {
    const path = join(dir, "legacy.json")
    await Bun.write(
      path,
      JSON.stringify({
        version: 2,
        meta: mkMeta("legacy"),
        reason: "x",
        turns: 1,
        messages: [],
        objective: v1Snapshot(),
      }),
    )
    const loaded = await loadSessionById("legacy")
    expect(loaded?.objective?.version).toBe(1)
    const fresh = asObjectiveAuthority(
      buildObjectiveAuthority({ now: () => 5, restoreFrom: loaded?.objective }),
    )
    const expectedId = legacyObjectiveId({ threadId: "thr-1", goal: "legacy goal", createdAt: 100 })
    const o = fresh.get("thr-1")
    expect(o?.objectiveId).toBe(expectedId)
    expect(o?.createdBy).toBe("system")
    expect(o?.migrationSource).toBe("legacy-v1")
    expect(fresh.readDomain("thr-1").revision).toBe(7)
    // Explicit `completed` is discarded; completion re-derives from the receipt.
    expect(fresh.readDomain("thr-1").state?.explicitStatus).toBe("active")
    expect(o?.status).toBe("completed")
    expect(o?.successCriteria[0]?.completion?.objectiveId).toBe(expectedId)
    expect(fresh.readDomain("thr-1").progressReceipts?.[0]?.objectiveId).toBe(expectedId)
    // Zero-criteria explicit completion cannot be manufactured in v2.
    expect(fresh.get("thr-2")?.status).toBe("active")
    // Loading the same file twice yields the same id (deterministic).
    const again = asObjectiveAuthority(buildObjectiveAuthority({ restoreFrom: loaded?.objective }))
    expect(again.get("thr-1")?.objectiveId).toBe(expectedId)
  })

  test("v2 round-trip preserves id / creator / definition / progress / revision and a null tombstone", async () => {
    const auth = asObjectiveAuthority(buildObjectiveAuthority({ now: () => 9 }))
    auth.create("live", { goal: "keep", successCriteria: ["c"] })
    auth.create("gone", { goal: "drop" })
    auth.clear("gone")
    const tombstoneRevision = auth.readDomain("gone").revision
    expect(tombstoneRevision).toBeGreaterThan(0)
    const snapshot = encodeObjectiveSnapshot(auth)
    expect(snapshot.version).toBe(2)
    expect(snapshot.threads.find((t) => t.threadId === "gone")?.objective).toBeNull()
    await Bun.write(
      join(dir, "v2.json"),
      JSON.stringify({
        version: 2,
        meta: mkMeta("v2"),
        reason: "x",
        turns: 1,
        messages: [],
        objective: snapshot,
      }),
    )
    const reopened = await loadSessionById("v2")
    expect(reopened?.objective).toEqual(snapshot)
    const fresh = asObjectiveAuthority(
      buildObjectiveAuthority({ restoreFrom: reopened?.objective }),
    )
    expect(fresh.get("live")?.objectiveId).toBe(auth.get("live")?.objectiveId)
    expect(fresh.get("live")?.createdBy).toBe("system")
    expect(fresh.readDomain("gone").state).toBeNull()
    expect(fresh.readDomain("gone").revision).toBe(tombstoneRevision)
    // The tombstone still fences a stale pre-clear command after restart.
    const stale = fresh.commit(
      fresh.prepare({
        threadId: "gone",
        actor: "user",
        mutation: { kind: "create", definition: { goal: "again" } },
        expectedRevision: tombstoneRevision - 1,
      }),
      { admitted: true },
    )
    expect(stale.ok).toBe(false)
    expect(encodeObjectiveSnapshot(fresh)).toEqual(snapshot)
  })

  test("a v1 goal over the 4000-character ceiling is refused by migration (not silently truncated)", () => {
    const snap = v1Snapshot()
    const first = snap.threads[0]
    if (first === undefined) throw new Error("fixture has no thread")
    const long = { ...snap, threads: [{ ...first, goal: "g".repeat(4001) }] }
    const v2 = normalizeObjectiveSnapshot(long as PersistedObjectiveSnapshotV1)
    expect(v2.threads.find((t) => t.threadId === "thr-1")).toBeUndefined()
  })
})
