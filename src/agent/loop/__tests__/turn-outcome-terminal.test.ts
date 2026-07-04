/**
 * FIX 2a (HELLGATE) — terminal-classification precedence.
 *
 * `resolveTurnLoopOutcome` checked `budgetMeter.checkExhausted()` BEFORE the
 * `completed` branch, so a cleanly-completed FINAL turn that also happened to
 * cross budget was reported `budget_exhausted` instead of `completed`. The
 * natural terminal outcome (completed/refusal) must WIN; meter-exhaustion is
 * only terminal when the turn is about to CONTINUE (kind === "tools").
 */

import { describe, expect, test } from "bun:test"
import type { Message } from "@/llm"
import type { WorkingMemory } from "@/memory"
import type { AgentConfig } from "../../types"
import { resolveTurnLoopOutcome } from "../turn-outcome"
import type { TurnResult } from "../types"

const nullStream = { emit: () => {} } as unknown as AgentConfig["stream"]

/** A budget meter that reports exhausted (only `checkExhausted` is exercised
 *  by this resolver path). */
const exhaustedMeter = () =>
  ({
    checkExhausted: () => ({ exhausted: true, kind: "turns", budget: 5, observed: 6 }),
  }) as unknown as NonNullable<AgentConfig["budgetMeter"]>

const collectingWm = () => {
  const appended: Message[] = []
  return {
    wm: { append: (m: Message) => appended.push(m) } as unknown as WorkingMemory<Message>,
    appended,
  }
}

const baseArgs = (over: { cfg: AgentConfig; wm: WorkingMemory<Message>; result: TurnResult }) => ({
  cfg: over.cfg,
  stream: nullStream,
  wm: over.wm,
  breaker: undefined,
  recorder: undefined,
  turn: 3,
  result: over.result,
  pendingPlanExitRef: { current: null },
  pendingPlanEntryRef: { current: null },
  hookPromptPending: [],
})

describe("resolveTurnLoopOutcome — terminal precedence over post-turn budget", () => {
  test("2a: completed turn WINS over meter exhaustion (reason=completed)", async () => {
    const { wm } = collectingWm()
    const cfg = {
      budgetMeter: exhaustedMeter(),
      decisionEmitter: undefined,
    } as unknown as AgentConfig
    const res = await resolveTurnLoopOutcome(
      baseArgs({ cfg, wm, result: { kind: "completed" } as TurnResult }),
    )
    expect(res.kind).toBe("finish")
    if (res.kind === "finish") {
      expect(res.reason).toBe("completed")
      expect(res.stopCategory?.kind).toBe("completed")
    }
  })

  test("2a regression: tools turn + exhausted meter ⇒ budget_exhausted (still terminal)", async () => {
    const { wm, appended } = collectingWm()
    const cfg = {
      budgetMeter: exhaustedMeter(),
      decisionEmitter: undefined,
    } as unknown as AgentConfig
    const result = {
      kind: "tools",
      message: { role: "assistant", content: [] },
      resultBlocks: [{ type: "text", text: "tr" }],
    } as unknown as TurnResult
    const res = await resolveTurnLoopOutcome(baseArgs({ cfg, wm, result }))
    expect(res.kind).toBe("finish")
    if (res.kind === "finish") expect(res.reason).toBe("budget_exhausted")
    // appendPendingToolResults must still fire for the tools+exhausted case
    expect(appended.length).toBe(1)
  })

  test("2a: completed turn with NO meter ⇒ completed (unchanged)", async () => {
    const { wm } = collectingWm()
    const cfg = { budgetMeter: undefined, decisionEmitter: undefined } as unknown as AgentConfig
    const res = await resolveTurnLoopOutcome(
      baseArgs({ cfg, wm, result: { kind: "completed" } as TurnResult }),
    )
    expect(res.kind).toBe("finish")
    if (res.kind === "finish") expect(res.reason).toBe("completed")
  })

  test("2a: refusal already wins (guard — refusal precedes the meter check)", async () => {
    const { wm } = collectingWm()
    const cfg = {
      budgetMeter: exhaustedMeter(),
      decisionEmitter: undefined,
    } as unknown as AgentConfig
    const result = {
      kind: "refusal",
      rationale: "no",
      message: { role: "assistant", content: [] },
    } as unknown as TurnResult
    const res = await resolveTurnLoopOutcome(baseArgs({ cfg, wm, result }))
    expect(res.kind).toBe("finish")
    if (res.kind === "finish") expect(res.reason).toBe("refusal")
  })
})
