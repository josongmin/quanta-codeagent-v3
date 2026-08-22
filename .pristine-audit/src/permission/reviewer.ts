/**
 * Reviewer dispatcher (ADR-0029).
 *
 * Pure logic. Selects which `ReviewerPort` method to invoke for a given
 * action, honoring:
 *   1. Sticky post-denial precedence — a prior `guardian_denied` or
 *      `user_aborted` for the same `actionKey` short-circuits review.
 *      Guardian-denial trumps an auto/user approval attempt; user-abort
 *      trumps everything (operator pressed cancel for the whole turn).
 *   2. `ctx.configReviewer` selects the dispatch path (3-tier enum).
 *
 * Slice rules: this module imports only `./types` and `./outcome`. It does
 * NOT call the network, the LLM, or any IO — that is the port's job.
 *
 * Error model (no fallbacks):
 *   - Missing port method ⇒ `ReviewerUnavailableError`.
 *   - Port returns a decision whose reviewer/outcome violate the invariant
 *     matrix ⇒ surfaced as `OutcomeInvariantError` (validated via
 *     `buildDecision`).
 *   - Two priorDenials disagree on the same actionKey (e.g. one
 *     guardian_denied AND one user_aborted with different reviewers)
 *     ⇒ `DenialPrecedenceConflictError` ONLY when the records contradict
 *     each other on `outcome`; identical-but-duplicate records are deduped.
 */

import { emitOperatorNotice } from "@/shared"
import { runtimeConfig } from "@/shared/runtime-config"
import { collapseAssessment } from "./assessment-collapse"
import {
  emitAutoApprovalReview,
  hasAutoApprovalReviewObserver,
} from "./auto-approval-review-observer"
import { buildDecision, isAdmissible, isAllowed } from "./outcome"
import { emitPermissionDecision, type PermissionOutcomeLabel } from "./recorder"
import type {
  ApprovalDecision,
  ApprovalOutcome,
  DenialMemory,
  ReviewContext,
  ReviewerPort,
  ReviewerTier,
  ToolActionKeyed,
} from "./types"

/** Thrown when the injected ReviewerPort cannot service the requested tier
 *  (method is missing or non-callable). The reviewer module never silently
 *  degrades — the caller must either supply a complete port or pick a
 *  different `configReviewer`. */
export class ReviewerUnavailableError extends Error {
  readonly reviewer: ReviewerTier
  constructor(reviewer: ReviewerTier) {
    super(`ReviewerUnavailableError: port has no callable method for reviewer=${reviewer}`)
    this.name = "ReviewerUnavailableError"
    this.reviewer = reviewer
  }
}

/** Thrown when two prior-denial records target the same actionKey but
 *  disagree on outcome. The reviewer cannot pick a precedence safely in
 *  this case; the caller must reconcile the memory store. */
export class DenialPrecedenceConflictError extends Error {
  readonly actionKey: string
  readonly a: DenialMemory
  readonly b: DenialMemory
  constructor(a: DenialMemory, b: DenialMemory) {
    super(
      `DenialPrecedenceConflictError: actionKey=${a.actionKey} has conflicting denials ` +
        `(${a.outcome} by ${a.reviewer} vs ${b.outcome} by ${b.reviewer})`,
    )
    this.name = "DenialPrecedenceConflictError"
    this.actionKey = a.actionKey
    this.a = a
    this.b = b
  }
}

/** Outcomes that constitute a "denial" for sticky-precedence purposes. The
 *  set is explicit (not derived from `isAllowed`) because the precedence
 *  rules diverge from the allow/deny truth table — e.g. `user_aborted` is
 *  stickier than `user_denied` even though both are "not allowed". */
const STICKY_OUTCOMES = new Set<DenialMemory["outcome"]>([
  "guardian_denied",
  "user_denied",
  "user_aborted",
])

/** Strength ordering for sticky-precedence resolution. Higher wins; ties
 *  are checked for contradiction. `user_aborted` > `guardian_denied` >
 *  `user_denied`. */
