/**
 * Compile-time + runtime teeth for the answer-key blindness fence in
 * `verificationTargetFromPlan` (src/runner/batch/eval/llm-evidence-packet.ts).
 *
 * Context: `toStep` previously typed its parameter with an INLINE structural
 * type whose `kind: string` WIDENED the closed `VerificationStepKind` union
 * ("repro" | "owner-test" | "module-smoke"). That widening silently disarmed
 * the exhaustiveness of the `kind === "repro"` cmd-surfacing decision — adding a
 * 4th step kind would NOT have been flagged, and a new kind could have leaked
 * its (potentially hidden-test-bearing) cmd by default.
 *
 * This file pins two guards:
 *  1. COMPILE-TIME: an exhaustive switch over `VerificationStepKind` that
 *     classifies each kind as "surfaces cmd" vs "withholds cmd". If a 4th kind
 *     is ever added, the `assertNever` default makes this file fail to typecheck
 *     — forcing a human to decide the new kind's blindness BEFORE it can leak.
 *  2. RUNTIME: the classifier here must agree with the real
 *     `verificationTargetFromPlan` behavior (repro surfaces, others withhold),
 *     so the compile-time table cannot drift away from the live fence.
 *
 * Note: this file does NOT touch the sweep-hot llm-evidence-packet.test.ts.
 */
import { describe, expect, test } from "bun:test"
import type { VerificationStepKind } from "@/agent/verification-plan"
import { verificationTargetFromPlan } from "@/runner/batch/eval/llm-evidence-packet"

const assertNever = (x: never): never => {
  throw new Error(`unhandled VerificationStepKind: ${String(x)}`)
}

/**
 * EXHAUSTIVE over the closed union. Adding a 4th kind to VerificationStepKind
 * without handling it here is a COMPILE ERROR (the assertNever default), which
 * is exactly the exhaustiveness the type-tightening restored.
 */
const surfacesCmd = (kind: VerificationStepKind): boolean => {
  switch (kind) {
    case "repro":
      // Blind-by-construction synthesized sandbox script — safe to surface.
      return true
    case "owner-test":
    case "module-smoke":
      // Can encode a path to a hidden test — WITHHELD.
      return false
    default:
      return assertNever(kind)
  }
}

describe("verificationTargetFromPlan — step-kind blindness is exhaustive", () => {
  const allKinds: readonly VerificationStepKind[] = ["repro", "owner-test", "module-smoke"]

  test("only repro surfaces its cmd; runtime fence matches the exhaustive classifier", () => {
    for (const kind of allKinds) {
      const plan = {
        primaryRail: null,
        required: [
          {
            kind,
            cmd: `CMD_FOR_${kind}_secret_path`,
            authority: "execution" as const,
            successPredicate: { type: "test_exit_zero" as const },
          },
        ],
        optional: [],
        baseValidatedRed: false,
      }
      const target = verificationTargetFromPlan(plan)
      const step = target?.required[0]
      expect(step?.kind).toBe(kind)
      if (surfacesCmd(kind)) {
        expect(step?.cmd).toBe(`CMD_FOR_${kind}_secret_path`)
        expect(step?.cmdWithheld).toBeUndefined()
      } else {
        expect(step?.cmd).toBeUndefined()
        expect(step?.cmdWithheld).toBe(true)
        // The path-bearing cmd must never appear in the serialized target.
        expect(JSON.stringify(target)).not.toContain(`CMD_FOR_${kind}_secret_path`)
      }
    }
  })

  test("exactly one of the closed kinds surfaces its cmd (repro)", () => {
    const surfacing = allKinds.filter(surfacesCmd)
    expect(surfacing).toEqual(["repro"])
  })
})
