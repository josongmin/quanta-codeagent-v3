/**
 * G0 — winner=null RCA diagnostic (jun-25). Behavior-NEUTRAL telemetry that
 * attributes an empty submission (winner=null → empty patch → completed_unresolved)
 * to its real cause, so a regressionGreen-on-infra body is distinguishable from a
 * genuine model miss in the report.
 *
 * This pins:
 *   1. the pure histogram (`ineligibleReasonsFor`) mirrors `bestEffortEligible`
 *      EXACTLY (wiring-proof: no drift between the gate and its explanation);
 *   2. `summarizeSelection` forwards `noWinnerDiagnostic` to the report telemetry
 *      ONLY when winner=null (red-on-injection: a winner present ⇒ no diagnostic).
 */
import { describe, expect, test } from "bun:test"
import type { CandidateVerdict, HardGateSignals } from "@/agent/verification-bundle/types"
import { bestEffortEligible, ineligibleReasonsFor } from "@/runner/batch/eval/selection-gates"
import { summarizeSelection } from "@/runner/batch/eval/selection-proof-telemetry"
import type { ScoredEntry, SelectionResult } from "@/runner/batch/eval/selection-types"

const hard = (over: Partial<HardGateSignals>): HardGateSignals => ({
  baseValidatedRed: null,
  patchProduced: true,
  patchedResolvedKofN: null,
  regressionGreen: null,
  smokeGreen: null,
  applyClean: null,
  ...over,
})

const verdict = (over: Partial<CandidateVerdict> = {}): CandidateVerdict => ({
  admissible: false,
  score: 0,
  reasons: [],
  ...over,
})

const entry = (
  id: string,
  h: Partial<HardGateSignals>,
  patch = "diff --git a b",
  v: Partial<CandidateVerdict> = {},
): ScoredEntry => ({
  candidate: { id, patch, files: ["a.py"] } as unknown as ScoredEntry["candidate"],
  hard: hard(h),
  resolvedKofN: null,
  voterQuorum: null,
  verdict: verdict(v),
  requiredContractsSatisfied: 0,
  contractsSatisfied: 0,
})

describe("G0: ineligibleReasonsFor mirrors bestEffortEligible (wiring-proof)", () => {
  // The histogram is the EXACT same gate sequence — for any entry, it is
  // non-empty IFF bestEffortEligible is false.
  const cases: { name: string; e: ScoredEntry; reason: string }[] = [
    {
      name: "regression false",
      e: entry("a", { regressionGreen: false }),
      reason: "regressionGreen",
    },
    { name: "apply false", e: entry("b", { applyClean: false }), reason: "applyClean" },
    { name: "empty patch", e: entry("c", { patchProduced: false }, ""), reason: "patchProduced" },
  ]
  for (const c of cases) {
    test(`${c.name}: ineligible ⇔ bestEffortEligible=false, names the gate`, () => {
      const reasons = ineligibleReasonsFor(c.e, "research")
      expect(bestEffortEligible(c.e, "research")).toBe(false)
      expect(reasons.length > 0).toBe(true)
      expect(reasons as readonly string[]).toContain(c.reason)
    })
  }

  test("a clean candidate is eligible and has zero ineligible reasons", () => {
    const e = entry("ok", { regressionGreen: true, applyClean: true })
    expect(bestEffortEligible(e, "research")).toBe(true)
    expect(ineligibleReasonsFor(e, "research")).toEqual([])
  })
})

const baseResult = (over: Partial<SelectionResult>): SelectionResult => ({
  attempted: 1,
  ownerFiles: ["a.py"],
  earlyAccepted: false,
  successfulGenerations: 1,
  generationFailures: 0,
  winner: null,
  terminalCandidate: null,
  scored: [],
  admissibleCount: 0,
  generated: 0,
  proofRequired: false,
  ...over,
})

describe("G0: summarizeSelection forwards the diagnostic only on winner=null", () => {
  test("winner=null ⇒ noWinnerDiagnostic distinguishes regressionGreen=false from a model miss", () => {
    const result = baseResult({
      scored: [entry("a", { regressionGreen: false }), entry("b", { applyClean: false })],
      generated: 2,
      noWinnerDiagnostic: {
        scoredCount: 2,
        nonemptyCandidateCount: 2,
        bestEffortEligibleCount: 0,
        ineligibleReasons: { regressionGreen: 1, applyClean: 1 },
        regressionGreen: { false: 1, null: 1, true: 0 },
      },
    })
    const tel = summarizeSelection(result)
    expect(tel.winnerId).toBeNull()
    expect(tel.noWinnerDiagnostic).toBeDefined()
    // The fingerprint: a regressionGreen=false bucket points at the F3R body.
    expect(tel.noWinnerDiagnostic?.ineligibleReasons.regressionGreen).toBe(1)
    expect(tel.noWinnerDiagnostic?.regressionGreen.false).toBe(1)
    expect(tel.noWinnerDiagnostic?.bestEffortEligibleCount).toBe(0)
  })

  test("winner present ⇒ NO diagnostic (byte-identical normal path)", () => {
    const e = entry("w", { regressionGreen: true, applyClean: true }, "diff", { admissible: true })
    const result = baseResult({
      winner: e.candidate,
      scored: [e],
      generated: 1,
      admissibleCount: 1,
      // No noWinnerDiagnostic on the result (finalize omits it when winner!=null).
    })
    const tel = summarizeSelection(result)
    expect(tel.winnerId).toBe("w")
    expect(tel.noWinnerDiagnostic).toBeUndefined()
  })
})
