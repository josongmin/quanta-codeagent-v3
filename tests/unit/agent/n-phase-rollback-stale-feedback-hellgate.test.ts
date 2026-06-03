/**
 * N-phase HITL rollback — stale-feedback gate hellgate (ADR-0243 follow-up).
 *
 * HELL-NP-16 — ROLLBACK MUST CLEAR THE SOURCE PHASE LEDGER ENTRY.
 *
 * Root-cause guard for the state-machine defect: the rollback branch used to
 * delete only the DESTINATION phase's ledger entry, leaving the phase we rolled
 * back FROM with a stale positive entry. When the cursor later advanced forward
 * back into that phase (a forward transition consumes the SOURCE entry, not the
 * target's), its `requiresFeedback` gate was silently satisfied by the stale
 * positive feedback — letting the caller skip the human-in-the-loop step.
 *
 * Exact adversarial sequence (F = the requiresFeedback phase "feedback"):
 *
 *   1. advance cursor up to F.
 *   2. feedback(F, positive)  → ledger[F] = positive.
 *   3. feedback(F, negative)  → ROLLBACK to F-1. The buggy code deleted only
 *                               ledger[F-1]; ledger[F] survived.
 *   4. advance F-1 → F        → forward transition consumes ledger[F-1], NOT
 *                               ledger[F].
 *   5. at F, transition(F+1)  → gate checks !ledger.has(F). With the stale
 *                               entry this WRONGLY succeeds; correct behavior
 *                               is TransitionError("feedback-required").
 *
 * This test asserts step 5 fails closed. It FAILS against the pre-fix code
 * (which only deleted the destination entry) — anti-theater verified.
 */

import { describe, expect, test } from "bun:test"

import { createDefaultNPhaseDriver, type PhaseSpec, TransitionError } from "../../../src/agent/n-phase"

const chain: ReadonlyArray<PhaseSpec> = [
  { id: "init", name: "Init", requiresFeedback: false, allowSkip: false },
  { id: "clarify", name: "Clarify", requiresFeedback: false, allowSkip: false },
  { id: "plan", name: "Plan", requiresFeedback: false, allowSkip: false },
  // F — the requiresFeedback phase we roll FROM, then re-enter.
  { id: "feedback", name: "Feedback", requiresFeedback: true, allowSkip: false },
  { id: "breakdown", name: "Breakdown", requiresFeedback: false, allowSkip: false },
]

describe("HELL-NP-16 — rollback clears the SOURCE phase ledger (no stale-feedback bypass)", () => {
  test("re-entering a rolled-from requiresFeedback phase demands FRESH feedback", () => {
    const driver = createDefaultNPhaseDriver(chain)

    // 1. Advance the cursor up to F ("feedback").
    driver.transition("clarify")
    driver.transition("plan")
    driver.transition("feedback")
    expect(driver.current().id).toBe("feedback")

    // 2. Record positive feedback on F → ledger[F] set.
    expect(driver.feedback({ phase: "feedback", positive: true })).toBeNull()

    // 3. Negative feedback on F → rollback to "plan" (F-1).
    const rb = driver.feedback({ phase: "feedback", positive: false })
    expect(rb?.direction).toBe("rollback")
    expect(rb?.from).toBe("feedback")
    expect(rb?.to).toBe("plan")
    expect(driver.current().id).toBe("plan")

    // 4. Advance forward back into F. The forward transition consumes the
    //    SOURCE (plan) entry — it does NOT touch ledger[feedback].
    const fwd = driver.transition("feedback")
    expect(fwd.direction).toBe("forward")
    expect(driver.current().id).toBe("feedback")

    // 5. The requiresFeedback gate on F MUST NOT be satisfied by the stale
    //    positive entry left over from step 2. Advancing must fail closed.
    let thrown: unknown
    try {
      driver.transition("breakdown")
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(TransitionError)
    expect((thrown as TransitionError).code).toBe("feedback-required")
    expect(driver.current().id).toBe("feedback")

    // Sanity: FRESH positive feedback re-opens the gate (the phase is not
    // permanently locked — only the stale shortcut is removed).
    expect(driver.feedback({ phase: "feedback", positive: true })).toBeNull()
    const after = driver.transition("breakdown")
    expect(after.direction).toBe("forward")
    expect(after.to).toBe("breakdown")
  })

  test("rollback still clears the DESTINATION phase entry (HELL-NP-09 invariant intact)", () => {
    // Regression fence: the original destination-clear behavior must survive
    // the source-clear addition. Roll FROM a non-feedback phase INTO the
    // requiresFeedback phase and confirm the destination demands fresh feedback.
    const driver = createDefaultNPhaseDriver(chain)
    driver.transition("clarify")
    driver.transition("plan")
    driver.transition("feedback")
    driver.feedback({ phase: "feedback", positive: true })
    driver.transition("breakdown")

    // Roll back breakdown → feedback. Destination (feedback) entry must clear.
    const r = driver.feedback({ phase: "breakdown", positive: false })
    expect(r?.to).toBe("feedback")
    expect(driver.current().id).toBe("feedback")

    let thrown: unknown
    try {
      driver.transition("breakdown")
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(TransitionError)
    expect((thrown as TransitionError).code).toBe("feedback-required")
  })
})
