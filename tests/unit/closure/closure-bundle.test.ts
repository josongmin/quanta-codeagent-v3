import { describe, expect, test } from "bun:test"
import { assembleClosureBundle } from "@/agent/closure"
import type { ClosureBundleInput } from "@/agent/closure"

/**
 * T-3 — ClosureBundle SSOT. The one artifact prompt/gate/repair/diagnostics
 * consume, so closure facts are computed ONCE and never drift.
 *
 * Load-bearing:
 *  - PURE/deterministic: same input ⇒ same bundle.
 *  - INTERNALLY CONSISTENT: `owner` is derived from the SAME `evidence` packet.
 *  - no repro ⇒ owner-test/smoke fallback drives the rail (not a synthesized repro).
 *  - ambiguous owner ⇒ gate is verify-first (no commit-fast on co-plausible owners).
 */
const baseInput = (over: Partial<ClosureBundleInput> = {}): ClosureBundleInput => ({
  evidence: {
    issueText: "fix the printer",
    stage1Files: [
      { file: "a.py", score: 10 },
      { file: "b.py", score: 9 },
    ],
  },
  plan: { ownerNearTests: ["pytest test_a.py"] },
  gate: {
    stakes: { patchFileCount: 1, crossFile: false, destructive: false },
    uncertainty: { sampleDisagreement: false, unresolvedSymbols: false },
    signal: { reproAvailable: false, lspAvailable: true },
    commitFast: { issueProvidesFix: false, highConfidenceSingleOwner: false },
  },
  ...over,
})

describe("assembleClosureBundle — SSOT", () => {
  test("same input ⇒ same bundle (pure/deterministic)", () => {
    const a = assembleClosureBundle(baseInput())
    const b = assembleClosureBundle(baseInput())
    expect(a).toEqual(b)
  })

  test("bundle carries all four facets", () => {
    const b = assembleClosureBundle(baseInput())
    expect(b.evidence).toBeDefined()
    expect(b.owner).toBeDefined()
    expect(b.plan).toBeDefined()
    expect(b.gate).toBeDefined()
  })

  test("owner is derived from the SAME evidence packet (internal consistency)", () => {
    // The owner decision must reflect the assembled evidence — when the owner
    // admits, its `owner` path is one of the evidence candidates.
    const b = assembleClosureBundle(baseInput())
    if (b.owner.admit && b.owner.owner !== null) {
      const candidateFiles = b.evidence.candidates.map((c) => c.file)
      expect(candidateFiles).toContain(b.owner.owner)
    }
  })

  test("no repro ⇒ plan rail falls back to owner-near test (not a synth repro)", () => {
    const b = assembleClosureBundle(baseInput({ plan: { ownerNearTests: ["pytest test_a.py"] } }))
    expect(b.plan.primaryRail?.kind).toBe("owner-test")
    expect(b.plan.baseValidatedRed).toBe(false)
  })

  test("ambiguous owner / high stakes ⇒ gate is verify-first (no commit-fast)", () => {
    const b = assembleClosureBundle(
      baseInput({
        gate: {
          stakes: { patchFileCount: 3, crossFile: true, destructive: false },
          uncertainty: { sampleDisagreement: true, unresolvedSymbols: false },
          signal: { reproAvailable: false, lspAvailable: true },
          commitFast: { issueProvidesFix: false, highConfidenceSingleOwner: false },
        },
      }),
    )
    expect(b.gate.action).toBe("verify")
  })
})
