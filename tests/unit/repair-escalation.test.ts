/**
 * T-601 — repair escalation. Teeth: widen ONLY on ≥2 corroborated owners AND a
 * red-after-repair rail; a single owner or a bare stage-1 hunch never escalates.
 */
import { describe, expect, test } from "bun:test"
import { decideEscalation } from "@/agent/repair-escalation"

describe("decideEscalation", () => {
  const strongA = { file: "a.py", score: 5, sources: ["stage1", "owner-resolve"] }
  const strongB = { file: "b.py", score: 4, sources: ["stage1", "issue-file"] }

  test("≥2 corroborated owners + rail red → escalate", () => {
    const d = decideEscalation({ candidates: [strongA, strongB], primaryRailRedAfterRepair: true })
    expect(d.escalate).toBe(true)
    expect(d.owners.sort()).toEqual(["a.py", "b.py"])
  })

  test("rail not red → never widen (even with multi-owner)", () => {
    expect(decideEscalation({ candidates: [strongA, strongB], primaryRailRedAfterRepair: false }).escalate).toBe(false)
  })

  test("single corroborated owner → no widen", () => {
    expect(decideEscalation({ candidates: [strongA], primaryRailRedAfterRepair: true }).escalate).toBe(false)
  })

  test("bare stage-1 hunches (uncorroborated) are not strong owners", () => {
    const weak = [
      { file: "x.py", score: 9, sources: ["stage1"] },
      { file: "y.py", score: 9, sources: ["stage1"] },
    ]
    expect(decideEscalation({ candidates: weak, primaryRailRedAfterRepair: true }).escalate).toBe(false)
  })
})

// WS2 — sibling_coverage_missing gate (the #14315 multi-site lever). When
// owner-admission flags an owner-family (an LSP-resolved co-change sibling sits
// in evidence), a single-site attempt that left the rail red is INCOMPLETE.
describe("decideEscalation — sibling_coverage_missing (WS2)", () => {
  const parent = { file: "django/db/backends/base/client.py", score: 5, sources: ["stage1", "owner-resolve"] }
  const childSibling = { file: "django/db/backends/postgresql/client.py", score: 4, sources: ["owner-resolve"] }

  test("owner-family + owner-resolve sibling + rail red → escalate with the sibling in the plan", () => {
    const d = decideEscalation({
      candidates: [parent, childSibling],
      primaryRailRedAfterRepair: true,
      siblingCoverageExpected: true,
    })
    expect(d.escalate).toBe(true)
    expect(d.reason).toContain("sibling_coverage_missing")
    expect(d.owners).toContain("django/db/backends/postgresql/client.py")
  })

  test("TEETH: a SINGLE owner-resolve sibling escalates under the flag (legacy ≥2 gate would NOT)", () => {
    // Without the flag this is exactly the "single corroborated owner → no widen"
    // case. The sibling gate fires before the strong≥2 gate — that's the win.
    const flagged = decideEscalation({
      candidates: [childSibling],
      primaryRailRedAfterRepair: true,
      siblingCoverageExpected: true,
    })
    const legacy = decideEscalation({ candidates: [childSibling], primaryRailRedAfterRepair: true })
    expect(flagged.escalate).toBe(true)
    expect(flagged.reason).toContain("sibling_coverage_missing")
    expect(legacy.escalate).toBe(false) // same input, no flag ⇒ legacy no-widen
  })

  test("rail-red precondition still holds: flag does NOT widen when rail is green", () => {
    expect(
      decideEscalation({
        candidates: [parent, childSibling],
        primaryRailRedAfterRepair: false,
        siblingCoverageExpected: true,
      }).escalate,
    ).toBe(false)
  })

  test("no candidates ⇒ flag does not manufacture a spurious escalation", () => {
    expect(
      decideEscalation({ candidates: [], primaryRailRedAfterRepair: true, siblingCoverageExpected: true })
        .escalate,
    ).toBe(false)
  })

  test("regression: siblingCoverageExpected=false ⇒ byte-identical legacy gate", () => {
    expect(
      decideEscalation({ candidates: [parent], primaryRailRedAfterRepair: true, siblingCoverageExpected: false })
        .escalate,
    ).toBe(false) // single owner, no flag ⇒ legacy no-widen
  })
})