const STICKY_RANK: Readonly<Record<DenialMemory["outcome"], number>> = {
  user_aborted: 3,
  guardian_denied: 2,
  user_denied: 1,
  // Non-sticky outcomes — defensive entries so the lookup is total.
  not_needed: 0,
  config_allowed: 0,
  guardian_approved: 0,
  user_approved: 0,
  user_approved_for_session: 0,
}

/** Pick the strongest sticky-denial record for the given actionKey, or
 *  null if none applies. Throws `DenialPrecedenceConflictError` only when
 *  two records share the strongest rank with different (reviewer, outcome)
 *  tuples — that is a genuine ambiguity. */
const pickStickyDenial = (
  actionKey: string,
  priorDenials: ReadonlyArray<DenialMemory>,
): DenialMemory | null => {
  const matches = priorDenials.filter(
    (d) => d.actionKey === actionKey && STICKY_OUTCOMES.has(d.outcome),
  )
  if (matches.length === 0) return null
  let strongest: DenialMemory = matches[0] as DenialMemory
  for (let i = 1; i < matches.length; i++) {
    const candidate = matches[i] as DenialMemory
    const candidateRank = STICKY_RANK[candidate.outcome]
    const strongestRank = STICKY_RANK[strongest.outcome]
    if (candidateRank > strongestRank) {
      strongest = candidate
    } else if (
      candidateRank === strongestRank &&
      (candidate.outcome !== strongest.outcome || candidate.reviewer !== strongest.reviewer)
    ) {
      throw new DenialPrecedenceConflictError(strongest, candidate)
    }
  }
  return strongest
}

/** Re-synthesize an ApprovalDecision from a sticky-denial record so the
 *  caller receives a uniform shape regardless of whether the decision was
 *  newly rendered or replayed from memory. */
const replayDenial = (denial: DenialMemory, decidedAt: number): ApprovalDecision => {
  if (!isAdmissible(denial.reviewer, denial.outcome)) {
    // The denial memory itself violates the matrix — surface as invariant
    // error via buildDecision (which throws OutcomeInvariantError).
    return buildDecision({
      reviewer: denial.reviewer,
      outcome: denial.outcome,
      riskLevel: "high",
      rationale: `sticky precedence replay (${denial.outcome} by ${denial.reviewer} at ${denial.deniedAt})`,
      decidedAt,
    })
  }
  return buildDecision({
    reviewer: denial.reviewer,
    outcome: denial.outcome,
    riskLevel: "high",
    rationale: `sticky precedence replay (${denial.outcome} by ${denial.reviewer} at ${denial.deniedAt})`,
    decidedAt,
  })
}

/** Verify the port exposes a callable method for the requested reviewer
 *  BEFORE invoking it. Missing methods raise `ReviewerUnavailableError`.
 *
 *  jun-7-misc 03 (ADR-0497, R2 hole-fix): for the `guardian_subagent` tier the
 *  richer `guardianAssess` is an ALTERNATIVE servicer to the binary
 *  `guardianReview` — `dispatchFresh` routes to it when (and only when) the
 *  `QUANTA_GUARDIAN_ASSESSOR` knob is strictly on. So a composition that wires
 *  the assessor as the guardian path MAY omit `guardianReview`; the availability
 *  pre-check must accept EITHER servicer the SAME way `dispatchFresh` selects
 *  one, or it would throw `ReviewerUnavailableError` before the assessor is ever
 *  reached. The knob-gated `guardianAssess` acceptance EXACTLY mirrors the
 *  dispatch branch — absent the knob (every OFF path) the check is the verbatim
 *  legacy 3-way method probe (byte-identical: an assessor-only port still fails
 *  closed with `ReviewerUnavailableError`, never silently falling through). */
