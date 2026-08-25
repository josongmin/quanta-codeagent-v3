/**
 * GOAL-04 hellgate — two-phase attributed attempt accounting in the authority.
 *
 * `beginAttempt` (system only) reserves the turn and the autonomous hard-cap
 * slot durably BEFORE any paid call; `settleAttempt` closes exactly that
 * attempt once; a definition cannot be replaced/cleared under a started
 * attempt; an orphaned start survives persistence and is recovered only by an
 * explicit `abandonAttempt`; the attempt slot is single-occupancy and terminal
 * once fail-stopped.
 */

import { describe, expect, test } from "bun:test"
import {
  createObjectiveAttemptSlot,
  createObjectiveAuthority,
  createObjectiveCapabilities,
  type ObjectiveAttemptContext,
  type ObjectiveAttemptStart,
} from "@/objective"
import {
  buildObjectiveAuthority,
  encodeObjectiveSnapshot,
} from "@/runner/assemble/session-authorities"

const setup = (enforceBudget = false) => {
  const authority = createObjectiveAuthority({ now: () => 11, enforceBudget })
  authority.create("t", { goal: "g", successCriteria: ["c"], budget: { maxTurns: 3 } })
  const caps = createObjectiveCapabilities(authority)
  const start = (over: Partial<ObjectiveAttemptStart> = {}): ObjectiveAttemptStart => ({
    objectiveId: authority.get("t")?.objectiveId ?? "",
    attemptId: "a1",
    provenance: "autonomous-continuation",
    executionMode: "foreground",
    startedRevision: authority.readDomain("t").revision,
    ...over,
  })
  const settle = (attemptId = "a1", tokens = 5) =>
    caps.system.commit("t", {
      kind: "settleAttempt",
      settlement: {
        objectiveId: authority.get("t")?.objectiveId ?? "",
        attemptId,
        startedRevision: 1,
        tokensUsed: tokens,
        turnsUsed: 1,
        outcome: "completed",
        executionMode: "foreground",
        criterionIdsBefore: [],
        verifierReceiptIdsBefore: [],
        recordedAt: 12,
      },
    })
  return { authority, caps, start, settle }
}

