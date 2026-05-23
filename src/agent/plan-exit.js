/**
 * Plan-mode 3-way exit (ADR absorb #3, from v0.dev's
 * PlanModeExit{Approve,Reject,RequestChanges}).
 *
 * Pure module. Owns the decision surface for exiting plan posture: the agent
 * presents a plan and the operator chooses one of three exits:
 *
 *   - `approved`           ⇒ the plan is accepted; the agent may now mutate
 *                            (exit plan posture into execute posture).
 *   - `rejected`           ⇒ the plan is abandoned; the agent exits plan
 *                            posture WITHOUT mutating.
 *   - `changes_requested`  ⇒ the operator wants revisions; the agent STAYS in
 *                            plan posture and revises. `feedback` is REQUIRED.
 *
 * Standalone-callable. NOT wired into the loop — that is out of scope for this
 * cluster.
 * TODO(absorb #3): wire plan-exit gate into loop/side-conversation.
 *
 * Style mirrors `@/permission/outcome.ts`: the builder enforces invariants and
 * throws a named `QuantaError` subclass on violation — no silent normalization,
 * no sentinel return.
 */
import { QuantaError } from "@/shared";
/** All three decision literals, enumerated as a runtime-visible constant for
 *  exhaustive testing (matches `outcome.ts`'s `ALL_OUTCOMES` convention). */
export const ALL_PLAN_EXIT_DECISIONS = [
    "approved",
    "rejected",
    "changes_requested",
];
/** Thrown by {@link buildPlanExit} when the feedback invariant is violated:
 *  `changes_requested` MUST carry non-empty feedback, and approved/rejected
 *  MUST NOT carry feedback. */
export class PlanExitInvariantError extends QuantaError {
    decision;
    constructor(decision, detail) {
        super("plan_exit_invariant", `PlanExitInvariantError: decision=${decision} — ${detail}`);
        this.decision = decision;
    }
}
/** Decision constructor. Enforces the feedback invariant:
 *    - `changes_requested` ⇒ `feedback` is a non-empty (post-trim) string.
 *    - `approved` / `rejected` ⇒ `feedback` MUST be absent/empty.
 *
 *  Any violation throws {@link PlanExitInvariantError} (NEVER returns a
 *  sentinel). The returned record omits `feedback` entirely for
 *  approved/rejected (exactOptionalPropertyTypes-safe). */
export const buildPlanExit = (args) => {
    const { decision } = args;
    const feedback = args.feedback;
    const hasFeedback = typeof feedback === "string" && feedback.trim().length > 0;
    if (decision === "changes_requested") {
        if (!hasFeedback) {
            throw new PlanExitInvariantError(decision, "feedback is required and must be non-empty when requesting changes");
        }
        return { decision, feedback: feedback };
    }
    // approved / rejected: feedback must not be supplied.
    if (hasFeedback) {
        throw new PlanExitInvariantError(decision, `feedback must not be provided for a ${decision} decision`);
    }
    return { decision };
};
/** True iff the decision authorizes the agent to leave plan posture and
 *  MUTATE. Only `approved` grants mutation. */
export const planExitAllowsMutation = (d) => d === "approved";
/** True iff the agent should STAY in plan posture after this decision. Only
 *  `changes_requested` keeps the agent in plan (it revises the plan).
 *  `approved` exits to execute posture; `rejected` exits abandoning the plan. */
export const planExitStaysInPlan = (d) => d === "changes_requested";
