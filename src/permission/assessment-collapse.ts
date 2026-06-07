/**
 * Guardian per-action assessment → `ApprovalDecision` collapse (ADR-0497,
 * jun-7-misc 03).
 *
 * THE SINGLE BOUNDARY. A richer guardian assessor (ticket §3.2, Codex 0.135
 * parity) emits a typed {@link ActionAssessment}; this module reduces it to the
 * standard 8-state {@link ApprovalDecision} the rest of the system already
 * consumes. Everything downstream of `collapseAssessment` — the `outcome.ts`
 * matrix, `reviewer.ts` dispatch, `admissibility-gate.ts` allow/deny/steer/HITL
 * routing — is UNCHANGED. The new type never reaches a legacy consumer.
 *
 * SAFETY — the load-bearing invariant (ticket §5):
 *   1. TOTAL + CONSERVATIVE. The switch is exhaustive (`never` default at
 *      compile time). But compile-time totality is not enough: an UNKNOWN /
 *      future / malformed-but-typed kind reaching this fn at RUNTIME falls to
 *      the MOST-RESTRICTIVE outcome — `guardian_denied` (fail-closed), exactly
 *      like `reviewer-subagent.ts:fallbackDecision`. NEVER `allow`.
 *   2. ALLOW is the narrow set. Only `allow` / `allow_for_session` collapse to
 *      an allow outcome. Every other variant collapses to AT LEAST `ask`, by
 *      default `guardian_denied`.
 *   3. `allow_with_edit` NEVER degrades to "allow-original". The guardian's
 *      corrected input is a counter-proposal; the conservative collapse turns it
 *      into a `guardian_denied` + `reject_and_tell` steer (the edit becomes a
 *      steering suggestion). The ORIGINAL input is never executed. Threading the
 *      edit through the executor would require a NEW reviewer→input-mutation hop
 *      (the gate's `onInputMutation` sink fires in the pre_tool_use hook stage,
 *      AFTER the reviewer verdict — ticket §9.2); until that hop exists, the
 *      ONLY safe collapse is deny-with-steer.
 *   4. `allow_for_session` does NOT widen to a session-wide grant. A MACHINE
 *      assessor's sticky-allow is a strictly bigger grant than one-shot; the
 *      conservative collapse is one-shot `guardian_approved`. (The matrix also
 *      forbids `guardian_subagent` from owning `user_approved_for_session`, so a
 *      session-collapse would THROW — see §5.)
 *   5. `escalate` NEVER auto-grants. The default collapse is a forced `ask`
 *      (HITL); a sandbox/policy auto-grant is a separate opt-in (deferred).
 *
 * The collapse output is fed through `buildDecision`, so any (reviewer, outcome)
 * pair it produces that violates the `ADMISSIBLE` matrix THROWS
 * `OutcomeInvariantError` — the matrix is the second line of defense behind this
 * switch (ticket §5, §7 "matrix second-line").
 *
 * Slice rules: pure value module. Imports only slice-local `./outcome`,
 * `./review-kind`, `./types`. No IO, no `Date.now`/`Math.random`/`process.env`.
 */

import { buildDecision } from "./outcome"
import type { ReviewDecision } from "./review-kind"
import type { ActionAssessment, ApprovalDecision } from "./types"

/** The reviewer tier an assessment always belongs to — the assessor is the
 *  guardian. Fixed so the collapse never produces a (reviewer, outcome) pair
 *  the matrix forbids for a different tier. */
const ASSESSMENT_REVIEWER = "guardian_subagent" as const

/** Build the reject-and-tell verb carried by the steered-deny collapses. */
const steerVerb = (message: string): ReviewDecision => ({
  verb: "reject_and_tell",
  message,
})

/**
 * Collapse a typed {@link ActionAssessment} into the standard
 * {@link ApprovalDecision}. The single boundary; conservative + total.
 *
 * `decidedAt` is caller-provided (pure — never reads the wall clock). The
 * unknown-kind runtime fallback (defense beyond compile-time `never`) is
 * `guardian_denied`, mirroring `fallbackDecision`.
 */
