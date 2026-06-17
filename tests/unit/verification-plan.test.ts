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
    expect(p.primaryRail).toEqual({ kind: "repro", cmd: "python reproduce_issue.py" })
    expect(p.required[0]).toEqual(p.primaryRail)
    expect(p.baseValidatedRed).toBe(true)
  })

  test("repro NOT validated red is demoted to optional, never primaryRail/required", () => {
    const p = buildVerificationPlan({
      reproScript: { cmd: "python reproduce_issue.py", baseValidatedRed: false },
      ownerNearTests: ["pytest tests/owner_test.py"],
    })
    expect(p.primaryRail).toEqual({ kind: "owner-test", cmd: "pytest tests/owner_test.py" })
    expect(p.required.some((s) => s.kind === "repro")).toBe(false)
    expect(p.optional.some((s) => s.kind === "repro")).toBe(true)
  })

  test("no repro → primary from owner-near test (public evidence)", () => {
    const p = buildVerificationPlan({ ownerNearTests: ["pytest a.py", "pytest b.py"] })
    expect(p.primaryRail).toEqual({ kind: "owner-test", cmd: "pytest a.py" })
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
    expect(p.primaryRail).toEqual({ kind: "module-smoke", cmd: "pytest mod_smoke.py" })
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
})
