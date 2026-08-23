/**
 * Plan-ENTRY side effect at the turn boundary (plan mode lifecycle) — the
 * inverse of `applyPendingPlanExit` (plan-exit-wire.ts).
 *
 * When the model calls `enter_plan_mode`, the dispatch seam records the reason
 * as a pending entry; the loop consumes it here at the NEXT turn boundary and
 * flips collaboration mode to `plan`. Deferring to the boundary matches the
 * exit path: the current turn's `turnState.collaborationMode` was already
 * resolved, so the flip takes effect from the following turn (the tool result
 * tells the model exactly this).
 *
 * Idempotent + tighten-only: entry flips ONLY a write-capable posture
 * (`default`/`editor`) into `plan`. If the agent is ALREADY read-only — plan
 * OR review/audit/architect — this is a no-op (no `mode_changed`, no reminder,
 * and crucially no silent downgrade of review/audit into plan). Entry never
 * relaxes a read-only posture, and never rewrites one read-only posture into
 * another.
 */

import type { HookPromptInject } from "../hooks"
import {
  applyCollaborationModeTransition,
  isMutatingMode,
  resolveLiveAgentMode,
  resolveCollaborationMode,
} from "../mode"
import type { PlanLifecycleConfig } from "../types"
import type { PendingPlanEntry } from "./types"

const planModeReminder = (reason: string): HookPromptInject => ({
  injectAfterSystem:
    "Plan mode is now ACTIVE (you requested it: " +
    reason +
    "). Mutating tools (write/edit/bash/git/spawn) are blocked at the dispatch seam. Investigate " +
    "read-only, assemble a plan, then call request_plan_exit to leave plan mode and act.",
})

export const applyPendingPlanEntry = (
  cfg: PlanLifecycleConfig,
  pending: PendingPlanEntry | null,
  hookPromptPending: HookPromptInject[],
): void => {
  if (pending === null) return
  // Tighten-only + idempotent: no-op when the agent is ALREADY read-only in
  // EITHER axis — plan collaboration mode, OR a read-only AgentMode
  // (plan/review/audit/architect). Only a genuinely write-capable posture
  // (default/editor) has anything to fence off. This prevents both a duplicate
  // event and a silent review→plan downgrade.
  if (resolveCollaborationMode(cfg) === "plan") return
  const fromAgentMode = resolveLiveAgentMode(cfg)
  if (!isMutatingMode(fromAgentMode)) return
  const transition = applyCollaborationModeTransition(cfg, "plan")
  if (!transition.changed) return
  hookPromptPending.push(planModeReminder(pending.reason))
  cfg.stream.emit({
    type: "mode_changed",
    from: transition.from,
    to: transition.to,
    fromAgentMode: transition.fromAgentMode,
    toAgentMode: transition.toAgentMode,
    reason: "plan_enter_requested",
  })
}