export const collapseAssessment = (
  assessment: ActionAssessment,
  decidedAt: number,
): ApprovalDecision => {
  switch (assessment.kind) {
    case "allow":
      return buildDecision({
        reviewer: ASSESSMENT_REVIEWER,
        outcome: "guardian_approved",
        riskLevel: assessment.riskLevel,
        rationale: assessment.rationale,
        decidedAt,
      })
    case "allow_for_session":
      // CONSERVATIVE: a machine assessor's session-allow collapses to a one-shot
      // guardian_approved, NOT user_approved_for_session. Widening authority to
      // session scope from a machine verdict is a separate, stricter opt-in
      // (ticket §5/§9.1); the matrix would also THROW on
      // (guardian_subagent, user_approved_for_session).
      return buildDecision({
        reviewer: ASSESSMENT_REVIEWER,
        outcome: "guardian_approved",
        riskLevel: "high",
        rationale: assessment.rationale,
        decidedAt,
      })
    case "allow_with_edit":
      // NEVER allow-original. The corrected input is a counter-proposal; until a
      // reviewer→executor input-mutation hop exists, the only safe collapse is a
      // steered DENY (the edit becomes the steer message; original never runs).
      return buildDecision({
        reviewer: ASSESSMENT_REVIEWER,
        outcome: "guardian_denied",
        riskLevel: "high",
        rationale: assessment.rationale,
        decidedAt,
        verb: steerVerb(assessment.steer),
      })
    case "ask":
      // Forced HITL: an uncertain guardian escalates to the operator. There is
      // no `ask`-shaped ApprovalOutcome the guardian tier may own, so the
      // conservative collapse is fail-closed guardian_denied with a steer that
      // names the escalation. The composition wiring routes an `ask` to the
      // onConfirm/HITL handshake BEFORE collapse where that seam exists; absent
      // it, deny-with-steer is the safe floor (never a silent allow).
      return buildDecision({
        reviewer: ASSESSMENT_REVIEWER,
        outcome: "guardian_denied",
        riskLevel: "high",
        rationale: assessment.rationale,
        decidedAt,
        verb: steerVerb("guardian is uncertain — operator review required before this action"),
      })
    case "deny":
      return buildDecision({
        reviewer: ASSESSMENT_REVIEWER,
        outcome: "guardian_denied",
        riskLevel: "high",
        rationale: assessment.rationale,
        decidedAt,
      })
    case "deny_and_steer":
      return buildDecision({
        reviewer: ASSESSMENT_REVIEWER,
        outcome: "guardian_denied",
        riskLevel: "high",
        rationale: assessment.rationale,
        decidedAt,
        verb: steerVerb(assessment.steer),
      })
    case "escalate":
      // NEVER auto-grant. Default collapse = forced ask-the-human → fail-closed
      // guardian_denied with a categorical steer naming the requested axis. A
      // sandbox/policy auto-grant is a separately-gated opt-in (deferred).
      return buildDecision({
        reviewer: ASSESSMENT_REVIEWER,
        outcome: "guardian_denied",
        riskLevel: "high",
        rationale: assessment.rationale,
        decidedAt,
        verb: steerVerb(
          `guardian requests a ${assessment.escalation.axis} policy amendment — operator review required (no auto-grant)`,
        ),
      })
    default: {
      // Compile-time exhaustiveness. If a new ActionAssessment variant is added
      // without a case above, this fails to compile.
      const _exhaustive: never = assessment
      // RUNTIME defense-in-depth: an unknown/version-skew kind that slipped past
      // the type system (e.g. a malformed assessor reply decoded loosely) falls
      // to the most-restrictive outcome — fail-closed deny, NEVER allow.
      return buildDecision({
        reviewer: ASSESSMENT_REVIEWER,
        outcome: "guardian_denied",
        riskLevel: "high",
        rationale: `guardian assessor returned an unknown assessment kind: ${String(
          (_exhaustive as { kind?: unknown } | undefined)?.kind,
        )}`,
        decidedAt,
      })
    }
  }
}
