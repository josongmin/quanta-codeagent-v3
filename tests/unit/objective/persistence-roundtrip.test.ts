/**
 * RFC-03 C2 — objective persistence roundtrip (RED-first, then GREEN).
 *
 * Base defect (a): the session store has NO durable objective snapshot, so a
 * real `save → close → reopen` (fresh runtime) LOSES the per-thread objective
 * ids / revision / provenance entirely. This pins the loss and proves the C2
 * fix — a versioned `SavedSession.objective` DTO + strict encode/restore adapter
 * — round-trips a BYTE-EQUIVALENT snapshot through the real session-store I/O.
 *
 * The encode/restore adapter is a Layer-2 (`runner/assemble`) helper: the
 * `@/session` slice stores JSON only and never value-imports objective domain
 * behavior (`@/session` denyImports includes `@/objective`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asObjectiveAuthority } from "@/objective"
import {
  buildObjectiveAuthority,
  encodeObjectiveSnapshot,
} from "@/runner/assemble/session-authorities"
import { loadSessionById, type SessionMeta, saveSessionById } from "@/session"
import { __resetRuntimeConfig } from "@/shared"

const mkMeta = (id: string): SessionMeta => ({
  id,
  title: `T-${id}`,
  cwd: "/tmp/work",
  createdAt: 1_000,
  lastTouched: 1_000,
  archived: false,
})

describe("RFC-03 C2 — objective persistence roundtrip", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "obj-persist-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
  })

  test("save→close→reopen preserves objective ids / revision / provenance (byte-equivalent)", async () => {
    // A FROZEN clock so createdAt/updatedAt are deterministic across the restore.
    const auth = buildObjectiveAuthority({ now: () => 4_242 })
    auth.set("thr-1", { goal: "ship the feature", successCriteria: ["compiles", "tests pass"] })
    // Provenance: an EXPLICIT paused intent (must survive, not default to active).
    auth.updateStatus("thr-1", "paused")
    // Bump the per-thread revision a few times through real mutations.
    auth.recordUsage("thr-1", { tokens: 10 })
    auth.markCriterion("thr-1", "does-not-exist", true) // no-op id ⇒ does not bump
    auth.setNextActions("thr-1", ["wire it", "test it"])
    // A second thread to prove multi-thread fidelity.
    auth.set("thr-2", { goal: "second goal" })

    const before = auth.get("thr-1")
    expect(before?.status).toBe("paused")
    const critIds = before?.successCriteria.map((c) => c.id) ?? []
    expect(critIds).toHaveLength(2)

    // ENCODE the live authority (ids + revision + provenance) and PERSIST it.
    const snapshot = encodeObjectiveSnapshot(auth)
    await saveSessionById(mkMeta("s-1"), {
      reason: "completed",
      turns: 3,
      messages: [],
      objective: snapshot,
    })

    // REOPEN in a fresh runtime: the DTO must round-trip byte-equivalently.
    const reopened = await loadSessionById("s-1")
    expect(reopened).toBeDefined()
    expect(reopened?.objective).toEqual(snapshot)

    // RESTORE a FRESH authority from the reopened snapshot (fixed restore order).
    const fresh = buildObjectiveAuthority({ now: () => 9_999, restoreFrom: reopened?.objective })
    const after = fresh.get("thr-1")

    // ids preserved EXACTLY (not re-minted).
    expect(after?.successCriteria.map((c) => c.id)).toEqual(critIds)
    // provenance preserved (explicit paused, not defaulted to active).
    expect(after?.status).toBe("paused")
    // next actions / goal / timestamps preserved.
    expect(after?.goal).toBe("ship the feature")
    expect(after?.nextActions).toEqual(["wire it", "test it"])
    expect(after?.createdAt).toBe(4_242)
    expect(after?.updatedAt).toBe(4_242)
    // second thread preserved.
    expect(fresh.get("thr-2")?.goal).toBe("second goal")

    // REVISION preserved EXACTLY: re-encoding the restored authority reproduces
    // the identical snapshot (revision is part of the DTO).
    expect(encodeObjectiveSnapshot(fresh)).toEqual(snapshot)
  })

  test("bounded ProgressReceipt evidence persists without changing objective revision", async () => {
    const auth = asObjectiveAuthority(buildObjectiveAuthority())
    auth.set("receipt", { goal: "prove it", successCriteria: ["checked"] })
    const before = auth.readDomain("receipt").revision
    expect(
      auth.recordProgressReceipt("receipt", {
        attemptKey: '["receipt",1,0]',
        objectiveRevisionBefore: before,
        objectiveRevisionAfter: before,
        turnOutcome: "completed",
        criterionTransitions: [],
        verifierReceiptRefs: ["receipt:check"],
        sourceDigest: "sha256:abc",
        remainingCriterionIds: [auth.get("receipt")?.successCriteria[0]?.id ?? "missing"],
        recordedAt: 123,
      }),
    ).toBe(true)
    expect(auth.readDomain("receipt").revision).toBe(before)
    const snapshot = encodeObjectiveSnapshot(auth)
    const fresh = asObjectiveAuthority(buildObjectiveAuthority({ restoreFrom: snapshot }))
    expect(fresh.readDomain("receipt").progressReceipts).toEqual(
      auth.readDomain("receipt").progressReceipts,
    )
    expect(encodeObjectiveSnapshot(fresh)).toEqual(snapshot)
  })

  test("restore preserves a COMPLETED objective (met criteria) + a BLOCKED one (byte-equivalent)", async () => {
    const auth = buildObjectiveAuthority({ now: () => 100 })
    // thread A: all criteria met ⇒ derived `completed`.
    const a = auth.set("done", { goal: "finish", successCriteria: ["only"] })
    auth.markCriterion("done", a.successCriteria[0]?.id ?? "", true)
    expect(auth.get("done")?.status).toBe("completed")
    // thread B: a live blocker ⇒ derived `blocked` (wins over explicit intent).
    auth.set("stuck", { goal: "unblock" })
    auth.addBlocker("stuck", { reason: "waiting on user", waitingOn: "user" })
    expect(auth.get("stuck")?.status).toBe("blocked")

    const snapshot = encodeObjectiveSnapshot(auth)
    await saveSessionById(mkMeta("s-2"), {
      reason: "x",
      turns: 1,
      messages: [],
      objective: snapshot,
    })
    const reopened = await loadSessionById("s-2")

    const fresh = buildObjectiveAuthority({ now: () => 200, restoreFrom: reopened?.objective })
    // Derived statuses re-derive correctly from restored criteria/blockers.
    expect(fresh.get("done")?.status).toBe("completed")
    expect(fresh.get("stuck")?.status).toBe("blocked")
    expect(fresh.get("done")?.successCriteria[0]?.met).toBe(true)
    expect(fresh.get("stuck")?.blockers[0]?.reason).toBe("waiting on user")
    // Byte-equivalent snapshot from the fresh runtime.
    expect(encodeObjectiveSnapshot(fresh)).toEqual(snapshot)
  })

  test("usage window + budget caps survive a save→reopen under an enforcing authority", async () => {
    const auth = buildObjectiveAuthority({ now: () => 500, enforceBudget: true })
    auth.set("lim", { goal: "cap", budget: { maxTokens: 100, maxTurns: 5 } })
    auth.recordUsage("lim", { tokens: 40 })
    auth.markUsageLimited("lim", 9_000)
    expect(auth.get("lim")?.status).toBe("usage_limited")

    const snapshot = encodeObjectiveSnapshot(auth)
    // The transient window rides the DTO.
    expect(snapshot.threads[0]?.usageLimitedUntil).toBe(9_000)
    await saveSessionById(mkMeta("s-3"), {
      reason: "x",
      turns: 1,
      messages: [],
      objective: snapshot,
    })
    const reopened = await loadSessionById("s-3")

    // A clock BEFORE the window ⇒ still usage_limited; budget cap preserved.
    const fresh = buildObjectiveAuthority({
      now: () => 500,
      enforceBudget: true,
      restoreFrom: reopened?.objective,
    })
    const o = fresh.get("lim")
    expect(o?.status).toBe("usage_limited")
    expect(o?.budget.maxTokens).toBe(100)
    expect(o?.budget.tokensUsed).toBe(40)
    expect(encodeObjectiveSnapshot(fresh)).toEqual(snapshot)
  })

  test("a legacy session (NO objective field) loads with objective absent + re-save is byte-identical", async () => {
    // Write a v2 session with NO objective (the pre-C2 on-disk shape).
    await saveSessionById(mkMeta("legacy"), { reason: "x", turns: 0, messages: [] })
    const loaded = await loadSessionById("legacy")
    expect(loaded).toBeDefined()
    expect(loaded?.objective).toBeUndefined()

    // An omitting re-save must NOT invent an objective (byte-identical).
    await saveSessionById(mkMeta("legacy"), { reason: "y", turns: 1, messages: [] })
    const again = await loadSessionById("legacy")
    expect(again?.objective).toBeUndefined()
    expect(Object.hasOwn(again ?? {}, "objective")).toBe(false)
  })

  test("an omitting save PRESERVES an existing objective snapshot on disk (no wipe)", async () => {
    const auth = buildObjectiveAuthority({ now: () => 1 })
    auth.set("keep", { goal: "persist me" })
    const snapshot = encodeObjectiveSnapshot(auth)
    await saveSessionById(mkMeta("pres"), {
      reason: "x",
      turns: 1,
      messages: [],
      objective: snapshot,
    })
    // A plain transcript save (crash-resume marker style) omits `objective`.
    await saveSessionById(mkMeta("pres"), { reason: "auto", turns: 2, messages: [] })
    const reopened = await loadSessionById("pres")
    expect(reopened?.objective).toEqual(snapshot)
  })

  test("an UNKNOWN objective-snapshot version fail-closes the WHOLE session load", async () => {
    const auth = buildObjectiveAuthority({ now: () => 1 })
    auth.set("t", { goal: "g" })
    const snapshot = encodeObjectiveSnapshot(auth)
    await saveSessionById(mkMeta("bad"), {
      reason: "x",
      turns: 1,
      messages: [],
      objective: snapshot,
    })
    // Corrupt the persisted objective version on disk.
    const path = join(dir, "bad.json")
    const raw = JSON.parse(await Bun.file(path).text())
    raw.objective.version = 999
    await Bun.write(path, JSON.stringify(raw))
    // The strict decoder refuses the whole file (never partially applied).
    expect(await loadSessionById("bad")).toBeUndefined()
  })
})
