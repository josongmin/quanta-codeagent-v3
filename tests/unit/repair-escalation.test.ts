/**
 * T-601 — repair escalation. Teeth: widen ONLY on ≥2 corroborated owners AND a
 * red-after-repair rail; a single owner or a bare stage-1 hunch never escalates.
 */
import { describe, expect, test } from "bun:test"
import { decideEscalation } from "@/agent/repair-escalation"

describe("decideEscalation", () => {
  // Corroborated by ≥2 streams but NOT owner-resolve, so these exercise the LEGACY
  // strong≥2 gate without tripping the feeder sibling branch (owner-resolve).
  const strongA = { file: "a.py", score: 5, sources: ["stage1", "issue-file"] }
  const strongB = { file: "b.py", score: 4, sources: ["stage1", "issue-file"] }

  test("≥2 corroborated owners + rail red → escalate", () => {
    const d = decideEscalation({ candidates: [strongA, strongB], primaryRailRedAfterRepair: true })
    expect(d.escalate).toBe(true)
    expect(d.owners.sort()).toEqual(["a.py", "b.py"])
  })

  test("rail not red → never widen (even with multi-owner)", () => {
    expect(decideEscalation({ candidates: [strongA, strongB], primaryRailRedAfterRepair: false }).escalate).toBe(false)
  })

  test("single corroborated (non-sibling) owner → no widen", () => {
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

// WS2 — sibling_coverage_missing gate (the #14315 multi-site lever). Keys off the
// FEEDER's unsliced `siblingFiles` (the SAME list the repair-seed widen injects),
// so the gate's record can't disagree with the widen behavior. A single-site
// attempt that left the rail red is then INCOMPLETE.
describe("decideEscalation — sibling_coverage_missing (WS2)", () => {
  const PG = "django/db/backends/postgresql/client.py"
  const MYSQL = "django/db/backends/mysql/client.py"

  test("siblingFiles + rail red → sibling_coverage_missing over the siblings", () => {
    const d = decideEscalation({ candidates: [], primaryRailRedAfterRepair: true, siblingFiles: [PG, MYSQL] })
    expect(d.escalate).toBe(true)
    expect(d.reason).toContain("sibling_coverage_missing")
    expect(d.owners).toContain(PG)
  })

  test("TEETH: a SINGLE sibling file escalates (legacy strong≥2 gate would NOT)", () => {
    // The legacy gate needs ≥2 strong owners → no widen. The feeder-keyed sibling
    // gate fires on the single co-change site, with no candidates at all.
    const d = decideEscalation({ candidates: [], primaryRailRedAfterRepair: true, siblingFiles: [PG] })
    expect(d.escalate).toBe(true)
    expect(d.reason).toContain("sibling_coverage_missing")
  })

  test("rail not red ⇒ no widen even with siblings present", () => {
    expect(
      decideEscalation({ candidates: [], primaryRailRedAfterRepair: false, siblingFiles: [PG] }).escalate,
    ).toBe(false)
  })

  test("no siblingFiles ⇒ falls through to the legacy strong≥2 gate (no sibling reason)", () => {
    const d = decideEscalation({
      candidates: [
        { file: "x.py", score: 9, sources: ["stage1"] },
        { file: "y.py", score: 9, sources: ["stage1"] },
      ],
      primaryRailRedAfterRepair: true,
    })
    expect(d.escalate).toBe(false)
    expect(d.reason).not.toContain("sibling_coverage_missing")
  })

  test("no candidates and no siblings ⇒ no escalation", () => {
    expect(decideEscalation({ candidates: [], primaryRailRedAfterRepair: true }).escalate).toBe(false)
  })
})
