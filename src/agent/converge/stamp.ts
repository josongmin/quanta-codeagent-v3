/**
 * `@/apps/terminal/verify-gate/stamp` — the honest verification trichotomy the report carries and
 * the pure classifier that derives it from the L1 compare verdict + the model's final stated outcome.
 *
 * `verified-pass` is UNREACHABLE without an OBSERVED L1 comparison (this closes v1's rubber-stamp,
 * which stamped `verified-pass` on a mere L0 run). PURE / LEAF.
 */

import type { CompareVerdict } from "./compare"
import type { ExerciseVerdict } from "./exercise"

/** The honest trichotomy the report stamps (v2 semantics). `verified-pass` / `verified-fail` both
 *  mean an OBSERVED L1 comparison happened (output diffed/checked against a non-test reference) and
 *  the result was match / mismatch respectively; `unverifiable` means no fair L1 comparison was
 *  found even after the one bounded follow-up — the accepted, non-penalized terminal state that
 *  STRUCTURALLY prevents over-persistence, and the state that (post-v2) a mere ran-but-unchecked
 *  run resolves to (never a false `verified-pass`). */
export type VerificationState = "verified-pass" | "verified-fail" | "unverifiable"

/** The report's verification stamp. `evidence` names only the model's own trajectory / stated
 *  outcome — never a hidden test. */
export interface VerificationStamp {
  readonly state: VerificationState
  readonly evidence: string
  /** Whether the one bounded follow-up turn was actually injected (vs an exercise already present
   *  in the main run). Lets per-task A/B analysis attribute a flip to the gate's nudge rather than
   *  the base loop. Absent on the OFF path (the whole stamp is absent then). */
  readonly followUpFired?: boolean
}

/**
 * Outcome classification of the model's final SAY. ORDER MATTERS: UNCERTAIN → NEGATIVE → (else)
 * positive/silent. HONESTY over optimism — an explicit uncertainty or stated failure is trusted
 * over a co-occurring positive word, because "fake green" is precisely the failure of trusting an
 * optimistic self-report. SUCCESS-BY-NEGATION ("does not fail", "no errors") is suppressed by
 * {@link NEGATED_NEGATIVE} so it is NOT mis-read as `verified-fail`.
 */
const UNCERTAIN_OUTCOME =
  /\b(could ?n['o]?t verify|cannot verify|can['o]?t verify|unable to verify|unverifiable|not (?:sure|certain)|unclear|no way to (?:verify|check)|couldn['o]?t (?:confirm|check|run))\b/i
/** A failure the agent OBSERVED (not a hypothetical). */
const NEGATIVE_OUTCOME =
  /\b(fail(?:ed|s|ing|ure)?|did ?n['o]?t (?:pass|match|work)|does ?n['o]?t (?:pass|match|work)|mismatch(?:ed|es)?|do(?:es)? not match|incorrect|wrong output|error(?:ed|s)?)\b/i
/** Success expressed by NEGATING a negative — these must NOT trip {@link NEGATIVE_OUTCOME}. */
const NEGATED_NEGATIVE =
  /\b(no (?:errors?|failures?|mismatch(?:es)?|diff(?:erences?)?)|without (?:error|failure)|does ?n['o]?t fail|did ?n['o]?t fail|zero (?:errors?|failures?))\b/i

/**
 * v2 GATE POLICY (RFC jul-2 §03) — derive the honest verification state from the (post-follow-up)
 * L1 COMPARE verdict + the model's final stated outcome. `verified-pass` is UNREACHABLE without an
 * OBSERVED L1 comparison. NEVER over-persists (the caller fires at most one follow-up; this is a
 * pure classifier):
 *   - L1 present + agent reports mismatch/uncertain ⇒ `verified-fail` / `unverifiable` (honest).
 *   - L1 present + agent reports match / silent     ⇒ `verified-pass` (the ONLY path to pass).
 *   - No L1 (ran but never compared, or nothing ran) ⇒ `unverifiable` (honest — never a false pass).
 *
 * The exercise (L0) verdict is retained ONLY to color the evidence line (ran-but-unchecked vs
 * nothing-ran); it can NO LONGER by itself yield `verified-pass`.
 */
export const deriveVerificationState = (
  compareVerdict: CompareVerdict,
  finalText: string,
  exerciseVerdict?: ExerciseVerdict,
): VerificationStamp => {
  const evidence = compareVerdict.evidence ?? ""
  // No observed L1 comparison ⇒ unverifiable, whatever the model SAYS (the rubber-stamp is dead).
  if (!compareVerdict.compared) {
    const ran = exerciseVerdict?.exercised === true
    const reason = ran
      ? `ran the deliverable but never compared its output to a reference — ${evidence}`
      : evidence
    return { state: "unverifiable", evidence: `unverifiable — ${reason}` }
  }
  const text = finalText ?? ""
  if (UNCERTAIN_OUTCOME.test(text)) {
    return {
      state: "unverifiable",
      evidence: `compared, but the agent could not confirm the outcome; ${evidence}`,
    }
  }
  if (NEGATIVE_OUTCOME.test(text) && !NEGATED_NEGATIVE.test(text)) {
    return { state: "verified-fail", evidence: `compared and observed a mismatch; ${evidence}` }
  }
  return { state: "verified-pass", evidence }
}
