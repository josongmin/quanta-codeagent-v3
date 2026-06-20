import { describe, expect, it } from "bun:test"
import {
  type HardGateSignals,
  type ScoredCandidate,
  type SoftScoreSignals,
  scoreCandidate,
  selectBest,
  selectBestEffort,
} from "@/agent/verification-bundle"

/** All hard gates SATISFIED (the admissible baseline to inject failures into). */
const HARD_OK: HardGateSignals = {
  baseValidatedRed: true,
  patchProduced: true,
  patchedResolvedKofN: { votes: 3, k: 2 },
  regressionGreen: true,
  applyClean: true,
}
/** No soft signals available (isolate the hard-gate behaviour). */
const SOFT_NONE: SoftScoreSignals = {
  declaredExpectedMatch: null,
  rubricScore: null,
  voterQuorum: null,
  minimality: null,
  ownerCoverage: null,
}

describe("scoreCandidate — hard gate (red-on-injection, each gate)", () => {
  it("baseline (all hard satisfied) ⇒ admissible", () => {
    expect(scoreCandidate(HARD_OK, SOFT_NONE).admissible).toBe(true)
  })

  it("regressionGreen=false ⇒ inadmissible", () => {
    expect(scoreCandidate({ ...HARD_OK, regressionGreen: false }, SOFT_NONE).admissible).toBe(false)
  })

  it("PAIRED control: regressionGreen=null (fail-open) ⇒ STILL admissible", () => {
    expect(scoreCandidate({ ...HARD_OK, regressionGreen: null }, SOFT_NONE).admissible).toBe(true)
  })

  it("baseValidatedRed=null (no-oracle mode) ⇒ admissible", () => {
    expect(scoreCandidate({ ...HARD_OK, baseValidatedRed: null }, SOFT_NONE).admissible).toBe(true)
  })

  it("baseValidatedRed=false ⇒ inadmissible", () => {
    expect(scoreCandidate({ ...HARD_OK, baseValidatedRed: false }, SOFT_NONE).admissible).toBe(
      false,
    )
  })

  it("patchProduced=false ⇒ inadmissible", () => {
    expect(scoreCandidate({ ...HARD_OK, patchProduced: false }, SOFT_NONE).admissible).toBe(false)
  })

  it("applyClean=false ⇒ inadmissible", () => {
    expect(scoreCandidate({ ...HARD_OK, applyClean: false }, SOFT_NONE).admissible).toBe(false)
  })

  it("patchedResolvedKofN votes<k ⇒ inadmissible; votes>=k ⇒ admissible", () => {
    expect(
      scoreCandidate({ ...HARD_OK, patchedResolvedKofN: { votes: 1, k: 2 } }, SOFT_NONE).admissible,
    ).toBe(false)
    expect(
      scoreCandidate({ ...HARD_OK, patchedResolvedKofN: { votes: 2, k: 2 } }, SOFT_NONE).admissible,
    ).toBe(true)
  })

  it("ALL nullable signals null (base/apply true) ⇒ admissible (fail-open self-harm proof)", () => {
    const hard: HardGateSignals = {
      baseValidatedRed: true,
      patchProduced: true,
      patchedResolvedKofN: null,
      regressionGreen: null,
      applyClean: null,
    }
    expect(scoreCandidate(hard, SOFT_NONE).admissible).toBe(true)
  })
})

describe("scoreCandidate — soft score", () => {
  it("more/higher soft signals ⇒ strictly higher score", () => {
    const low = scoreCandidate(HARD_OK, { ...SOFT_NONE, rubricScore: 0.2 }).score
    const high = scoreCandidate(HARD_OK, {
      ...SOFT_NONE,
      rubricScore: 0.9,
      declaredExpectedMatch: true,
    }).score
    expect(high).toBeGreaterThan(low)
  })

  it("null soft signals contribute 0 (absent data is not punished as 0-value)", () => {
    // Only minimality present; score == its weight*value, nothing subtracted.
    const v = scoreCandidate(HARD_OK, { ...SOFT_NONE, minimality: 1 })
    expect(v.score).toBeGreaterThan(0)
    expect(v.reasons.some((r) => r.startsWith("soft:minimality"))).toBe(true)
  })

  it("M14: boolean soft `true` contributes its FULL weight (not 0 / inverted)", () => {
    // exact-value teeth — a `v ? 1 : 0` → `v ? 0 : 1` mutation must go RED.
    const s = scoreCandidate(HARD_OK, { ...SOFT_NONE, declaredExpectedMatch: true }).score
    expect(s).toBeCloseTo(0.25) // SOFT_WEIGHTS.declaredExpectedMatch
  })

  it("boolean soft `false` is PRESENT (listed in reasons) but contributes 0", () => {
    const v = scoreCandidate(HARD_OK, { ...SOFT_NONE, declaredExpectedMatch: false })
    expect(v.score).toBe(0)
    expect(v.reasons.some((r) => r.startsWith("soft:declaredExpectedMatch"))).toBe(true)
  })

  it("out-of-range / non-finite soft numbers are clamped/dropped (no score corruption)", () => {
    // rubricScore=5 must not drown everything (clamp to 1 ⇒ contributes its weight)
    expect(scoreCandidate(HARD_OK, { ...SOFT_NONE, rubricScore: 5 }).score).toBeCloseTo(0.2)
    // NaN ⇒ dropped (null), score stays 0 and finite
    expect(scoreCandidate(HARD_OK, { ...SOFT_NONE, rubricScore: Number.NaN }).score).toBe(0)
  })
})

describe("selectBest / selectBestEffort", () => {
  const cand = (id: string, admissible: boolean, score: number): ScoredCandidate => ({
    id,
    verdict: { admissible, score, reasons: [] },
  })

  it("picks the highest-scoring ADMISSIBLE candidate", () => {
    const cands = [cand("a", true, 0.3), cand("b", true, 0.7), cand("c", false, 0.99)]
    expect(selectBest(cands)).toBe("b") // c has higher score but is inadmissible
  })

  it("returns null when NONE is admissible", () => {
    expect(selectBest([cand("a", false, 0.9), cand("b", false, 0.5)])).toBeNull()
  })

  it("selectBestEffort ignores admissibility (used as the no-admissible fallback)", () => {
    const cands = [cand("a", false, 0.9), cand("b", false, 0.5)]
    expect(selectBest(cands)).toBeNull()
    expect(selectBestEffort(cands)).toBe("a")
  })

  it("ties broken by first appearance", () => {
    expect(selectBest([cand("a", true, 0.5), cand("b", true, 0.5)])).toBe("a")
  })

  it("empty input ⇒ null", () => {
    expect(selectBest([])).toBeNull()
    expect(selectBestEffort([])).toBeNull()
  })
})
