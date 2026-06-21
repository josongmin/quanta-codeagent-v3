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
import { authoritativeOwnerFiles, decideOwnerAdmission } from "@/agent/owner-admission"

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

  test("legacy admit carries evidenceStrength provenance (additive, non-null on admit)", () => {
    const d = decideOwnerAdmission({
      packet: packet({
        candidates: [
          { file: "src/core/parser.ts", score: 5, sources: ["stage1", "issue-file"], symbols: [] },
          { file: "src/util/log.ts", score: 1, sources: ["stage1"], symbols: [] },
        ],
      }),
    })
    expect(d.admit).toBe(true)
    expect(d.evidenceStrength).toBe("authoritative")
  })
})

/**
 * T-OWN-12 — CLEAN (rule-based) owner admission. Teeth:
 *  - stage1-only / sibling-only / non-unique owner-resolve CANNOT admit (advisory).
 *  - exactly one authoritative (issue-file) owner ⇒ admit.
 *  - two conflicting authoritative owners ⇒ admit:false (not a score winner).
 *  - advisory evidence shapes ordering but never makes a candidate inadmissible.
 */
describe("decideOwnerAdmission clean mode (T-OWN-12)", () => {
  test("exactly one authoritative (issue-file) owner ⇒ admit, authoritative", () => {
    const d = decideOwnerAdmission({
      clean: true,
      packet: packet({
        candidates: [
          { file: "pkg/named.py", score: 2, sources: ["issue-file"], symbols: [] },
          { file: "pkg/ranked.py", score: 99, sources: ["stage1"], symbols: [] },
        ],
      }),
    })
    // red-on-injection: a single public-issue-named owner admits even when a
    // higher-SCORED advisory candidate exists — score must NOT win the clean path.
    expect(d.admit).toBe(true)
    expect(d.owner).toBe("pkg/named.py")
    expect(d.coverageExpectation).toBe("single-site")
    expect(d.siblingCoverageExpected).toBe(false)
    expect(d.evidenceStrength).toBe("authoritative")
  })

  test("stage1-only evidence CANNOT admit a single owner in clean mode", () => {
    const d = decideOwnerAdmission({
      clean: true,
      packet: packet({
        candidates: [{ file: "pkg/only.py", score: 100, sources: ["stage1"], symbols: [] }],
      }),
    })
    // red-on-injection: a huge stage-1 score is advisory; clean admit must be false.
    expect(d.admit).toBe(false)
    expect(d.owner).toBeNull()
    expect(d.evidenceStrength).toBeNull()
  })

  test("sibling-only / non-unique owner-resolve evidence CANNOT admit (advisory)", () => {
    const d = decideOwnerAdmission({
      clean: true,
      packet: packet({
        candidates: [
          { file: "pkg/a.py", score: 5, sources: ["owner-resolve"], symbols: [] },
          { file: "pkg/b.py", score: 3, sources: ["stage1", "owner-resolve"], symbols: [] },
        ],
      }),
    })
    expect(d.admit).toBe(false)
    expect(d.owner).toBeNull()
  })

  test("two conflicting authoritative owner files ⇒ admit:false (not a score winner)", () => {
    const d = decideOwnerAdmission({
      clean: true,
      packet: packet({
        candidates: [
          { file: "pkg/x.py", score: 9, sources: ["issue-file"], symbols: [] },
          { file: "pkg/y.py", score: 1, sources: ["issue-file"], symbols: [] },
        ],
      }),
    })
    // red-on-injection: a clear score lead (9 vs 1) must NOT pick a single owner;
    // two authoritative claims are cross-owner.
    expect(d.admit).toBe(false)
    expect(d.owner).toBeNull()
    expect(d.coverageExpectation).toBe("cross-owner")
    expect(d.reason).toContain("pkg/x.py")
    expect(d.reason).toContain("pkg/y.py")
  })

  test("advisory evidence shapes ordering but does not make the authoritative owner inadmissible", () => {
    const d = decideOwnerAdmission({
      clean: true,
      packet: packet({
        candidates: [
          { file: "pkg/advisory.py", score: 50, sources: ["stage1", "owner-resolve"], symbols: [] },
          { file: "pkg/owner.py", score: 1, sources: ["issue-file"], symbols: [] },
        ],
      }),
    })
    // the lone authoritative owner still admits despite a heavier advisory rival.
    expect(d.admit).toBe(true)
    expect(d.owner).toBe("pkg/owner.py")
  })

  test("authoritative owner with shared-stream authoritative sibling ⇒ owner-family", () => {
    const d = decideOwnerAdmission({
      clean: true,
      packet: packet({
        candidates: [
          { file: "pkg/encode.py", score: 5, sources: ["issue-file", "stage1"], symbols: [] },
          { file: "pkg/decode.py", score: 3, sources: ["issue-file", "stage1"], symbols: [] },
        ],
      }),
    })
    // two authoritative files ⇒ cross-owner takes precedence (>1 authoritative).
    expect(d.admit).toBe(false)
    expect(d.coverageExpectation).toBe("cross-owner")
  })

  test("single authoritative owner with corroborated shared-stream sibling ⇒ owner-family admit", () => {
    const d = decideOwnerAdmission({
      clean: true,
      packet: packet({
        candidates: [
          { file: "pkg/owner.py", score: 5, sources: ["issue-file", "owner-resolve"], symbols: [] },
          { file: "pkg/sib.py", score: 3, sources: ["stage1", "owner-resolve"], symbols: [] },
        ],
      }),
    })
    expect(d.admit).toBe(true)
    expect(d.owner).toBe("pkg/owner.py")
    expect(d.coverageExpectation).toBe("owner-family")
    expect(d.siblingCoverageExpected).toBe(true)
    expect(d.reason).toContain("pkg/sib.py")
  })

  test("no authoritative evidence + empty ⇒ admit:false", () => {
    const d = decideOwnerAdmission({ clean: true, packet: packet({ candidates: [] }) })
    expect(d.admit).toBe(false)
    expect(d.owner).toBeNull()
    expect(d.reason.length).toBeGreaterThan(0)
  })

  test("PAIRED CONTROL: clean=false is byte-identical to default (legacy) for the same input", () => {
    // Same input run two ways: omitted clean vs explicit clean=false must be the
    // EXACT same result object. Research/legacy mode is unchanged by T-OWN-12.
    const inputs = [
      packet({
        candidates: [
          { file: "src/core/parser.ts", score: 5, sources: ["stage1", "owner-resolve"], symbols: ["parse"] },
          { file: "src/util/log.ts", score: 1, sources: ["stage1"], symbols: [] },
        ],
      }),
      packet({
        candidates: [
          { file: "src/a.ts", score: 3, sources: ["stage1", "issue-file"], symbols: [] },
          { file: "src/b.ts", score: 3, sources: ["stage1", "issue-file"], symbols: [] },
        ],
      }),
      packet({ candidates: [{ file: "x", score: 9, sources: ["stage1"], symbols: [] }] }),
      packet({ candidates: [], partial: true }),
    ]
    for (const p of inputs) {
      const legacyDefault = decideOwnerAdmission({ packet: p })
      const legacyExplicit = decideOwnerAdmission({ packet: p, clean: false })
      expect(legacyExplicit).toEqual(legacyDefault)
    }
  })
})

