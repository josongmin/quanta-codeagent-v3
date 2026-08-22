/**
 * Plan-exit side effects after a tool-producing turn (plan mode lifecycle).
 */

import type { HookPromptInject } from "../hooks"
import { applyCollaborationModeTransition } from "../mode"
import { renderPlanAsMarkdown } from "../plan/render-text"
import { planToStreamMirror } from "../plan/stream-mirror"
import { applyPlanExitOutcome } from "../plan-exit-lifecycle"
import type { PlanLifecycleConfig } from "../types"
import type { PendingPlanExit } from "./types"

const approvedPlanReminder = (plan: string): HookPromptInject => ({
  injectAfterSystem:
    "Approved plan is now executable. Treat this plan as read-only context for the next turn:\n\n" +
    plan,
})

const requestedChangesReminder = (feedback: string): HookPromptInject => ({
  injectAfterSystem:
    "Operator feedback on the active plan:\n" +
    feedback +
    "\n\nRevise the plan, keep plan mode active, and request exit again only after updating the plan.",
})

const rejectedPlanReminder = (): HookPromptInject => ({
  injectAfterSystem:
    "The proposed plan was rejected and has been discarded. Plan mode is now " +
    "exited. Do not treat the abandoned plan as active context; ask the " +
    "operator for direction or propose a fresh approach before acting.",
})

export const applyPendingPlanExit = (
  cfg: PlanLifecycleConfig,
  pending: PendingPlanExit | null,
  hookPromptPending: HookPromptInject[],
): void => {
  if (pending === null) return
  if (pending.outcome.decision === "approved") {
    const transition = applyCollaborationModeTransition(cfg, "default")
    let approvedPlanText = pending.plan
    if (cfg.planStore !== undefined) {
      const lifecycle = applyPlanExitOutcome(pending.outcome, cfg.planStore)
      if (lifecycle.kind === "freeze" && lifecycle.snapshot !== null) {
        approvedPlanText = renderPlanAsMarkdown(lifecycle.snapshot.plan)
        cfg.stream.emit({
          type: "plan_snapshot",
          plan: planToStreamMirror(lifecycle.snapshot.plan),
        })
      }
      // Freeze-on-approval is modeled as "emit the by-value approved snapshot,
      // then drop the mutable live store". Leaving the store alive would let
      // later turns mutate a plan the prompt just framed as read-only, and the
      // focus-chain bridge would keep re-injecting stale planning todos during
      // execution turns.
      cfg.planStore.clear()
    }
    hookPromptPending.push(approvedPlanReminder(approvedPlanText))
    if (transition.changed) {
      cfg.stream.emit({
        type: "mode_changed",
        from: transition.from,
        to: transition.to,
        fromAgentMode: transition.fromAgentMode,
        toAgentMode: transition.toAgentMode,
        reason: "plan_exit_approved",
      })
    }
    return
  }
  if (pending.outcome.decision === "rejected") {
    // ALBB-20 #1 — a rejected plan exits plan mode just like `approved`, but the
    // prior code `clear()`ed + returned with ZERO stream emit and ZERO operator
    // reminder (silent). Mirror the approved branch: surface the exit via
    // `mode_changed` and push an operator reminder BEFORE dropping the store, so
    // the discard is observable (north-star agent-state visibility) and the
    // model is told the abandoned plan is no longer active context.
    const transition = applyCollaborationModeTransition(cfg, "default")
    hookPromptPending.push(rejectedPlanReminder())
    if (transition.changed) {
      cfg.stream.emit({
        type: "mode_changed",
        from: transition.from,
        to: transition.to,
        fromAgentMode: transition.fromAgentMode,
        toAgentMode: transition.toAgentMode,
        reason: "plan_exit_rejected",
      })
    }
    cfg.planStore?.clear()
    return
  }
  if (cfg.planStore !== undefined) {
    applyPlanExitOutcome(pending.outcome, cfg.planStore)
  }
  hookPromptPending.push(requestedChangesReminder(pending.outcome.feedback ?? "(no feedback)"))
}
