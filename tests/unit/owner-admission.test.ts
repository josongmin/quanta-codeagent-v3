/**
 * T-202 — owner admission decision. Teeth:
 *  1. single corroborated owner ⇒ admit, single-site
 *  2. multiple unresolved plausible owners ⇒ admit:false (evidence-first)
 *  3. defect class spans sibling producers ⇒ siblingCoverageExpected (owner-family)
 *  4. empty / absent evidence ⇒ safe default admit:false
 * Plus: every decision carries a non-empty reason. Red-on-injection: each
 * positive case asserts the field that flips if the policy degrades.
 */
import { describe, expect, test } from "bun:test"
import type { FaultEvidencePacket } from "@/agent/fault-evidence/types"
import { decideOwnerAdmission } from "@/agent/owner-admission"

const packet = (over: Partial<FaultEvidencePacket>): FaultEvidencePacket => ({
  candidates: [],
  issueSymbols: [],
  truncated: false,
  partial: false,
  ...over,
})

describe("decideOwnerAdmission", () => {
  test("single corroborated owner with clear lead ⇒ admit, single-site", () => {
    const d = decideOwnerAdmission({
      packet: packet({
        candidates: [
          { file: "src/core/parser.ts", score: 5, sources: ["stage1", "owner-resolve"], symbols: ["parse"] },
          { file: "src/util/log.ts", score: 1, sources: ["stage1"], symbols: [] },
        ],
      }),
    })
    expect(d.admit).toBe(true)
    expect(d.owner).toBe("src/core/parser.ts")
    expect(d.coverageExpectation).toBe("single-site")
    // red-on-injection: a single-site admit must NOT demand sibling coverage,
    // else commit-fast (T-601) is wrongly blocked.
    expect(d.siblingCoverageExpected).toBe(false)
    expect(d.reason.length).toBeGreaterThan(0)
  })

  test("multiple plausible owners, no clear leader ⇒ admit:false (evidence-first)", () => {
    const d = decideOwnerAdmission({
      packet: packet({
        candidates: [
          { file: "src/a.ts", score: 3, sources: ["stage1", "issue-file"], symbols: [] },
          { file: "src/b.ts", score: 3, sources: ["stage1", "issue-file"], symbols: [] },
        ],
      }),
    })
    // red-on-injection: tied owners must not be force-admitted (would inject a
    // wrong first-edit line and skip evidence gathering).
    expect(d.admit).toBe(false)
    expect(d.owner).toBeNull()
    expect(d.coverageExpectation).toBe("cross-owner")
    expect(d.reason).toContain("src/a.ts")
    expect(d.reason.length).toBeGreaterThan(0)
  })

  test("defect class spans corroborated sibling producers ⇒ owner-family + siblingCoverageExpected", () => {
    const d = decideOwnerAdmission({
      packet: packet({
        candidates: [
          { file: "src/codec/encode.ts", score: 5, sources: ["stage1", "owner-resolve"], symbols: ["encode"] },
          { file: "src/codec/decode.ts", score: 3, sources: ["stage1", "owner-resolve"], symbols: ["decode"] },
        ],
      }),
    })
    expect(d.admit).toBe(true)
    expect(d.owner).toBe("src/codec/encode.ts")
    expect(d.coverageExpectation).toBe("owner-family")
    // red-on-injection: a shared-evidence sibling MUST raise the flag so a
    // single-site edit isn't treated complete (pairs with T-601).
    expect(d.siblingCoverageExpected).toBe(true)
    expect(d.reason).toContain("src/codec/decode.ts")
    expect(d.reason.length).toBeGreaterThan(0)
  })

  test("empty evidence ⇒ safe default admit:false", () => {
    const d = decideOwnerAdmission({ packet: packet({ candidates: [] }) })
    expect(d.admit).toBe(false)
    expect(d.owner).toBeNull()
    expect(d.reason.length).toBeGreaterThan(0)
  })

  test("partial (absent input stream) empty packet ⇒ reason names partiality, still safe default", () => {
    const d = decideOwnerAdmission({ packet: packet({ candidates: [], partial: true }) })
    expect(d.admit).toBe(false)
    expect(d.reason).toContain("partial")
  })

  test("clear leader but uncorroborated (lone stage-1 hit) ⇒ no admit", () => {
    const d = decideOwnerAdmission({
      packet: packet({
        candidates: [{ file: "src/only.ts", score: 9, sources: ["stage1"], symbols: [] }],
      }),
    })
    // red-on-injection: a single weak source must not admit an owner.
    expect(d.admit).toBe(false)
    expect(d.owner).toBeNull()
    expect(d.reason).toContain("uncorroborated")
  })

  test("single corroborated owner, no runner-up ⇒ admit, single-site", () => {
    const d = decideOwnerAdmission({
      packet: packet({
        candidates: [{ file: "src/lone.ts", score: 5, sources: ["stage1", "issue-file"], symbols: [] }],
      }),
    })
    expect(d.admit).toBe(true)
    expect(d.coverageExpectation).toBe("single-site")
    expect(d.siblingCoverageExpected).toBe(false)
  })

  test("clear-lead corroborated owner with a NON-sharing sibling ⇒ single-site (no false family)", () => {
    const d = decideOwnerAdmission({
      packet: packet({
        candidates: [
          { file: "src/main.ts", score: 5, sources: ["owner-resolve", "issue-file"], symbols: [] },
          { file: "src/other.ts", score: 3, sources: ["stage1"], symbols: [] },
        ],
      }),
    })
    expect(d.admit).toBe(true)
    // runner-up is uncorroborated AND shares no boost stream ⇒ not a family.
    expect(d.coverageExpectation).toBe("single-site")
    expect(d.siblingCoverageExpected).toBe(false)
  })

  test("custom minLeadGap respected: a 2-point lead under gap=3 is ambiguous", () => {
    const d = decideOwnerAdmission({
      minLeadGap: 3,
      packet: packet({
        candidates: [
          { file: "src/x.ts", score: 5, sources: ["stage1", "issue-file"], symbols: [] },
          { file: "src/y.ts", score: 3, sources: ["stage1", "issue-file"], symbols: [] },
        ],
      }),
    })
    expect(d.admit).toBe(false)
    expect(d.coverageExpectation).toBe("cross-owner")
  })
})
