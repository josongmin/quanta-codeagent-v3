/**
 * GOAL-04 rail 13 — "usage is MEASURED, never self-reported": the settled
 * attempt records the BudgetMeter delta, not the stream-event accumulator the
 * model's own provider frames feed. The two are indistinguishable in the
 * production e2e (both sinks read the same usage event), so this pins the
 * discrimination directly: a meter whose delta DISAGREES with the observed
 * events must win.
 */

import { describe, expect, test } from "bun:test"
import {
  beginObjectiveAttempt,
  settleObjectiveAttempt,
} from "@/host/runtime/internal/context-binding/objective-settlement"
import { createObjectiveAttemptSlot, createObjectiveAuthority } from "@/objective"

/** ONE stateful meter, handed to BOTH `beginObjectiveAttempt` and
 *  `settleObjectiveAttempt` exactly as the turn runner does (`cfg.budgetMeter`):
 *  successive `snapshot()` calls walk the script, so snapshot ORDER and
 *  CARDINALITY are part of what these tests pin. */
const meterOf = (snapshots: { inputTokens: number; outputTokens: number }[]) => {
  let index = 0
  const reads: number[] = []
  return {
    meter: {
      snapshot: () => {
        const at = Math.min(index, snapshots.length - 1)
        index += 1
        reads.push(at)
        return snapshots[at] as never
      },
      tick: () => undefined,
    } as never,
    reads: () => reads,
  }
}

const armed = async (meter: unknown, usageSource?: "legacy-stream-events") => {
  const authority = createObjectiveAuthority({ now: () => 1 })
  authority.create("t", { goal: "ship", successCriteria: ["c"] })
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
    budgetMeter: meter as never,
    persistStart: undefined,
    ...(usageSource !== undefined ? { usageSource } : {}),
  })
  if (attributed === undefined) throw new Error("attempt not begun")
  return { authority, attributed }
}

describe("GOAL-04 rail 13 — measured usage comes from the meter, not the model's frames", () => {
  test("meter delta 20 vs accumulator 10 ⇒ the settled attempt records 20", async () => {
    // The SAME meter is read at begin (5+5) and at settle (20+10) ⇒ delta 20.
    const scripted = meterOf([
      { inputTokens: 5, outputTokens: 5 },
      { inputTokens: 20, outputTokens: 10 },
    ])
    const { authority, attributed } = await armed(scripted.meter)
    // The model's own frames claim only 10 tokens.
    attributed.usage.observe({ type: "usage", inputTokens: 7, outputTokens: 3 } as never)
    await settleObjectiveAttempt({
      attributed,
      outcome: { reason: "completed" },
      budgetMeter: scripted.meter,
      verifier: undefined,
      judge: undefined,
      now: () => 2,
    })
    expect(authority.get("t")?.budget.tokensUsed).toBe(20)
    // Exactly two reads, in order: the before-snapshot and the after-snapshot.
    expect(scripted.reads()).toEqual([0, 1])
  })

  test("the accumulator is a LIVE alternative: with the legacy source opted in, the frames ARE the measure", async () => {
    // Pins that the meter branch is a real CHOICE (a dead accumulator would
    // make the discrimination above vacuous).
    const { authority, attributed } = await armed(undefined, "legacy-stream-events")
    attributed.usage.observe({ type: "usage", inputTokens: 7, outputTokens: 3 } as never)
    await settleObjectiveAttempt({
      attributed,
      outcome: { reason: "completed" },
      budgetMeter: undefined,
      verifier: undefined,
      judge: undefined,
      now: () => 2,
    })
    expect(authority.get("t")?.budget.tokensUsed).toBe(10)
  })

  test("a NEGATIVE meter delta (a meter reset mid-turn) is clamped to 0, never a credit", async () => {
    const scripted = meterOf([
      { inputTokens: 50, outputTokens: 50 },
      { inputTokens: 1, outputTokens: 1 },
    ])
    const { authority, attributed } = await armed(scripted.meter)
    await settleObjectiveAttempt({
      attributed,
      outcome: { reason: "completed" },
      budgetMeter: scripted.meter,
      verifier: undefined,
      judge: undefined,
      now: () => 2,
    })
    expect(authority.get("t")?.budget.tokensUsed).toBe(0)
  })

  test("a self-reported inflation cannot move the budget: 0 measured ⇒ 0 charged", async () => {
    const scripted = meterOf([{ inputTokens: 5, outputTokens: 5 }])
    const { authority, attributed } = await armed(scripted.meter)
    attributed.usage.observe({ type: "usage", inputTokens: 9_000, outputTokens: 9_000 } as never)
    await settleObjectiveAttempt({
      attributed,
      outcome: { reason: "completed" },
      budgetMeter: scripted.meter,
      verifier: undefined,
      judge: undefined,
      now: () => 2,
    })
    expect(authority.get("t")?.budget.tokensUsed).toBe(0)
  })
})
