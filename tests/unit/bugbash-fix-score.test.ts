/**
 * Bugbash fixes — verification-bundle score core.
 *
 * #31: the `voterQuorum` soft signal arrives as the consensus RATIO `votes/k`,
 *      which is ≥1 at super-quorum. Before the fix the generic `softValue` clamp
 *      saturated every value ≥1 to exactly 1, so an exact-quorum candidate
 *      (votes=k ⇒ ratio 1) and a super-quorum candidate (votes=3k ⇒ ratio 3)
 *      produced an IDENTICAL voterQuorum term and could not be ranked apart.
 *      The fix squashes the ratio with `r/(r+1)` so super-quorum scores strictly
 *      higher than exact-quorum while staying < 1.
 */
import { describe, expect, test } from "bun:test"
import { scoreCandidate } from "../../src/agent/verification-bundle/score"
import type { HardGateSignals, SoftScoreSignals } from "../../src/agent/verification-bundle/types"

const passingHard = (): HardGateSignals => ({
  baseValidatedRed: true,
  patchProduced: true,
  patchedResolvedKofN: null,
  regressionGreen: true,
  smokeGreen: true,
  applyClean: true,
})

// Only voterQuorum present so the soft score is purely its (weighted) term.
const onlyVoterQuorum = (ratio: number | null): SoftScoreSignals => ({
  declaredExpectedMatch: null,
  rubricScore: null,
  voterQuorum: ratio,
  minimality: null,
  ownerCoverage: null,
})

describe("bugbash #31 — voterQuorum super-quorum stays distinguishable", () => {
  // TEETH: exact-quorum (votes=k ⇒ ratio 1) vs super-quorum (votes=3k ⇒ ratio 3)
  // MUST produce different scores. Reverting the fix (saturating clamp to 1) makes
  // both terms equal and collapses this assertion.
  test("exact-quorum and super-quorum produce DISTINCT scores", () => {
    const exact = scoreCandidate(passingHard(), onlyVoterQuorum(1))
    const superQ = scoreCandidate(passingHard(), onlyVoterQuorum(3))
    expect(superQ.score).not.toBe(exact.score)
    // Stronger consensus ⇒ strictly higher ranking credit.
    expect(superQ.score).toBeGreaterThan(exact.score)
  })

  // TEETH: the ratio is monotone-increasing in votes/k across the super-quorum
  // band — a 10× consensus outranks a 3× consensus outranks an exact quorum.
  test("voterQuorum term is monotone increasing above quorum", () => {
    const at1 = scoreCandidate(passingHard(), onlyVoterQuorum(1)).score
    const at3 = scoreCandidate(passingHard(), onlyVoterQuorum(3)).score
    const at10 = scoreCandidate(passingHard(), onlyVoterQuorum(10)).score
    expect(at3).toBeGreaterThan(at1)
    expect(at10).toBeGreaterThan(at3)
  })

  // The squashed term stays bounded < the weight (i.e. value < 1) even as the
  // ratio grows large, so it never out-weighs its configured 0.2 contribution.
  test("super-quorum term stays bounded below its full weight", () => {
    const huge = scoreCandidate(passingHard(), onlyVoterQuorum(1_000_000)).score
    // weight is 0.2; r/(r+1) < 1 ⇒ contribution strictly < 0.2.
    expect(huge).toBeLessThan(0.2)
    expect(huge).toBeGreaterThan(0.19)
  })

  // Sub-quorum (ratio < 1) stays ordered and inside [0,1) — it is never inflated.
  test("sub-quorum ratios stay ordered below exact-quorum", () => {
    const half = scoreCandidate(passingHard(), onlyVoterQuorum(0.5)).score
    const exact = scoreCandidate(passingHard(), onlyVoterQuorum(1)).score
    expect(half).toBeLessThan(exact)
    expect(half).toBeGreaterThan(0)
  })

  // Null voterQuorum (the DEFAULT hard-mode path) contributes nothing — the
  // squash must not invent credit from a missing signal.
  test("null voterQuorum contributes zero (default-mode byte-identical)", () => {
    const none = scoreCandidate(passingHard(), onlyVoterQuorum(null))
    expect(none.score).toBe(0)
    expect(none.reasons).not.toContain("soft:voterQuorum=null")
  })

  // Non-finite / negative ratios defer to the generic coercion (dropped / 0),
  // never NaN-poison the order-dependent comparison.
  test("non-finite and negative voterQuorum are coerced safely", () => {
    expect(scoreCandidate(passingHard(), onlyVoterQuorum(Number.NaN)).score).toBe(0)
    expect(scoreCandidate(passingHard(), onlyVoterQuorum(Number.POSITIVE_INFINITY)).score).toBe(0)
    const neg = scoreCandidate(passingHard(), onlyVoterQuorum(-5)).score
    expect(neg).toBe(0)
  })
})
