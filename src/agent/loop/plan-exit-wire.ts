/**
 * Plan-exit side effects after a tool-producing turn (plan mode lifecycle).
 */

import type { HookPromptInject } from "../hooks"
import { resolveCollaborationMode } from "../mode"
import { planToStreamMirror } from "../plan/stream-mirror"
import { applyPlanExitOutcome } from "../plan-exit-lifecycle"
import type { AgentConfig } from "../types"
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

export const applyPendingPlanExit = (
  cfg: AgentConfig,
  pending: PendingPlanExit | null,
  hookPromptPending: HookPromptInject[],
): void => {
  if (pending === null) return
  if (pending.outcome.decision === "approved") {
    const from = resolveCollaborationMode(cfg)
    cfg.planMode = false
    cfg.mode = "default"
    cfg.collaborationMode = "default"
    hookPromptPending.push(approvedPlanReminder(pending.plan))
    if (cfg.planStore !== undefined) {
      const lifecycle = applyPlanExitOutcome(pending.outcome, cfg.planStore)
      if (lifecycle.kind === "freeze" && lifecycle.snapshot !== null) {
        cfg.stream.emit({
          type: "plan_snapshot",
          plan: planToStreamMirror(lifecycle.snapshot.plan),
        })
      }
    }
    if (from !== "default") {
      cfg.stream.emit({
        type: "mode_changed",
        from,
        to: "default",
        reason: "plan_exit_approved",
      })
    }
    return
  }
  if (pending.outcome.decision === "rejected") {
    cfg.planStore?.clear()
    return
  }
  if (cfg.planStore !== undefined) {
    applyPlanExitOutcome(pending.outcome, cfg.planStore)
  }
  hookPromptPending.push(requestedChangesReminder(pending.outcome.feedback ?? "(no feedback)"))
}
