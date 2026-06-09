import { describe, expect, it } from "vitest"
import { shouldContinueAfterApproval } from "./session-hooks"

/**
 * ADR-0512 P3 (jun-9 100-point) — the web must RE-RUN the suspended turn after
 * resolving an approval, because the kernel does NOT auto-continue: a resolved
 * approval only mints/clears a lease; a fresh `turn.run` is what claims it and
 * re-dispatches. Without this, "Approve" sets the grant but the tool never runs.
 *
 *   - approve (normal OR escalation) ⇒ continue (dispatch the approved tool).
 *   - escalation deny ⇒ continue (the loop produces the RECOVERABLE
 *     `skill-scoped: declined`/`steered` tool_result so the model can recover).
 *   - normal deny ⇒ do NOT continue (the turn aborts; re-running would re-ask
 *     the same approval forever).
 */
describe("shouldContinueAfterApproval", () => {
  it("approve continues (normal + escalation)", () => {
    expect(shouldContinueAfterApproval("approve", false)).toBe(true)
    expect(shouldContinueAfterApproval("approve", true)).toBe(true)
  })

  it("escalation deny continues (recoverable decline)", () => {
    expect(shouldContinueAfterApproval("deny", true)).toBe(true)
  })

  it("normal deny does NOT continue (abort — avoids a re-ask loop)", () => {
    expect(shouldContinueAfterApproval("deny", false)).toBe(false)
  })
})
