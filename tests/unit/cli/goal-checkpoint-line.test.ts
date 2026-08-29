/**
 * GOAL-05A rail 16 — the settled-turn line an operator actually sees, and the
 * discipline it must keep: bounded and TEXT-FREE (no goal text, no criterion
 * text, no prompt, no attempt key), so an always-on announcement can never
 * become a leak channel.
 */

import { describe, expect, test } from "bun:test"
import {
  buildGoalCheckpointSink,
  renderGoalCheckpointLine,
} from "@/apps/cli/repl/goal-checkpoint-line"
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
  remainingCriterionIds: ["c1", "c2"],
  ...over,
})

describe("GOAL-05A rail 16 — the checkpoint line", () => {
  test("says outcome, spend, what is left, and where the objective stands", () => {
    expect(renderGoalCheckpointLine(notice())).toBe(
      "goal: completed · 42 tok · 2 remaining · rev 7 · 3 receipts\n",
    )
  })

  test("a finished contract reads as finished, not as `0 remaining`", () => {
    expect(renderGoalCheckpointLine(notice({ remainingCriterionIds: [] }))).toContain(
      "no criteria remaining",
    )
  })

  test("user-requested work is labelled as such (it never touches the autonomous cap)", () => {
    expect(
      renderGoalCheckpointLine(notice({ provenance: "user-requested-goal-work" })),
    ).toStartWith("goal work: ")
  })

  test("TEXT-FREE: no identifier or free text leaks into the line", () => {
    const line = renderGoalCheckpointLine(
      notice({ turnOutcome: "awaiting_approval", tokensUsed: 0 }),
    )
    expect(line).not.toContain("attempt-secret")
    expect(line).not.toContain("objective-9")
    expect(line).not.toContain("thread-1")
    expect(line).not.toContain("c1")
    expect(line).toContain("awaiting_approval")
  })

  test("the sink writes exactly one line per settlement, through the injected writer", () => {
    const written: string[] = []
    const sink = buildGoalCheckpointSink((line) => written.push(line))
    sink(notice())
    sink(notice({ turnOutcome: "error" }))
    expect(written).toHaveLength(2)
    expect(written[1]).toContain("error")
    expect(written.every((line) => line.endsWith("\n"))).toBe(true)
  })
})
