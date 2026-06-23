/**
 * ★ P4 HELLGATE — proof-gate GOLD-calibrated FAIL-OPEN (Defect 2).
 *
 * MEASURED ROOT CAUSE (jun-23): `agentless-v4-proof-clean` scored 0/3. The hard
 * proof-required gate (`verify-select-proof-required:1`) was built on a repro
 * oracle that is a 75% gold FALSE-NEGATIVE — applying the canonical-correct GOLD
 * fix left the reproducing repros RED 3/4 of the time (django-11138 / 14315
 * replay). A broken oracle that can never print "Issue resolved" makes
 * `applyProofRequiredHardGate` WITHHOLD every candidate ⇒ empty patch. The soft
 * `resolvedKofN` selection port already fail-opened on a gold-FN oracle
 * (`makeCalibratedReproConsensusPort`); the HARD proof gate did NOT.
 *
 * THE FIX (this proves it): {@link computeEffectiveProofRequired} LIFTS
 * proofRequired for an instance whose CANONICAL oracle is a CONFIRMED gold
 * false-negative — a proven-broken oracle must never hold hard submit authority.
 * This is the EXACT decision the selection phase makes (the function is consumed
 * inline in `runSelectionPhase`; reverting it re-withholds correct fixes).
 *
 * Teeth (mutation-grade — each pins a distinct edge of the decision):
 *   1. gold-FN + proofRequired ⇒ FAIL-OPEN (effectiveProofRequired=false). This
 *      is THE fix; without the `!proofGateFailOpen` term it would stay true and
 *      the correct fix is withheld.
 *   2. trustworthy oracle + proofRequired ⇒ gate STAYS active (no blanket
 *      disable — paired control that makes #1 non-vacuous).
 *   3. UNAVAILABLE calibration (no gold / inert) ⇒ gate STAYS active (we fail
 *      open ONLY on a CONFIRMED false-negative, never on a no-claim).
 *   4. proofRequired=false ⇒ effective stays false regardless of calibration
 *      (off-switch is honored; calibration can't turn the gate ON).
 */

import { describe, expect, test } from "bun:test"
import { computeEffectiveProofRequired } from "@/runner/batch/eval/driver"
import type { ReproOracleCalibration } from "@/runner/batch/types"

// A CONFIRMED gold false-negative: gold applied but the canonical oracle did NOT
// report resolved (goldVotes < goldK) — its verdict on candidates is untrustworthy.
const GOLD_FALSE_NEGATIVE: ReproOracleCalibration = {
  goldCalibrated: false,
  falseNegative: true,
  available: true,
  goldVotes: 0,
  goldK: 3,
}

// A TRUSTWORTHY oracle: gold flipped it green (unanimous), so its rejections mean
// something — the proof gate should keep its authority.
const TRUSTWORTHY: ReproOracleCalibration = {
  goldCalibrated: true,
  falseNegative: false,
  available: true,
  goldVotes: 3,
  goldK: 3,
}

// No claim — off-bench (no gold) or no reproducing canonical set. NOT a
// false-negative; the gate must not fail open on an absence of evidence.
const UNAVAILABLE: ReproOracleCalibration = {
  goldCalibrated: false,
  falseNegative: false,
  available: false,
  goldVotes: null,
  goldK: null,
}

describe("computeEffectiveProofRequired — P4 proof-gate fail-open", () => {
  test("gold-FN + proofRequired ⇒ FAIL-OPEN (the correct fix is no longer withheld)", () => {
    const d = computeEffectiveProofRequired(true, GOLD_FALSE_NEGATIVE)
    expect(d.proofGateFailOpen).toBe(true)
    expect(d.effectiveProofRequired).toBe(false)
  })

  test("trustworthy oracle + proofRequired ⇒ gate STAYS active (paired control)", () => {
    const d = computeEffectiveProofRequired(true, TRUSTWORTHY)
    expect(d.proofGateFailOpen).toBe(false)
    expect(d.effectiveProofRequired).toBe(true)
  })

  test("UNAVAILABLE calibration ⇒ gate STAYS active (fail open only on CONFIRMED FN)", () => {
    const d = computeEffectiveProofRequired(true, UNAVAILABLE)
    expect(d.proofGateFailOpen).toBe(false)
    expect(d.effectiveProofRequired).toBe(true)
  })

  test("proofRequired=false ⇒ effective stays false; calibration can't turn the gate ON", () => {
    for (const cal of [GOLD_FALSE_NEGATIVE, TRUSTWORTHY, UNAVAILABLE]) {
      const d = computeEffectiveProofRequired(false, cal)
      expect(d.effectiveProofRequired).toBe(false)
      expect(d.proofGateFailOpen).toBe(false)
    }
  })

  // Mutation sentinel: the ONLY difference between #1 and #2 is the calibration's
  // `falseNegative` bit under identical `proofRequired=true`. If the fail-open
  // term were dropped (effective := proofRequired), both would be true — this
  // asserts they DIVERGE, which is exactly what the structural fix guarantees.
  test("the decision DIVERGES on falseNegative alone (mutation sentinel)", () => {
    const fn = computeEffectiveProofRequired(true, GOLD_FALSE_NEGATIVE).effectiveProofRequired
    const ok = computeEffectiveProofRequired(true, TRUSTWORTHY).effectiveProofRequired
    expect(fn).not.toBe(ok)
  })
})
