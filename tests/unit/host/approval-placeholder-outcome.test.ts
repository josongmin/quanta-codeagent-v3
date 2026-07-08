import { describe, expect, test } from "bun:test"
import { lastTurnOutcomeFromAgentOutcome } from "../../../src/reactor/agent-outcome-adapter"
import { approvalPlaceholderOutcome } from "../../../src/host/runtime/internal/context-binding/approval-support"

/**
 * ALBB-18 (5) — a turn paused awaiting HITL approval must NOT report the
 * terminal user-cancelled reason `"aborted"`. It returns alongside an
 * `approvalRequest` (turn-runner.ts) and matches scheduler status
 * `"awaiting_approval"`, so `outcome.reason` must carry the dedicated pause
 * reason so a consumer can tell "paused, resume pending" from "cancelled".
 */
describe("ALBB-18 — approvalPlaceholderOutcome pause reason", () => {
  test("reports the dedicated pause reason, NOT aborted", () => {
    const out = approvalPlaceholderOutcome([])
    expect(out.reason).toBe("awaiting_approval")
    expect(out.reason).not.toBe("aborted")
  })

  test("SSOT classifier maps the pause reason to partial (resumable, not fail)", () => {
    const out = approvalPlaceholderOutcome([])
    expect(lastTurnOutcomeFromAgentOutcome(out)).toBe("partial")
  })
})
