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

const meterOf = (snapshots: { inputTokens: number; outputTokens: number }[]) => {
  let index = 0
  return {
    snapshot: () => snapshots[Math.min(index++, snapshots.length - 1)] as never,
    tick: () => undefined,
  } as never
}

const armed = async (meter: unknown) => {
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
  })
  if (attributed === undefined) throw new Error("attempt not begun")
  return { authority, attributed }
}

describe("GOAL-04 rail 13 — measured usage comes from the meter, not the model's frames", () => {
  test("meter delta 20 vs accumulator 10 ⇒ the settled attempt records 20", async () => {
    // snapshot() is called once at begin (5+5) and once at settle (20+10).
    const { authority, attributed } = await armed(
      meterOf([
        { inputTokens: 5, outputTokens: 5 },
        { inputTokens: 20, outputTokens: 10 },
      ]),
    )
    // The model's own frames claim only 10 tokens.
    attributed.usage.observe({ type: "usage", inputTokens: 7, outputTokens: 3 } as never)
    await settleObjectiveAttempt({
      attributed,
      outcome: { reason: "completed" },
      budgetMeter: meterOf([{ inputTokens: 20, outputTokens: 10 }]) as never,
      verifier: undefined,
      judge: undefined,
      now: () => 2,
    })
    expect(authority.get("t")?.budget.tokensUsed).toBe(20)
  })

  test("a self-reported inflation cannot move the budget: 0 measured ⇒ 0 charged", async () => {
    const { authority, attributed } = await armed(meterOf([{ inputTokens: 5, outputTokens: 5 }]))
    attributed.usage.observe({ type: "usage", inputTokens: 9_000, outputTokens: 9_000 } as never)
    await settleObjectiveAttempt({
      attributed,
      outcome: { reason: "completed" },
      budgetMeter: meterOf([{ inputTokens: 5, outputTokens: 5 }]) as never,
      verifier: undefined,
      judge: undefined,
      now: () => 2,
    })
    expect(authority.get("t")?.budget.tokensUsed).toBe(0)
  })
})
