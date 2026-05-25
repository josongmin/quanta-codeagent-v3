import {
  ReviewerUnavailableError,
  type ApprovalDecision,
  type ApprovalOutcome,
  type ReviewContext,
  type ReviewerPort,
  type ToolActionKeyed,
} from "@/permission"
import { normalizeConfirm } from "./confirm-decision"
import type { AgentConfig } from "./types"

export interface OnConfirmReviewerPortOptions {
  /** Existing host consent callback. */
  onConfirm: NonNullable<AgentConfig["onConfirm"]>
  /** Optional auto-review implementation. Absent ⇒ fail closed when a caller
   *  selects `defaultReviewer: "auto_review"`. */
  autoReview?: ReviewerPort["autoReview"]
  /** Optional guardian-review implementation. Absent ⇒ fail closed when a
   *  caller selects `defaultReviewer: "guardian_subagent"`. */
  guardianReview?: ReviewerPort["guardianReview"]
  /** Approval outcome to emit on a positive human decision. Defaults to the
   *  narrowest one-shot allow; callers that want session stickiness may opt
   *  into `user_approved_for_session`. */
  approveOutcome?: Extract<ApprovalOutcome, "user_approved" | "user_approved_for_session">
}

const reviewTarget = (action: ToolActionKeyed, ctx: ReviewContext): string =>
  `${ctx.reviewKind ?? "action"} review for ${action.tool}`

const riskLevelFor = (action: ToolActionKeyed): ApprovalDecision["riskLevel"] =>
  action.isReadOnly ? "low" : "high"

const unavailable = (
  reviewer: "auto_review" | "guardian_subagent",
): ReviewerPort["autoReview"] | ReviewerPort["guardianReview"] =>
  async () => {
    throw new ReviewerUnavailableError(reviewer)
  }

/** Minimal concrete ReviewerPort adapter backed by the existing `onConfirm`
 *  surface. This closes the "zero prod impl" gap for USER-tier review while
 *  staying fail-closed for AUTO/GUARDIAN tiers unless a composition root
 *  supplies real implementations for those methods. */
export const createOnConfirmReviewerPort = (
  opts: OnConfirmReviewerPortOptions,
): ReviewerPort => {
  const approveOutcome = opts.approveOutcome ?? "user_approved"
  return {
    userReview: async (action, ctx) => {
      const raw = await opts.onConfirm({
        tool: action.tool,
        input: action.input,
        isReadOnly: action.isReadOnly,
      })
      const decision = normalizeConfirm(raw)
      const target = reviewTarget(action, ctx)
      const riskLevel = riskLevelFor(action)
      if (decision.decision === "allow") {
        return {
          reviewer: "user",
          outcome: approveOutcome,
          riskLevel,
          rationale: `approved ${target}`,
          decidedAt: ctx.decidedAt,
        }
      }
      if (decision.decision === "deny_and_steer") {
        return {
          reviewer: "user",
          outcome: "user_denied",
          riskLevel,
          rationale: target,
          decidedAt: ctx.decidedAt,
          verb: { verb: "reject_and_tell", message: decision.steer },
        }
      }
      return {
        reviewer: "user",
        outcome: "user_denied",
        riskLevel,
        rationale: target,
        decidedAt: ctx.decidedAt,
      }
    },
    autoReview: opts.autoReview ?? unavailable("auto_review"),
    guardianReview: opts.guardianReview ?? unavailable("guardian_subagent"),
  }
}