describe("authoritativeOwnerFiles (T-OWN-12 pure helper)", () => {
  test("returns only issue-file-sourced files (advisory excluded)", () => {
    const files = authoritativeOwnerFiles(
      packet({
        candidates: [
          { file: "pkg/named.py", score: 2, sources: ["issue-file", "stage1"], symbols: [] },
          { file: "pkg/ranked.py", score: 99, sources: ["stage1"], symbols: [] },
          { file: "pkg/resolved.py", score: 5, sources: ["owner-resolve"], symbols: [] },
        ],
      }),
    )
    // red-on-injection: a stage1/owner-resolve file must NOT appear — only the
    // public-issue-named owner is authoritative.
    expect(files).toEqual(["pkg/named.py"])
  })

  test("dedups + preserves candidate order; empty when no authoritative evidence", () => {
    expect(
      authoritativeOwnerFiles(
        packet({ candidates: [{ file: "x", score: 9, sources: ["stage1"], symbols: [] }] }),
      ),
    ).toEqual([])
    const files = authoritativeOwnerFiles(
      packet({
        candidates: [
          { file: "pkg/b.py", score: 1, sources: ["issue-file"], symbols: [] },
          { file: "pkg/a.py", score: 1, sources: ["issue-file"], symbols: [] },
          { file: "pkg/b.py", score: 1, sources: ["issue-file"], symbols: [] },
        ],
      }),
    )
    expect(files).toEqual(["pkg/b.py", "pkg/a.py"])
  })
})
