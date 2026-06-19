import { describe, expect, test } from "bun:test"
import { renderClosurePrompt } from "@/agent/closure"
import type { OwnerAdmission } from "@/agent/owner-admission"

const owner = (coverageExpectation: OwnerAdmission["coverageExpectation"]): OwnerAdmission => ({
  admit: true,
  owner: "base.py",
  coverageExpectation,
  siblingCoverageExpected: coverageExpectation !== "single-site",
  reason: "test",
})

describe("renderClosurePrompt (round-0 owner hint)", () => {
  test("resolved siblings ⇒ co-change hint listing ALL (round-0 widen)", () => {
    const h = renderClosurePrompt(owner("owner-family"), ["pg.py", "mysql.py"])
    expect(h).toContain("co-change")
    expect(h).toContain("INCOMPLETE")
    expect(h).toContain("- base.py") // owner
    expect(h).toContain("- pg.py")
    expect(h).toContain("- mysql.py")
  })

  // Teeth: the OLD inverted code returned "" for owner-family — this proves the
  // multi-site case now gets a hint at round 0 instead of being blanked.
  test("owner-family WITH siblings is NOT blanked (the fixed inversion)", () => {
    expect(renderClosurePrompt(owner("owner-family"), ["pg.py"])).not.toBe("")
  })

  test("single-site, no siblings ⇒ one-line candidate", () => {
    expect(renderClosurePrompt(owner("single-site"), [])).toBe("First edit candidate: base.py")
  })

  test("owner-family but NO resolved siblings ⇒ empty (no false co-change claim)", () => {
    expect(renderClosurePrompt(owner("owner-family"), [])).toBe("")
  })

  test("owner itself is filtered out of the sibling list (listed once, as owner)", () => {
    const h = renderClosurePrompt(owner("owner-family"), ["base.py", "pg.py"])
    expect(h.split("- base.py").length - 1).toBe(1)
    expect(h).toContain("- pg.py")
  })

  test("not admitted + NO siblings ⇒ empty", () => {
    const notAdmitted: OwnerAdmission = {
      admit: false,
      owner: null,
      coverageExpectation: "single-site",
      siblingCoverageExpected: false,
      reason: "test",
    }
    expect(renderClosurePrompt(notAdmitted, [])).toBe("")
  })

  test("not admitted BUT siblings resolved ⇒ sibling-only hint (override family is real)", () => {
    const notAdmitted: OwnerAdmission = {
      admit: false,
      owner: null,
      coverageExpectation: "single-site",
      siblingCoverageExpected: false,
      reason: "test",
    }
    const h = renderClosurePrompt(notAdmitted, ["x.py", "y.py"])
    expect(h).toContain("co-change")
    expect(h).toContain("- x.py")
    expect(h).not.toContain("- base.py") // owner is null ⇒ not listed
  })
})
