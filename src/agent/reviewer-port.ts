import {
  type ApprovalDecision,
  type ApprovalOutcome,
  AutoModeClassifier,
  CLASSIFIER_SYSTEM_PROMPT,
  type PermissionContext,
  type ReviewContext,
  type ReviewerPort,
  ReviewerUnavailableError,
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
  /** jun-7-misc 03 (ADR-0497) — OPTIONAL richer per-action assessor for the
   *  guardian tier. Wired ONLY when the `QUANTA_GUARDIAN_ASSESSOR` knob is on
   *  (composition root). Absent ⇒ the port omits the method entirely, so
   *  `reviewAction`'s knob-gated branch never fires and the guardian path is the
   *  exact binary `guardianReview` (byte-identical OFF). */
  guardianAssess?: ReviewerPort["guardianAssess"]
  /** Approval outcome to emit on a positive human decision. Defaults to the
   *  narrowest one-shot allow; callers that want session stickiness may opt
   *  into `user_approved_for_session`. */
  approveOutcome?: Extract<ApprovalOutcome, "user_approved" | "user_approved_for_session">
}

export interface ClassifierBackedAutoReviewOptions {
  /** Injected classifier port already owned by the CLI/session composition. */
  classify: NonNullable<PermissionContext["classify"]>
  /** Human fallback for deny / uncertain / unavailable classifier outcomes. */
  userReview: ReviewerPort["userReview"]
}

const reviewTarget = (action: ToolActionKeyed, ctx: ReviewContext): string =>
  `${ctx.reviewKind ?? "action"} review for ${action.tool}`

const riskLevelFor = (action: ToolActionKeyed): ApprovalDecision["riskLevel"] =>
  action.isReadOnly ? "low" : "high"

const unavailable =
  (
    reviewer: "auto_review" | "guardian_subagent",
  ): ReviewerPort["autoReview"] | ReviewerPort["guardianReview"] =>
  async () => {
    throw new ReviewerUnavailableError(reviewer)
  }

/** Build an AUTO-tier reviewer from the existing classifier seam. AUTO may
 *  only emit `not_needed` / `config_allowed`; any deny, ask/fallback, or
 *  unavailable path escalates to the injected USER-tier reviewer. */
export const createClassifierBackedAutoReview = (
  opts: ClassifierBackedAutoReviewOptions,
): ReviewerPort["autoReview"] => {
  const classifier = new AutoModeClassifier(opts.classify)
  return async (action, ctx): Promise<ApprovalDecision> => {
    const target = reviewTarget(action, ctx)
    if (action.isReadOnly) {
      return {
        reviewer: "auto_review",
        outcome: "not_needed",
        riskLevel: "low",
        rationale: `read-only ${target} requires no user confirmation`,
        decidedAt: ctx.decidedAt,
      }
    }

    const decision = await classifier.evaluate({
      tool: action.tool,
      input: action.input,
      systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
    })
    if (decision.verdict === "allow") {
      return {
        reviewer: "auto_review",
        outcome: "config_allowed",
        riskLevel: riskLevelFor(action),
        rationale: `auto review allowed ${target}: ${decision.reason}`,
        decidedAt: ctx.decidedAt,
      }
    }
    return opts.userReview(action, { ...ctx, configReviewer: "user" })
  }
}

/** Minimal concrete ReviewerPort adapter backed by the existing `onConfirm`
 *  surface. This closes the "zero prod impl" gap for USER-tier review while
 *  staying fail-closed for AUTO/GUARDIAN tiers unless a composition root
 *  supplies real implementations for those methods. */
export const createOnConfirmReviewerPort = (opts: OnConfirmReviewerPortOptions): ReviewerPort => {
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
        // WS-A (jul-10, UUX-2-20) — the operator's allow SCOPE maps onto the
        // existing ApprovalOutcome vocabulary instead of collapsing to the
        // configured default: "[a]lways session" answers stick
        // (`user_approved_for_session`), and an EXPLICIT "once" is never
        // widened by a session-default config. Scopeless allows (incl. the
        // legacy boolean form) keep the configured default — byte-identical.
        const outcome =
          decision.scope === "session" || decision.scope === "session_prefix"
            ? "user_approved_for_session"
            : decision.scope === "once"
              ? "user_approved"
              : approveOutcome
        return {
          reviewer: "user",
          outcome,
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
    // jun-7-misc 03 (ADR-0497): include the OPTIONAL assessor method ONLY when a
    // composition root supplied it (knob-on). Omitted otherwise so the port
    // shape stays byte-identical and `reviewAction`'s `typeof guardianAssess ===
    // "function"` guard is false on the OFF path.
    ...(opts.guardianAssess !== undefined ? { guardianAssess: opts.guardianAssess } : {}),
  }
}
