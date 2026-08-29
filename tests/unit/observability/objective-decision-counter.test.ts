/**
 * ★ HELLGATE (P1-4, first slice) — a settled goal attempt is COUNTED.
 *
 * GOAL-10 asked for bounded decision counters and a label allowlist. The audit
 * found the rail already half-built and unused: `kind: "objective"` is a
 * reserved member of the closed decision taxonomy (`src/stream/types.ts`,
 * `decision-counter-sink.ts`) with a hellgate that already pins the cardinality
 * invariant — and ZERO producers. This fills that arm from the settlement seam
 * rather than inventing a second counter system.
 *
 * Scope, deliberately: the TURN-SCOPED half. A `decision` carries a turn and an
 * allow/deny/ask outcome, which fits "an attributed attempt settled". Wake
 * decisions (armed / skipped(reason)) happen outside any turn and do NOT fit;
 * they need their own instrument and are left to a written decision rather than
 * bent into this shape.
 */

import { describe, expect, test } from "bun:test"
import { emitObjectiveSettlementDecision } from "@/agent/objective-decision"
import type { ObjectiveSettlementNotice } from "@/host/runtime"

const notice = (over: Partial<ObjectiveSettlementNotice> = {}): ObjectiveSettlementNotice => ({
  threadId: "thread-1",
  objectiveId: "objective-9",
  attemptId: "attempt-secret",
  provenance: "autonomous-continuation",
  turnOutcome: "completed",
  tokensUsed: 42,
  objectiveRevision: 7,
  receiptCount: 3,
  remainingCriterionIds: [],
  ...over,
})

const capture = () => {
  const events: Record<string, unknown>[] = []
  return { emitter: { emit: (e: unknown) => events.push(e as Record<string, unknown>) }, events }
}

describe("P1-4 — objective settlement fills the reserved decision arm", () => {
  test("a completed attempt counts as an ALLOW on the objective kind", () => {
    const { emitter, events } = capture()
    emitObjectiveSettlementDecision(emitter, notice(), 3)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "decision",
      kind: "objective",
      outcome: "allow",
      turn: 3,
    })
  })

  test.each([
    ["error", "deny"],
    ["budget_limited", "deny"],
    ["blocked", "deny"],
    ["aborted", "deny"],
  ] as const)("a %s settlement counts as %s", (turnOutcome, outcome) => {
    const { emitter, events } = capture()
    emitObjectiveSettlementDecision(emitter, notice({ turnOutcome } as never), 1)
    expect(events[0]).toMatchObject({ kind: "objective", outcome })
  })

  test("an approval PAUSE is an `ask`, not a failure", () => {
    const { emitter, events } = capture()
    emitObjectiveSettlementDecision(emitter, notice({ turnOutcome: "awaiting_approval" }), 2)
    expect(events[0]).toMatchObject({ kind: "objective", outcome: "ask" })
  })

  test("the reason names the outcome and the provenance — and NOTHING identifying", () => {
    const { emitter, events } = capture()
    emitObjectiveSettlementDecision(emitter, notice(), 1)
    const event = events[0] as { reason: string; metadata?: unknown; toolCallId?: unknown }
    expect(event.reason).toContain("completed")
    expect(event.reason).toContain("autonomous")
    // The counter sink labels on {kind, outcome} only, but the EVENT must not
    // carry identifiers either: a jsonl recorder writes it verbatim.
    const serialized = JSON.stringify(events[0])
    expect(serialized).not.toContain("attempt-secret")
    expect(serialized).not.toContain("objective-9")
    expect(serialized).not.toContain("thread-1")
    expect(event.toolCallId).toBeUndefined()
    expect(event.metadata).toBeUndefined()
  })

  test("no emitter wired ⇒ silent (byte-identical)", () => {
    expect(() => emitObjectiveSettlementDecision(undefined, notice(), 1)).not.toThrow()
  })

  test("a throwing emitter never escapes (observability is not authority)", () => {
    const emitter = {
      emit: () => {
        throw new Error("sink exploded")
      },
    }
    expect(() => emitObjectiveSettlementDecision(emitter, notice(), 1)).not.toThrow()
  })
})
