import { describe, expect, test } from "bun:test"
import type { AgentOutcome, StopReason } from "../../../src/agent"
import { lastTurnOutcomeFromAgentOutcome } from "../../../src/reactor/agent-outcome-adapter"

/**
 * ALBB-18 — SSOT classifier `lastTurnOutcomeFromAgentOutcome` is the ONE place
 * that projects an `AgentOutcome.reason` (closed `StopReason` union) onto the
 * reactor's coarse `LastTurnOutcome`. The `session-loop` abort branch now
 * delegates to this SSOT rather than hardcoding `"fail"`, so these mappings ARE
 * the abort-branch contract.
 *
 * The `switch` is total over `StopReason` (no `default`), so adding a reason
 * without classifying it is a compile error — this test pins the CHOSEN mapping
 * per reason (a compile-assert alone would not prove `aborted → "partial"`).
 */
const outcome = (reason: StopReason): AgentOutcome => ({ reason, turns: 0, messages: [] })

describe("ALBB-18 — agent-outcome-adapter SSOT classifier", () => {
  test("aborted → partial (abort-branch SSOT, NOT fail)", () => {
    // Mutating session-loop's abort branch back to `"fail"` diverges from THIS.
    expect(lastTurnOutcomeFromAgentOutcome(outcome("aborted"))).toBe("partial")
  })

  test("awaiting_approval (paused) → partial (not fail, not success)", () => {
    // The new pause reason: a turn paused for HITL approval is incomplete but
    // NOT a failure — it is resumable, so it classifies to "partial".
    expect(lastTurnOutcomeFromAgentOutcome(outcome("awaiting_approval"))).toBe("partial")
  })

  test("terminal-failure reasons stay fail", () => {
    expect(lastTurnOutcomeFromAgentOutcome(outcome("error"))).toBe("fail")
    expect(lastTurnOutcomeFromAgentOutcome(outcome("refusal"))).toBe("fail")
  })

  test("completed → success; max_turns/budget_exhausted → partial", () => {
    expect(lastTurnOutcomeFromAgentOutcome(outcome("completed"))).toBe("success")
    expect(lastTurnOutcomeFromAgentOutcome(outcome("max_turns"))).toBe("partial")
    expect(lastTurnOutcomeFromAgentOutcome(outcome("budget_exhausted"))).toBe("partial")
  })
})
