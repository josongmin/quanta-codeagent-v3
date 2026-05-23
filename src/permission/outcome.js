/**
 * Outcome state machine + invariants (ADR-0029).
 *
 * Pure module. Owns:
 *   - Truth tables for `isTerminal` / `isAllowed` / `requiresUserConfirmation`.
 *   - The (reviewer × outcome) invariant matrix enforced by `buildDecision`.
 *
 * The invariant matrix is the contract that lets every downstream consumer
 * read `ApprovalDecision` without re-validating it. Violations throw a
 * named error (`OutcomeInvariantError`) — no silent normalization, no
 * fallback. The reviewer module relies on this guarantee.
 */
/** All eight outcome literals, enumerated. Kept here as a runtime-visible
 *  constant for exhaustive testing without `as const` gymnastics. */
export const ALL_OUTCOMES = [
    "not_needed",
    "config_allowed",
    "guardian_approved",
    "guardian_denied",
    "user_approved",
    "user_approved_for_session",
    "user_denied",
    "user_aborted",
];
export const ALL_REVIEWERS = [
    "user",
    "auto_review",
    "guardian_subagent",
];
/** Named error thrown when `buildDecision` receives an invalid
 *  (reviewer, outcome) combination. */
export class OutcomeInvariantError extends Error {
    reviewer;
    outcome;
    constructor(reviewer, outcome, detail) {
        super(`OutcomeInvariantError [ADR-0029]: reviewer=${reviewer} outcome=${outcome} — ${detail}. ` +
            `A reviewer tier produced an outcome it may not own — see docs/decisions/0029-reviewer-three-tier.md.`);
        this.name = "OutcomeInvariantError";
        this.reviewer = reviewer;
        this.outcome = outcome;
    }
}
/** Every outcome literal IS a terminal decision — the eight-state union has
 *  no "pending" member by construction. Kept as a function (rather than
 *  `true` directly) so future refactors that add an intermediate state
 *  retain a single audit point. */
export const isTerminal = (outcome) => {
    switch (outcome) {
        case "not_needed":
        case "config_allowed":
        case "guardian_approved":
        case "guardian_denied":
        case "user_approved":
        case "user_approved_for_session":
        case "user_denied":
        case "user_aborted":
            return true;
        default: {
            // Exhaustiveness guard — if a new outcome is added without updating
            // this switch, the compiler flags it via `never`.
            const _exhaustive = outcome;
            throw new Error(`Unhandled outcome: ${String(_exhaustive)}`);
        }
    }
};
/** Approval truth table — the outcome explicitly authorizes execution. */
export const isAllowed = (outcome) => {
    switch (outcome) {
        case "not_needed":
        case "config_allowed":
        case "guardian_approved":
        case "user_approved":
        case "user_approved_for_session":
            return true;
        case "guardian_denied":
        case "user_denied":
        case "user_aborted":
            return false;
        default: {
            const _exhaustive = outcome;
            throw new Error(`Unhandled outcome: ${String(_exhaustive)}`);
        }
    }
};
/** Audit predicate — did a human render this approval? Used by the
 *  observability layer to distinguish "machine-approved" from "operator-
 *  approved" trajectories. */
export const requiresUserConfirmation = (outcome) => {
    switch (outcome) {
        case "user_approved":
        case "user_approved_for_session":
        case "user_denied":
        case "user_aborted":
            return true;
        case "not_needed":
        case "config_allowed":
        case "guardian_approved":
        case "guardian_denied":
            return false;
        default: {
            const _exhaustive = outcome;
            throw new Error(`Unhandled outcome: ${String(_exhaustive)}`);
        }
    }
};
/** Invariant matrix — which outcomes are admissible for each reviewer. The
 *  encoding is explicit (rather than computed) so the contract is
 *  reviewable at a glance.
 *
 *   - `user`              ⇒ user_* outcomes OR not_needed (degenerate
 *                          short-circuit: HITL "none" tier escalated to a
 *                          user reviewer that immediately defers).
 *   - `auto_review`       ⇒ config_allowed OR not_needed; cannot deny on
 *                          its own — denial must escalate to guardian/user.
 *   - `guardian_subagent` ⇒ guardian_* OR not_needed. */
const ADMISSIBLE = {
    user: new Set([
        "not_needed",
        "user_approved",
        "user_approved_for_session",
        "user_denied",
        "user_aborted",
    ]),
    auto_review: new Set(["not_needed", "config_allowed"]),
    guardian_subagent: new Set([
        "not_needed",
        "guardian_approved",
        "guardian_denied",
    ]),
};
/** True iff `(reviewer, outcome)` is admissible under the invariant matrix.
 *  `buildDecision` uses this; callers may use it for ahead-of-time checks. */
export const isAdmissible = (reviewer, outcome) => {
    const set = ADMISSIBLE[reviewer];
    return set.has(outcome);
};
/** Decision constructor. Enforces:
 *    1. The (reviewer, outcome) pair is admissible per the matrix above.
 *    2. `rationale` is a non-empty string (audit requirement).
 *    3. `decidedAt` is a finite, non-negative integer (deterministic clock).
 *
 *  Any violation throws `OutcomeInvariantError` (NEVER returns a sentinel).
 */
export const buildDecision = (args) => {
    const { reviewer, outcome, riskLevel, rationale, decidedAt, verb } = args;
    if (!isAdmissible(reviewer, outcome)) {
        throw new OutcomeInvariantError(reviewer, outcome, `outcome not admissible for reviewer (matrix violation)`);
    }
    if (typeof rationale !== "string" || rationale.length === 0) {
        throw new OutcomeInvariantError(reviewer, outcome, `rationale must be a non-empty string`);
    }
    if (!Number.isFinite(decidedAt) || decidedAt < 0 || !Number.isInteger(decidedAt)) {
        throw new OutcomeInvariantError(reviewer, outcome, `decidedAt must be a finite non-negative integer (got ${decidedAt})`);
    }
    return verb !== undefined
        ? { reviewer, outcome, riskLevel, rationale, decidedAt, verb }
        : { reviewer, outcome, riskLevel, rationale, decidedAt };
};
