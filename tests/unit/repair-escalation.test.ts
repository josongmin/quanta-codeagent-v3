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
