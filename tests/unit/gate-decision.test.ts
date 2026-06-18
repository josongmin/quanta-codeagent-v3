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

  // CLOSURE-RUNNER CONSISTENCY: a reproducing repro is an execution rail the
  // closure engine deliberately built (baseValidatedRed). Running it once is a
  // single cheap confirmation (NOT an exploration loop — repair caps rounds), so
  // it must not be discarded by the issue-provides-fix commit-fast shortcut. This
  // MIRRORS the established single-owner rule (`highConfidenceSingleOwner &&
  // !reproAvailable`): execution evidence overrides a declared-output heuristic.
  // Without this the selected primary rail is wasted on exactly the instances the
  // closure-driven runner exists to verify.
  test("issue supplies fix BUT a repro rail is available → verify (don't waste the execution rail)", () => {
    const d = decideGate(
      sig({
        commitFast: { issueProvidesFix: true, highConfidenceSingleOwner: false },
        signal: { reproAvailable: true, lspAvailable: false },
      }),
    )
    expect(d.action).toBe("verify")
    if (d.action === "verify") expect(d.sources).toContain("repro")
  })

  // Paired control: issue-provides-fix WITHOUT a repro stays commit-now (the
  // anti-over-verify shortcut is preserved when there's no cheap rail to run).
  test("issue supplies fix and NO repro → still commit-now (shortcut preserved)", () => {
    const d = decideGate(
      sig({
        commitFast: { issueProvidesFix: true, highConfidenceSingleOwner: false },
        signal: { reproAvailable: false, lspAvailable: false },
      }),
    )
    expect(d.action).toBe("commit-now")
  })
})