const assertReviewerAvailable = (reviewer: ReviewerTier, port: ReviewerPort): void => {
  if (reviewer === "user") {
    if (typeof port.userReview !== "function") throw new ReviewerUnavailableError(reviewer)
    return
  }
  if (reviewer === "auto_review") {
    if (typeof port.autoReview !== "function") throw new ReviewerUnavailableError(reviewer)
    return
  }
  // guardian_subagent: the assessor is a valid servicer ONLY under the strict
  // knob — identical predicate to `dispatchFresh`. Otherwise require the binary
  // guardianReview, exactly as today.
  const assessorServices =
    typeof port.guardianAssess === "function" && runtimeConfig().guardianAssessor
  if (assessorServices) return
  if (typeof port.guardianReview !== "function") throw new ReviewerUnavailableError(reviewer)
}

/** Validate a port-supplied decision against the invariant matrix. Throws
 *  `OutcomeInvariantError` via `buildDecision` if invalid. Preserves the
 *  optional ADR-0070 review-kind verb when present (the gate validates the
 *  verb against `ctx.reviewKind` itself — the reviewer module stays orthogonal
 *  to the WHAT-IS-BEING-REVIEWED axis). */
const validateDecision = (decision: ApprovalDecision): ApprovalDecision =>
  buildDecision({
    reviewer: decision.reviewer,
    outcome: decision.outcome,
    riskLevel: decision.riskLevel,
    rationale: decision.rationale,
    decidedAt: decision.decidedAt,
    ...(decision.verb !== undefined ? { verb: decision.verb } : {}),
  })

/** Map an 8-state {@link ApprovalOutcome} to one of the four canonical
 *  decision counter labels for OTel emit. Sticky-precedence replay and
 *  fresh reviewer decisions BOTH route through this — the counter has
 *  one row per terminal outcome regardless of provenance.
 *
 *  - `user_*` allows where the operator explicitly clicked "approve" map
 *    to `"trust"` (the operator paid the cognitive cost of consenting).
 *  - `not_needed` / `config_allowed` / `guardian_approved` map to `"allow"`
 *    (the gate cleared without operator intervention).
 *  - All deny / abort outcomes map to `"deny"`. */
const outcomeToLabel = (outcome: ApprovalOutcome): PermissionOutcomeLabel => {
  if (outcome === "user_approved" || outcome === "user_approved_for_session") return "trust"
  if (isAllowed(outcome)) return "allow"
  return "deny"
}

/** Emit one reviewer-tier decision through the recorder seam. No-op when
 *  no recorder is registered. SECURITY: the only attribute values that
 *  reach the recorder here are categorical (reviewerTier / outcome /
 *  riskLevel / decidedBy). The `rationale` field is intentionally NOT
 *  plumbed through — it is free-form text that may quote operator notes
 *  / model output and is owned by the audit log, not the metric layer. */
const emitReviewerDecision = (decision: ApprovalDecision): void => {
  const label = outcomeToLabel(decision.outcome)
  emitPermissionDecision({
    outcome: label,
    reviewerTier: decision.reviewer,
    riskLevel: decision.riskLevel,
    decidedBy: "reviewer",
  })
}

/** Dispatch a FRESH (non-replayed) decision to the configured reviewer.
 *
 *  jun-7-misc 03 (ADR-0497): when the active tier is `guardian_subagent`, the
 *  port exposes the OPTIONAL richer `guardianAssess`, AND the
 *  `QUANTA_GUARDIAN_ASSESSOR` knob is strictly on, the guardian renders a typed
 *  {@link ActionAssessment} that `collapseAssessment` reduces to the standard
 *  `ApprovalDecision` (the single boundary). The richer call REPLACES the binary
 *  `guardianReview` for that one verdict — it is the SAME guardian round-trip
 *  with a richer reply shape, not an extra LLM pass (ticket §9.3).
 *
 *  DEFAULT-OFF BYTE-IDENTITY: absent the method (every current impl) OR with the
 *  knob off, this is the EXACT legacy 3-way dispatch — `guardianAssess` is never
 *  called and `collapseAssessment` is never reached. */