describe("GOAL-04 — beginAttempt / settleAttempt", () => {
  test("begin reserves the turn and the autonomous counter; settle closes it without a second debit", () => {
    const { authority, caps, start, settle } = setup()
    expect(caps.system.commit("t", { kind: "beginAttempt", attempt: start() }).ok).toBe(true)
    const o = authority.get("t")
    expect(o?.attempts.started?.attemptId).toBe("a1")
    expect(o?.attempts.autonomousTurnsStarted).toBe(1)
    expect(o?.budget.turnsUsed).toBe(1)
    expect(settle("a1", 40).ok).toBe(true)
    const after = authority.get("t")
    expect(after?.attempts.started).toBeUndefined()
    expect(after?.budget.turnsUsed).toBe(1) // reserved at begin, not re-debited
    expect(after?.budget.tokensUsed).toBe(40)
    expect(authority.readDomain("t").progressReceipts?.[0]?.attemptKey).toBe("a1")
  })

  test("user-requested goal work debits the turn but NOT the autonomous hard-cap counter", () => {
    const { authority, caps, start } = setup()
    expect(
      caps.system.commit("t", {
        kind: "beginAttempt",
        attempt: start({ provenance: "user-requested-goal-work" }),
      }).ok,
    ).toBe(true)
    expect(authority.get("t")?.budget.turnsUsed).toBe(1)
    expect(authority.get("t")?.attempts.autonomousTurnsStarted).toBe(0)
  })

  test("only the system actor may begin; a second begin while started is attempt-in-flight; a replayed id is rejected", () => {
    const { authority, caps, start, settle } = setup()
    for (const actor of ["user", "model", "continuation", "verifier"] as const) {
      const res = authority.commit(
        authority.prepare({
          threadId: "t",
          actor,
          mutation: { kind: "beginAttempt", attempt: start() },
        }),
        { admitted: true },
      )
      expect(res.ok).toBe(false)
    }
    expect(caps.system.commit("t", { kind: "beginAttempt", attempt: start() }).ok).toBe(true)
    const again = caps.system.commit("t", {
      kind: "beginAttempt",
      attempt: start({ attemptId: "a2" }),
    })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toBe("attempt-in-flight")
    expect(settle("a1").ok).toBe(true)
    const replay = caps.system.commit("t", { kind: "beginAttempt", attempt: start() })
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.reason).toBe("attempt-replayed")
    expect(authority.get("t")?.budget.turnsUsed).toBe(1)
  })

  test("settling a different attempt than the started one is refused; the started one still settles", () => {
    const { authority, caps, start, settle } = setup()
    caps.system.commit("t", { kind: "beginAttempt", attempt: start() })
    const wrong = settle("someone-else")
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.reason).toBe("attempt-in-flight")
    expect(authority.get("t")?.attempts.started?.attemptId).toBe("a1")
    expect(settle("a1").ok).toBe(true)
  })

  test("replace / clear are refused under a started attempt; pause is allowed; abandon recovers", () => {
    const { authority, caps, start } = setup()
    caps.system.commit("t", { kind: "beginAttempt", attempt: start() })
    const replace = caps.user.commit("t", { kind: "replace", definition: { goal: "x" } })
    expect(replace.ok).toBe(false)
    if (!replace.ok) expect(replace.reason).toBe("attempt-in-flight")
    const clear = caps.user.commit("t", { kind: "clear" })
    expect(clear.ok).toBe(false)
    if (!clear.ok) expect(clear.reason).toBe("attempt-in-flight")
    expect(caps.user.commit("t", { kind: "setExplicitStatus", status: "paused" }).ok).toBe(true)
    for (const actor of ["model", "continuation", "verifier"] as const) {
      const res = authority.commit(
        authority.prepare({ threadId: "t", actor, mutation: { kind: "abandonAttempt" } }),
        { admitted: true },
      )
      expect(res.ok).toBe(false)
    }
    expect(caps.user.commit("t", { kind: "abandonAttempt", attemptId: "nope" }).ok).toBe(false)
    expect(caps.user.commit("t", { kind: "abandonAttempt" }).ok).toBe(true)
    expect(authority.get("t")?.attempts.started).toBeUndefined()
    // The consumed slot is NOT refunded by abandonment.
    expect(authority.get("t")?.budget.turnsUsed).toBe(1)
    expect(authority.get("t")?.attempts.autonomousTurnsStarted).toBe(1)
    expect(caps.user.commit("t", { kind: "replace", definition: { goal: "x" } }).ok).toBe(true)
  })

  test("an orphaned started attempt survives a persist -> restore round trip (never replayed, slot consumed)", () => {
    const port = buildObjectiveAuthority({ now: () => 1 })
    port.create("t", { goal: "g", successCriteria: ["c"] })
    const caps = createObjectiveCapabilities(port)
    const objectiveId = port.get("t")?.objectiveId ?? ""
    expect(
      caps.system.commit("t", {
        kind: "beginAttempt",
        attempt: {
          objectiveId,
          attemptId: "orphan",
          provenance: "autonomous-continuation",
          executionMode: "background",
          startedRevision: 1,
        },
      }).ok,
    ).toBe(true)
    const snapshot = encodeObjectiveSnapshot(port)
    const fresh = buildObjectiveAuthority({ restoreFrom: snapshot })
    const o = fresh.get("t")
    expect(o?.attempts.started?.attemptId).toBe("orphan")
    expect(o?.attempts.started?.executionMode).toBe("background")
    expect(o?.attempts.autonomousTurnsStarted).toBe(1)
    expect(o?.budget.turnsUsed).toBe(1)
    const freshCaps = createObjectiveCapabilities(fresh)
    const again = freshCaps.system.commit("t", {
      kind: "beginAttempt",
      attempt: {
        objectiveId,
        attemptId: "orphan-2",
        provenance: "autonomous-continuation",
        executionMode: "foreground",
        startedRevision: 1,
      },
    })
    expect(again.ok).toBe(false)
    expect(encodeObjectiveSnapshot(fresh)).toEqual(snapshot)
  })

  test("reaching maxTurns through reservations derives budget_limited under an enforcing authority", () => {
    const { authority, caps, start, settle } = setup(true)
    for (let i = 1; i <= 3; i += 1) {
      expect(
        caps.system.commit("t", { kind: "beginAttempt", attempt: start({ attemptId: `a${i}` }) })
          .ok,
      ).toBe(true)
      expect(settle(`a${i}`).ok).toBe(true)
    }
    expect(authority.get("t")?.budget.turnsUsed).toBe(3)
    expect(authority.get("t")?.status).toBe("budget_limited")
  })
})

describe("GOAL-04 — attempt slot", () => {
  const ctx: ObjectiveAttemptContext = {
    threadId: "t",
    objectiveId: "o",
    startedRevision: 1,
    attemptId: "a",
    provenance: "autonomous-continuation",
    executionMode: "foreground",
  }
  test("single occupancy: claim / take / release", () => {
    const slot = createObjectiveAttemptSlot()
    expect(slot.status().kind).toBe("empty")
    expect(slot.claim(ctx)).toBe(true)
    expect(slot.claim({ ...ctx, attemptId: "b" })).toBe(false)
    expect(slot.status()).toEqual({ kind: "claimed", attempt: ctx })
    expect(slot.take()).toEqual(ctx)
    expect(slot.take()).toBeUndefined()
    expect(slot.claim(ctx)).toBe(true)
    slot.release()
    expect(slot.status().kind).toBe("empty")
  })
  test("fail-stop is terminal until explicit recovery", () => {
    const slot = createObjectiveAttemptSlot()
    slot.claim(ctx)
    slot.failStop("settlement not durable")
    expect(slot.status()).toEqual({ kind: "fail-stopped", reason: "settlement not durable" })
    expect(slot.take()).toBeUndefined()
    expect(slot.claim(ctx)).toBe(false)
    slot.recover()
    expect(slot.claim(ctx)).toBe(true)
  })
})
