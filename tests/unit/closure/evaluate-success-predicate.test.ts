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
  test("🔴 EXECUTION-ORACLE CONTROL: test_exit_zero still HARD-gates after the stdout demotion", () => {
    // The genuine execution oracle is the ONLY hard signal on the rail. This control
    // proves we demoted ONLY the prose-derived stdout predicates, NOT real execution:
    // a nonzero exit MUST stay evaluable:true + matched:false (a real hard RED).
    const red = evaluateSuccessPredicate(obs(1), { type: "test_exit_zero" })
    expect(red).toEqual({
      evaluable: true,
      matched: false,
      mismatchReason: expect.stringContaining("exit 1"),
    })
    // and exit 0 still hard-clears.
    expect(evaluateSuccessPredicate(obs(0), { type: "test_exit_zero" })).toEqual({
      evaluable: true,
      matched: true,
    })
  })
})

describe("evaluateSuccessPredicate — issue-prose stdout predicates are ADVISORY (no false-RED)", () => {
  // 🔴 RED-ON-INJECTION: `stdout_contains` / `stdout_exact_empty` are produced ONLY
  // by build.ts from `extractIssueDeclaredExpected` (a regex over issue PROSE). A
  // prose mis-extraction must NOT hard-veto a correct patch. So even when the
  // observed stdout does NOT contain the prose-extracted value, the result must be
  // ADVISORY (evaluable:false) — the rail degrades to the exit-code oracle, never a
  // hard matched:false. TEETH: reverting to a hard `matched(false, …)` makes this
  // assertion go RED (evaluable would become true).
  test("🔴 stdout_contains: stdout NOT containing the prose value ⇒ advisory, not a hard fail", () => {
    const r = evaluateSuccessPredicate(obs(0, "still wrong output"), {
      type: "stdout_contains",
      substring: "expected output",
    })
    expect(r.evaluable).toBe(false) // ← TEETH: hard-evaluable revert flips this to true
    // a correct patch (exit 0) is NOT marked failed on the rail by the prose regex.
    // (matched is meaningless when evaluable:false; the repair gate treats this as
    //  "not a false-green" so the exit-code green clears.)
  })
  test("🔴 stdout_exact_empty: non-empty stdout ⇒ advisory, not a hard fail", () => {
    const r = evaluateSuccessPredicate(obs(0, "duplicate found"), { type: "stdout_exact_empty" })
    expect(r.evaluable).toBe(false) // ← TEETH: hard-evaluable revert flips this to true
  })
  // Even a "matching" prose value stays advisory — the regex never gains rail
  // authority in either direction (it cannot hard-CLEAR a non-primary green either).
  test("stdout_contains: stdout DOES contain the prose value ⇒ still advisory", () => {
    expect(
      evaluateSuccessPredicate(obs(0, "... 3 PASSED ..."), {
        type: "stdout_contains",
        substring: "PASSED",
      }).evaluable,
    ).toBe(false)
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

  test("🔴 never-throws contract: malformed predicates ⇒ advisory, not throw", () => {
    // stdout_contains is advisory in v1 regardless of substring, so a malformed
    // one (missing substring) is also advisory — and must never throw.
    expect(() =>
      evaluateSuccessPredicate(obs(0, "x"), { type: "stdout_contains" } as unknown as SuccessPredicate),
    ).not.toThrow()
    expect(
      evaluateSuccessPredicate(obs(0, "x"), { type: "stdout_contains" } as unknown as SuccessPredicate)
        .evaluable,
    ).toBe(false)
    // null / non-object predicate ⇒ advisory, not throw.
    expect(() =>
      evaluateSuccessPredicate(obs(0), null as unknown as SuccessPredicate),
    ).not.toThrow()
    expect(evaluateSuccessPredicate(obs(0), undefined as unknown as SuccessPredicate).evaluable).toBe(
      false,
    )
  })
})
