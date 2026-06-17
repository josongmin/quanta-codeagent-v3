import { describe, expect, test } from "bun:test"
import { evaluateSuccessPredicate } from "@/agent/closure"
import type { ExecObservation, SuccessPredicate } from "@/agent/closure"

/**
 * T-1 — SuccessPredicate evaluator (core, pure).
 *
 * Load-bearing properties:
 *  - execution-grounded predicates are confidently judged from exit/stdout.
 *  - exit 0 + content mismatch ⇒ matched:false (a NON-primary green can't clear).
 *  - 🔴 FAIL-OPEN: issue-derived exact-string/symbolic/structural predicates are
 *    advisory (evaluable:false) in v1 — they must NEVER hard-fail a correct patch.
 *  - unknown discriminant ⇒ evaluable:false, never throws.
 */
const obs = (exitCode: number, stdout = "", stderr = ""): ExecObservation => ({
  exitCode,
  stdout,
  stderr,
})

describe("evaluateSuccessPredicate — execution-grounded", () => {
  test("test_exit_zero: exit 0 ⇒ matched", () => {
    expect(evaluateSuccessPredicate(obs(0), { type: "test_exit_zero" })).toEqual({
      evaluable: true,
      matched: true,
    })
  })
  test("test_exit_zero: exit 1 ⇒ not matched", () => {
    const r = evaluateSuccessPredicate(obs(1), { type: "test_exit_zero" })
    expect(r.evaluable).toBe(true)
    expect(r.matched).toBe(false)
  })
  test("selected_test_passes: exit 0 ⇒ matched", () => {
    expect(
      evaluateSuccessPredicate(obs(0), { type: "selected_test_passes" }).matched,
    ).toBe(true)
  })
  test("stdout_contains: present ⇒ matched, absent ⇒ not", () => {
    const p: SuccessPredicate = { type: "stdout_contains", substring: "PASSED" }
    expect(evaluateSuccessPredicate(obs(0, "... 3 PASSED ..."), p).matched).toBe(true)
    expect(evaluateSuccessPredicate(obs(0, "... 3 FAILED ..."), p).matched).toBe(false)
  })
  test("stdout_exact_empty: empty/whitespace ⇒ matched, content ⇒ not", () => {
    expect(evaluateSuccessPredicate(obs(0, "   \n "), { type: "stdout_exact_empty" }).matched).toBe(
      true,
    )
    expect(
      evaluateSuccessPredicate(obs(0, "duplicate found"), { type: "stdout_exact_empty" }).matched,
    ).toBe(false)
  })

  test("🔴 exit 0 but stdout mismatch ⇒ matched:false (non-primary green can't clear)", () => {
    // red-on-injection: an evaluator that only looked at exitCode would say matched.
    const r = evaluateSuccessPredicate(obs(0, "still wrong output"), {
      type: "stdout_contains",
      substring: "expected output",
    })
    expect(r).toEqual({
      evaluable: true,
      matched: false,
      mismatchReason: expect.stringContaining("stdout missing substring"),
    })
  })
})

describe("evaluateSuccessPredicate — FAIL-OPEN (advisory in v1)", () => {
  test("latex_or_string_exact ⇒ evaluable:false (advisory, never hard-fail)", () => {
    const r = evaluateSuccessPredicate(obs(1, "anything"), {
      type: "latex_or_string_exact",
      expected: "\\left(x\\right)",
    })
    expect(r.evaluable).toBe(false)
    expect(r.matched).toBe(false)
  })
  test("symbolic_repr_equals ⇒ evaluable:false", () => {
    expect(
      evaluateSuccessPredicate(obs(0), { type: "symbolic_repr_equals", expectedRepr: "(1,)" })
        .evaluable,
    ).toBe(false)
  })
  test("ast_or_dom_shape / stderr_absent ⇒ evaluable:false", () => {
    expect(evaluateSuccessPredicate(obs(0), { type: "ast_or_dom_shape", shape: "x" }).evaluable).toBe(
      false,
    )
    expect(evaluateSuccessPredicate(obs(0), { type: "stderr_absent" }).evaluable).toBe(false)
  })
  test("unknown discriminant ⇒ evaluable:false, no throw", () => {
    const r = evaluateSuccessPredicate(obs(0), { type: "totally_bogus" } as unknown as SuccessPredicate)
    expect(r.evaluable).toBe(false)
  })
})
