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

import { buildDecision, isAdmissible } from "./outcome"
import type {
  ApprovalDecision,
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
 *  BEFORE invoking it. Missing methods raise `ReviewerUnavailableError`. */
const assertReviewerAvailable = (reviewer: ReviewerTier, port: ReviewerPort): void => {
  const method =
    reviewer === "user"
      ? port.userReview
      : reviewer === "auto_review"
        ? port.autoReview
        : port.guardianReview
  if (typeof method !== "function") {
    throw new ReviewerUnavailableError(reviewer)
  }
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
    return replayDenial(sticky, ctx.decidedAt)
  }
  assertReviewerAvailable(ctx.configReviewer, port)
  const fresh =
    ctx.configReviewer === "user"
      ? await port.userReview(action, ctx)
      : ctx.configReviewer === "auto_review"
        ? await port.autoReview(action, ctx)
        : await port.guardianReview(action, ctx)
  return validateDecision(fresh)
}
