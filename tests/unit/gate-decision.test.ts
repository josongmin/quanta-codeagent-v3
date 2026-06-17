/**
 * T-302 — GateDecision (bidirectional gate). Teeth: commit-fast on issue-given
 * fix + low stakes (#9296 anti-overthink), verify on high-stakes/uncertain
 * (5-miss anti-underverify), verify names only external sources, and a pointless
 * hygiene-only loop collapses to commit.
 */
import { describe, expect, test } from "bun:test"
import { type GateSignals, decideGate } from "@/agent/gate-decision"

const sig = (over: Partial<GateSignals> = {}): GateSignals => ({
  stakes: { patchFileCount: 1, crossFile: false, destructive: false },
  uncertainty: { sampleDisagreement: false, unresolvedSymbols: false },
  signal: { reproAvailable: false, lspAvailable: false },
  commitFast: { issueProvidesFix: false, highConfidenceSingleOwner: false },
  ...over,
})

describe("decideGate", () => {
  test("issue supplies fix + low stakes → commit-now (anti over-verify, #9296)", () => {
    const d = decideGate(sig({ commitFast: { issueProvidesFix: true, highConfidenceSingleOwner: false } }))
    expect(d.action).toBe("commit-now")
  })

  test("high stakes (cross-file) → verify, including structure when LSP available", () => {
    const d = decideGate(sig({ stakes: { patchFileCount: 2, crossFile: true, destructive: false }, signal: { reproAvailable: true, lspAvailable: true } }))
    expect(d.action).toBe("verify")
    if (d.action === "verify") expect(d.sources.sort()).toEqual(["hygiene", "repro", "structure"])
  })

  test("uncertain localization → verify (anti under-verify)", () => {
    const d = decideGate(sig({ uncertainty: { sampleDisagreement: true, unresolvedSymbols: false }, signal: { reproAvailable: true, lspAvailable: false } }))
    expect(d.action).toBe("verify")
  })

  test("verify names only EXTERNAL sources (never self-critique)", () => {
    const d = decideGate(sig({ stakes: { patchFileCount: 3, crossFile: false, destructive: false }, signal: { reproAvailable: true, lspAvailable: true } }))
    if (d.action === "verify") {
      for (const s of d.sources) expect(["repro", "structure", "hygiene"]).toContain(s)
    }
  })

  test("low-stakes + certain + no external signal → commit (no pointless hygiene-only loop)", () => {
    expect(decideGate(sig()).action).toBe("commit-now")
  })

  test("high-confidence single owner with a repro available still verifies (cheap signal exists)", () => {
    const d = decideGate(sig({ commitFast: { issueProvidesFix: false, highConfidenceSingleOwner: true }, signal: { reproAvailable: true, lspAvailable: false } }))
    expect(d.action).toBe("verify")
  })
})
