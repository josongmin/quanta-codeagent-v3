/**
 * ★ HELLGATE (P1-3, GOAL-05A rail 16) — a settled attempt ANNOUNCES itself.
 *
 * The progress receipt and its renderer both shipped, but nothing ever emitted
 * after a settlement: the operator saw progress only by typing `/goal`. The
 * rail was recorded as "deferred to 06/10" and neither honored it.
 *
 * The emission rides the SETTLEMENT (surface-agnostic), not a surface loop, so
 * CLI and web get it from one place. It carries the SETTLED facts — the
 * post-commit revision and the receipt the authority actually recorded — and it
 * never fires for a settlement the authority REFUSED (that path fail-stops the
 * slot; announcing success there would be the loudest possible lie).
 */

import { describe, expect, test } from "bun:test"
import {
  beginObjectiveAttempt,
  type ObjectiveSettlementNotice,
  settleObjectiveAttempt,
} from "@/host/runtime/internal/context-binding/objective-settlement"
import { createObjectiveAttemptSlot, createObjectiveAuthority } from "@/objective"

const meter = (snapshots: { inputTokens: number; outputTokens: number }[]) => {
  let index = 0
  return {
    snapshot: () => snapshots[Math.min(index++, snapshots.length - 1)] as never,
    tick: () => undefined,
  } as never
}

const armed = async (opts: { criteria?: string[] } = {}) => {
  const authority = createObjectiveAuthority({ now: () => 1 })
  authority.create("t", { goal: "ship", successCriteria: opts.criteria ?? ["c"] })
  const slot = createObjectiveAttemptSlot()
  const objectiveId = authority.get("t")?.objectiveId ?? ""
  slot.claim({
    threadId: "t",
    objectiveId,
    startedRevision: authority.readDomain("t").revision,
    attemptId: "attempt-1",
    provenance: "autonomous-continuation",
    executionMode: "background",
  })
  const attributed = await beginObjectiveAttempt({
    objective: authority,
    objectiveAttemptSlot: slot,
    budgetMeter: meter([
      { inputTokens: 0, outputTokens: 0 },
      { inputTokens: 30, outputTokens: 12 },
    ]),
    persistStart: undefined,
  })
  if (attributed === undefined) throw new Error("attempt not begun")
  return { authority, slot, attributed, objectiveId }
}

describe("P1-3 — settlement emits one checkpoint notice", () => {
  test("a settled attempt emits the SETTLED facts once", async () => {
    const { authority, attributed, objectiveId } = await armed()
    const seen: ObjectiveSettlementNotice[] = []
    await settleObjectiveAttempt({
      attributed,
      outcome: { reason: "completed" },
      budgetMeter: meter([{ inputTokens: 30, outputTokens: 12 }]),
      verifier: undefined,
      judge: undefined,
      now: () => 2,
      onSettled: (notice) => seen.push(notice),
    })
    expect(seen).toHaveLength(1)
    const notice = seen[0]
    expect(notice?.threadId).toBe("t")
    expect(notice?.objectiveId).toBe(objectiveId)
    expect(notice?.turnOutcome).toBe("completed")
    expect(notice?.tokensUsed).toBe(42)
    // POST-commit facts: the revision and receipt the authority actually holds.
    const domain = authority.readDomain("t")
    expect(notice?.objectiveRevision).toBe(domain.revision)
    expect(notice?.receiptCount).toBe(domain.progressReceipts?.length ?? 0)
    expect(notice?.remainingCriterionIds).toEqual(
      (authority.get("t")?.successCriteria ?? []).filter((c) => !c.met).map((c) => c.id),
    )
  })

  test("a REFUSED settlement emits nothing (never a success line over a fail-stop)", async () => {
    const { slot, attributed } = await armed()
    // Make the settlement refuse: the objective generation moves underneath it.
    const stale = { ...attributed, attempt: { ...attributed.attempt, objectiveId: "gone" } }
    const seen: ObjectiveSettlementNotice[] = []
    await settleObjectiveAttempt({
      attributed: stale,
      outcome: { reason: "completed" },
      budgetMeter: meter([{ inputTokens: 30, outputTokens: 12 }]),
      verifier: undefined,
      judge: undefined,
      now: () => 2,
      onSettled: (notice) => seen.push(notice),
    })
    expect(seen).toEqual([])
    expect(slot.status().kind).toBe("fail-stopped")
  })

  test("a throwing subscriber never breaks settlement (observability is not authority)", async () => {
    const { authority, attributed } = await armed()
    await settleObjectiveAttempt({
      attributed,
      outcome: { reason: "completed" },
      budgetMeter: meter([{ inputTokens: 30, outputTokens: 12 }]),
      verifier: undefined,
      judge: undefined,
      now: () => 2,
      onSettled: () => {
        throw new Error("sink exploded")
      },
    })
    // The settlement still landed.
    expect(authority.get("t")?.budget.turnsUsed).toBe(1)
    expect(authority.readDomain("t").progressReceipts).toHaveLength(1)
  })

  test("no sink wired ⇒ byte-identical settlement (the hook is optional)", async () => {
    const { authority, attributed } = await armed()
    await settleObjectiveAttempt({
      attributed,
      outcome: { reason: "completed" },
      budgetMeter: meter([{ inputTokens: 30, outputTokens: 12 }]),
      verifier: undefined,
      judge: undefined,
      now: () => 2,
    })
    expect(authority.readDomain("t").progressReceipts).toHaveLength(1)
  })
})
