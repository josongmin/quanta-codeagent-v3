import { describe, expect, test } from "bun:test"
import type { ClosureBundleInput } from "@/agent/closure"
import { assembleClosureBundle } from "@/agent/closure"

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
    issueProvidesFix: false,
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
    // Corroborate `a.py` (2 sources: stage1 + issueFiles, with a lead over b.py)
    // so the owner ADMITS — otherwise the assertion below is vacuous.
    const b = assembleClosureBundle(
      baseInput({
        evidence: {
          issueText: "fix the printer in a.py",
          stage1Files: [
            { file: "a.py", score: 10 },
            { file: "b.py", score: 1 },
          ],
          issueFiles: ["a.py"],
        },
      }),
    )
    // not vacuous: the owner must actually admit a single corroborated owner.
    expect(b.owner.admit).toBe(true)
    expect(b.owner.owner).not.toBeNull()
    // and that admitted owner MUST be one of the assembled evidence candidates
    // (same packet) — red-on-injection if owner were derived from other evidence.
    const candidateFiles = b.evidence.candidates.map((c) => c.file)
    expect(candidateFiles).toContain(b.owner.owner!)
  })

  test("no repro ⇒ plan rail falls back to owner-near test (not a synth repro)", () => {
    const b = assembleClosureBundle(baseInput({ plan: { ownerNearTests: ["pytest test_a.py"] } }))
    expect(b.plan.primaryRail?.kind).toBe("owner-test")
    expect(b.plan.baseValidatedRed).toBe(false)
    expect(b.plan.primaryRailBaseValidatedRed).toBe(false)
  })

  test("ambiguous owner / high stakes ⇒ gate is verify-first (no commit-fast)", () => {
    const b = assembleClosureBundle(
      baseInput({
        gate: {
          stakes: { patchFileCount: 3, crossFile: true, destructive: false },
          uncertainty: { sampleDisagreement: true, unresolvedSymbols: false },
          signal: { reproAvailable: false, lspAvailable: true },
          issueProvidesFix: false,
        },
      }),
    )
    expect(b.gate.action).toBe("verify")
  })

  test("single-site owner + issue-provided fix ⇒ commit-fast is derived, not caller-injected", () => {
    const b = assembleClosureBundle(
      baseInput({
        evidence: {
          issueText: 'src/core.py should return "hello".',
          stage1Files: [{ file: "src/core.py", score: 5 }],
          issueFiles: ["src/core.py"],
        },
        gate: {
          stakes: { patchFileCount: 1, crossFile: false, destructive: false },
          uncertainty: { sampleDisagreement: false, unresolvedSymbols: false },
          signal: { reproAvailable: false, lspAvailable: false },
          issueProvidesFix: true,
        },
      }),
    )
    expect(b.owner.admit).toBe(true)
    expect(b.owner.coverageExpectation).toBe("single-site")
    expect(b.gate.action).toBe("commit-now")
  })

  test("owner-family suppresses issue-based commit-fast", () => {
    const b = assembleClosureBundle(
      baseInput({
        evidence: {
          issueText: 'src/encode.py should return "ok".',
          stage1Files: [
            { file: "src/encode.py", score: 5 },
            { file: "src/decode.py", score: 3 },
          ],
          ownerResolved: [
            { file: "src/encode.py", forSymbol: "encode" },
            { file: "src/decode.py", forSymbol: "decode" },
          ],
        },
        gate: {
          stakes: { patchFileCount: 1, crossFile: false, destructive: false },
          uncertainty: { sampleDisagreement: false, unresolvedSymbols: false },
          signal: { reproAvailable: false, lspAvailable: true },
          issueProvidesFix: true,
        },
      }),
    )
    expect(b.owner.coverageExpectation).toBe("owner-family")
    expect(b.gate.action).toBe("verify")
  })
})