const dispatchFresh = async (
  action: ToolActionKeyed,
  ctx: ReviewContext,
  port: ReviewerPort,
): Promise<ApprovalDecision> => {
  if (ctx.configReviewer === "user") return port.userReview(action, ctx)
  if (ctx.configReviewer === "auto_review") return port.autoReview(action, ctx)
  // guardian_subagent tier.
  if (typeof port.guardianAssess === "function" && runtimeConfig().guardianAssessor) {
    const assessment = await port.guardianAssess(action, ctx)
    return collapseAssessment(assessment, ctx.decidedAt)
  }
  return port.guardianReview(action, ctx)
}

/** Main entry point. Resolves sticky precedence, then dispatches to the
 *  configured reviewer. Returns a validated `ApprovalDecision`.
 *
 *  Throws (never returns a sentinel) on:
 *    - `DenialPrecedenceConflictError` — ambiguous priorDenials.
 *    - `ReviewerUnavailableError`     — port lacks the requested method.
 *    - `OutcomeInvariantError`        — port returned an invalid decision. */
export const reviewAction = async (
  action: ToolActionKeyed,
  ctx: ReviewContext,
  port: ReviewerPort,
): Promise<ApprovalDecision> => {
  const sticky = pickStickyDenial(action.actionKey, ctx.priorDenials)
  if (sticky !== null) {
    const replayed = replayDenial(sticky, ctx.decidedAt)
    emitReviewerDecision(replayed)
    return replayed
  }
  assertReviewerAvailable(ctx.configReviewer, port)
  // T03 — surface the AGENT reviewer's lifecycle so an auto-approval is never
  // invisible. Only the auto tiers emit (the `user` tier already has a visible
  // prompt). Default-OFF: no registered observer ⇒ both calls are no-ops.
  const isAutoTier =
    ctx.configReviewer === "guardian_subagent" || ctx.configReviewer === "auto_review"
  if (isAutoTier) {
    emitAutoApprovalReview({
      phase: "started",
      toolCallId: ctx.toolCallId,
      tool: action.tool,
      reviewer: ctx.configReviewer,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
    })
  }
  let validated: ApprovalDecision
  try {
    const fresh = await dispatchFresh(action, ctx, port)
    validated = validateDecision(fresh)
  } catch (err) {
    // A throwing port / invalid decision fails CLOSED at the gate. Close the
    // surface lifecycle with a terminal not-allowed `completed` (never leave a
    // dangling "reviewing…"), then re-throw so the gate's deny path is unchanged.
    if (isAutoTier) {
      emitAutoApprovalReview({
        phase: "completed",
        toolCallId: ctx.toolCallId,
        tool: action.tool,
        reviewer: ctx.configReviewer,
        allowed: false,
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
      })
    }
    throw err
  }
  emitReviewerDecision(validated)
  if (isAutoTier) {
    emitAutoApprovalReview({
      phase: "completed",
      toolCallId: ctx.toolCallId,
      tool: action.tool,
      reviewer: validated.reviewer,
      outcome: validated.outcome,
      allowed: isAllowed(validated.outcome),
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
    })
  }
  // UUX-1-21 — a guardian AUTO-approve (no human prompt) must never be
  // invisible. The typed observer above renders it when a surface registered
  // one (the CLI does so only under the approval-ladder opt-in) — but
  // `selectDefaultReviewer` can route to the guardian in the DEFAULT posture
  // too (per-thread `on-request` authority / legacy workspace-write fallback),
  // where NO observer exists. Fall back to the operator-notice bus in exactly
  // that case: observer registered ⇒ skip (no double-render); no sink
  // installed ⇒ emit is a no-op (headless/bench byte-identical). Denials are
  // intentionally excluded — they already surface via the gate's deny path.
  if (validated.outcome === "guardian_approved" && !hasAutoApprovalReviewObserver()) {
    emitOperatorNotice({
      severity: "info",
      source: "guardian",
      message: `guardian approved: ${action.tool}`,
      hint: "auto-approved without a prompt",
    })
  }
  return validated
}
