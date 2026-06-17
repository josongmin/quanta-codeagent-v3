/**
 * T-301 — VerificationPlan builder. Teeth: red-on-injection gate (a non-validated
 * repro is NEVER primaryRail/required), public-evidence fallback, required cap 3,
 * determinism.
 */
import { describe, expect, test } from "bun:test"
import { buildVerificationPlan } from "@/agent/verification-plan/build"

describe("buildVerificationPlan", () => {
  test("RED-validated repro becomes primaryRail + required", () => {
    const p = buildVerificationPlan({
      reproScript: { cmd: "python reproduce_issue.py", baseValidatedRed: true },
      ownerNearTests: ["pytest tests/owner_test.py"],
    })
    expect(p.primaryRail?.kind).toBe("repro")
    expect(p.primaryRail?.cmd).toBe("python reproduce_issue.py")
    expect(p.required[0]).toEqual(p.primaryRail)
    expect(p.baseValidatedRed).toBe(true)
  })

  test("repro NOT validated red is demoted to optional, never primaryRail/required", () => {
    const p = buildVerificationPlan({
      reproScript: { cmd: "python reproduce_issue.py", baseValidatedRed: false },
      ownerNearTests: ["pytest tests/owner_test.py"],
    })
    expect(p.primaryRail?.kind).toBe("owner-test")
    expect(p.primaryRail?.cmd).toBe("pytest tests/owner_test.py")
    expect(p.required.some((s) => s.kind === "repro")).toBe(false)
    expect(p.optional.some((s) => s.kind === "repro")).toBe(true)
  })

  test("no repro → primary from owner-near test (public evidence)", () => {
    const p = buildVerificationPlan({ ownerNearTests: ["pytest a.py", "pytest b.py"] })
    expect(p.primaryRail?.kind).toBe("owner-test")
    expect(p.primaryRail?.cmd).toBe("pytest a.py")
  })

  test("required hard-capped at 3, overflow → optional", () => {
    const p = buildVerificationPlan({
      ownerNearTests: ["a", "b", "c", "d", "e"].map((x) => `pytest ${x}`),
    })
    expect(p.required.length).toBe(3)
    expect(p.optional.length).toBeGreaterThanOrEqual(2)
  })

  test("module smoke is fallback primary + otherwise optional", () => {
    const p = buildVerificationPlan({ touchedModuleSmoke: ["pytest mod_smoke.py"] })
    expect(p.primaryRail?.kind).toBe("module-smoke")
    expect(p.primaryRail?.cmd).toBe("pytest mod_smoke.py")
  })

  test("no evidence → primaryRail null (repair stays off)", () => {
    const p = buildVerificationPlan({})
    expect(p.primaryRail).toBeNull()
    expect(p.required).toEqual([])
  })

  test("deterministic", () => {
    const i = { reproScript: { cmd: "r", baseValidatedRed: true }, ownerNearTests: ["a", "b"] }
    expect(buildVerificationPlan(i)).toEqual(buildVerificationPlan(i))
  })

  const VALID_PREDICATE_KINDS = new Set([
    "stdout_exact_empty",
    "stdout_contains",
    "stderr_absent",
    "symbolic_repr_equals",
    "ast_or_dom_shape",
    "latex_or_string_exact",
    "test_exit_zero",
    "selected_test_passes",
  ])

  test("every required step carries a typed successPredicate + authority", () => {
    const p = buildVerificationPlan({
      reproScript: { cmd: "python reproduce_issue.py", baseValidatedRed: true },
      ownerNearTests: ["pytest a.py", "pytest b.py"],
    })
    expect(p.required.length).toBeGreaterThan(0)
    for (const step of p.required) {
      expect(step.successPredicate).toBeDefined()
      expect(VALID_PREDICATE_KINDS.has(step.successPredicate?.type ?? "")).toBe(true)
      expect(["execution", "structure", "exact-diff"]).toContain(step.authority)
    }
  })

  test("repro primary defaults to selected_test_passes; owner-test → test_exit_zero", () => {
    const p = buildVerificationPlan({
      reproScript: { cmd: "python reproduce_issue.py", baseValidatedRed: true },
      ownerNearTests: ["pytest owner.py"],
    })
    expect(p.primaryRail?.successPredicate?.type).toBe("selected_test_passes")
    const owner = p.required.find((s) => s.kind === "owner-test")
    expect(owner?.successPredicate?.type).toBe("test_exit_zero")
    expect(owner?.authority).toBe("execution")
  })

  test("issueDeclaredExpected (latex) ⇒ primary carries latex_or_string_exact w/ payload", () => {
    const p = buildVerificationPlan({
      ownerNearTests: ["pytest owner.py"],
      issueDeclaredExpected: { value: "\\frac{1}{2}", kind: "latex" },
    })
    const pred = p.primaryRail?.successPredicate
    expect(pred?.type).toBe("latex_or_string_exact")
    expect(pred).toEqual({ type: "latex_or_string_exact", expected: "\\frac{1}{2}" })
    expect(p.primaryRail?.authority).toBe("exact-diff")
    // and required[0] is the same annotated step
    expect(p.required[0]?.successPredicate?.type).toBe("latex_or_string_exact")
  })

  test("issueDeclaredExpected (symbolic) ⇒ symbolic_repr_equals w/ payload, structure authority", () => {
    const p = buildVerificationPlan({
      ownerNearTests: ["pytest owner.py"],
      issueDeclaredExpected: { value: "Integral(x, x)", kind: "symbolic" },
    })
    expect(p.primaryRail?.successPredicate).toEqual({
      type: "symbolic_repr_equals",
      expectedRepr: "Integral(x, x)",
    })
    expect(p.primaryRail?.authority).toBe("structure")
  })

  test("issueDeclaredExpected (stdout) ⇒ stdout_contains w/ payload, execution authority", () => {
    const p = buildVerificationPlan({
      ownerNearTests: ["pytest owner.py"],
      issueDeclaredExpected: { value: "Result: 42", kind: "stdout" },
    })
    expect(p.primaryRail?.successPredicate).toEqual({
      type: "stdout_contains",
      substring: "Result: 42",
    })
    expect(p.primaryRail?.authority).toBe("execution")
  })

  test("issueDeclaredExpected default kind ⇒ latex_or_string_exact", () => {
    const p = buildVerificationPlan({
      ownerNearTests: ["pytest owner.py"],
      issueDeclaredExpected: { value: "ok" },
    })
    expect(p.primaryRail?.successPredicate?.type).toBe("latex_or_string_exact")
  })

  test("issueDeclaredExpected does NOT override red-on-injection (non-RED repro stays optional)", () => {
    const p = buildVerificationPlan({
      reproScript: { cmd: "python reproduce_issue.py", baseValidatedRed: false },
      ownerNearTests: ["pytest owner.py"],
      issueDeclaredExpected: { value: "Result: 42", kind: "stdout" },
    })
    // repro stays optional; the public-evidence owner step is the primary and
    // carries the issue-declared exact-output contract.
    expect(p.required.some((s) => s.kind === "repro")).toBe(false)
    expect(p.optional.some((s) => s.kind === "repro")).toBe(true)
    expect(p.primaryRail?.kind).toBe("owner-test")
    expect(p.primaryRail?.successPredicate?.type).toBe("stdout_contains")
  })

  test("RED-validated repro is primary even with issueDeclaredExpected", () => {
    const p = buildVerificationPlan({
      reproScript: { cmd: "python reproduce_issue.py", baseValidatedRed: true },
      issueDeclaredExpected: { value: "Result: 42", kind: "stdout" },
    })
    expect(p.primaryRail?.kind).toBe("repro")
    expect(p.primaryRail?.successPredicate).toEqual({
      type: "stdout_contains",
      substring: "Result: 42",
    })
  })
})
