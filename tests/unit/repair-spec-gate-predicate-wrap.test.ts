/**
 * Repair spec-gate — predicate wrapper (jun-26 oracle-hardening).
 *
 * `buildSpecGateEvaluatePredicate(base, issueDeclaredExpected)` returns a drop-in
 * `evaluatePredicate` for the repair validator that LAYERS the public
 * issue-declared expected-output obligation on top of the base
 * `evaluateSuccessPredicate`. When the declared expected can be judged from the
 * observation it DOMINATES; otherwise it falls back to the base result
 * (byte-identical to today). Pure.
 */

import { describe, expect, test } from "bun:test"
import { evaluateSuccessPredicate, type SuccessPredicate } from "@/agent/closure"
import { type IssueDeclaredExpected, PUBLIC_ISSUE_TEXT_PROVENANCE } from "@/agent/verification-plan"
import {
  buildSpecGateEvaluatePredicate,
  resolveRepairEvaluatePredicate,
} from "@/runner/batch/eval/declared-expected-matcher"

const declared = (value: string): IssueDeclaredExpected => ({
  kind: "stdout",
  value,
  provenance: PUBLIC_ISSUE_TEXT_PROVENANCE,
})

const EXIT_ZERO: SuccessPredicate = { type: "test_exit_zero" }

describe("buildSpecGateEvaluatePredicate", () => {
  test("green run, declared expected ABSENT ⇒ {evaluable:true, matched:false} (false-green caught)", () => {
    const evalP = buildSpecGateEvaluatePredicate(
      evaluateSuccessPredicate,
      declared("TypeError: cannot convert"),
    )
    const v = evalP({ exitCode: 0, stdout: "1 passed", stderr: "" }, EXIT_ZERO)
    expect(v.evaluable).toBe(true)
    expect(v.matched).toBe(false)
  })

  test("green run, declared expected PRESENT ⇒ matched:true (clears, no false-positive)", () => {
    const evalP = buildSpecGateEvaluatePredicate(
      evaluateSuccessPredicate,
      declared("TypeError: cannot convert"),
    )
    const v = evalP(
      { exitCode: 0, stdout: "E   TypeError: cannot convert\n1 passed", stderr: "" },
      EXIT_ZERO,
    )
    expect(v).toEqual({ evaluable: true, matched: true })
  })

  test("declared expected ABSTAINS (stdout-empty kind) ⇒ falls back to BASE predicate (byte-identical)", () => {
    const empty: IssueDeclaredExpected = {
      kind: "stdout-empty",
      value: "issue declares the correct output is empty",
      provenance: PUBLIC_ISSUE_TEXT_PROVENANCE,
    }
    const evalP = buildSpecGateEvaluatePredicate(evaluateSuccessPredicate, empty)
    const observed = { exitCode: 0, stdout: "1 passed", stderr: "" }
    // base test_exit_zero on exit 0 ⇒ matched:true; the abstaining gate must not change it.
    expect(evalP(observed, EXIT_ZERO)).toEqual(evaluateSuccessPredicate(observed, EXIT_ZERO))
  })

  test("no declared expected ⇒ identical to base evaluator (byte-identical)", () => {
    const evalP = buildSpecGateEvaluatePredicate(evaluateSuccessPredicate, undefined)
    const observed = { exitCode: 0, stdout: "x", stderr: "" }
    expect(evalP(observed, EXIT_ZERO)).toEqual(evaluateSuccessPredicate(observed, EXIT_ZERO))
    const red = { exitCode: 1, stdout: "", stderr: "boom" }
    expect(evalP(red, EXIT_ZERO)).toEqual(evaluateSuccessPredicate(red, EXIT_ZERO))
  })

  test("base predicate already a false-green ⇒ preserved (gate never weakens an existing mismatch)", () => {
    // If the base typed predicate already reports an evaluable mismatch, a
    // declared-expected MATCH must NOT overturn it into a clear.
    const base = (): { evaluable: true; matched: false } => ({ evaluable: true, matched: false })
    const evalP = buildSpecGateEvaluatePredicate(base, declared("present-literal"))
    const v = evalP({ exitCode: 0, stdout: "present-literal here", stderr: "" }, EXIT_ZERO)
    expect(v.matched).toBe(false)
  })

  test("red run (exit!=0) under test_exit_zero ⇒ base evaluable mismatch is preserved (gate never overturns)", () => {
    // With test_exit_zero the base predicate is itself an evaluable mismatch on a
    // non-zero exit; the spec gate must NOT overturn that into a clear even though
    // the declared literal happens to appear in the (red) output.
    const evalP = buildSpecGateEvaluatePredicate(
      evaluateSuccessPredicate,
      declared("present-literal"),
    )
    const observed = { exitCode: 1, stdout: "present-literal", stderr: "" }
    expect(evalP(observed, EXIT_ZERO)).toEqual(evaluateSuccessPredicate(observed, EXIT_ZERO))
  })
})

// ---- THE WIRING GUARD (jun-28 inert-#2 regression class) -------------------
// `buildSpecGateEvaluatePredicate` above was CORRECT yet INERT for a full session
// because both drivers passed the RAW evaluator to `runRepairRounds` — the wrapper
// was never composed. The wrapper test alone passes in that broken state. These
// tests pin the SINGLE seam both drivers now build through (`resolveRepairEvaluate
// Predicate`), so "knob on ⇒ composed; off ⇒ raw" cannot silently regress.
describe("resolveRepairEvaluatePredicate — driver seam (inert-#2 guard)", () => {
  test("both gate knobs OFF ⇒ the RAW base (byte-identical; the OFF default must be raw, not a silent gap)", () => {
    expect(
      resolveRepairEvaluatePredicate({}, declared("TypeError: x"), evaluateSuccessPredicate),
    ).toBe(evaluateSuccessPredicate)
  })

  test("repair-spec-gate ON + declared-expected PRESENT ⇒ a COMPOSED gate that CATCHES a false-green", () => {
    const evalP = resolveRepairEvaluatePredicate(
      { repairSpecGate: true },
      declared("TypeError: cannot convert"),
      evaluateSuccessPredicate,
    )
    expect(evalP).not.toBe(evaluateSuccessPredicate) // composed, NOT raw (the inert state)
    // exit-0 round whose output LACKS the declared expected ⇒ false green caught.
    const v = evalP({ exitCode: 0, stdout: "1 passed", stderr: "" }, EXIT_ZERO)
    expect(v.evaluable).toBe(true)
    expect(v.matched).toBe(false)
  })

  test("repair-strong-oracle ON + declared-expected ⇒ composed (same seam, either knob arms it)", () => {
    expect(
      resolveRepairEvaluatePredicate(
        { repairStrongOracle: true },
        declared("x"),
        evaluateSuccessPredicate,
      ),
    ).not.toBe(evaluateSuccessPredicate)
  })

  test("knob ON but NO declared-expected ⇒ RAW (fail-open; never penalize a correct patch on a spec-less issue)", () => {
    expect(
      resolveRepairEvaluatePredicate({ repairSpecGate: true }, undefined, evaluateSuccessPredicate),
    ).toBe(evaluateSuccessPredicate)
  })
})
