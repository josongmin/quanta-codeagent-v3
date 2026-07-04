/**
 * Tier-1 per-subsystem builder: PLAN-ENTRY tool block — the model-driven
 * counterpart to `buildPlanExitBlock` (tier1/plan-exit.ts).
 *
 * Registers `enter_plan_mode` ONLY when a plan-exit port is wired. Gating on
 * the SAME slot as the exit tool is deliberate: offering the agent a way to
 * ENTER plan mode without a wired way to cleanly EXIT would strand it in the
 * read-only fence. So entry and exit turn on together (default-ON with the
 * plan lifecycle; byte-identical when the port is absent).
 */

// Direct tool import (matches tier1/plan-exit.ts) so the fc-reachability
// analyzer sees a direct edge from this reached builder to enter-plan-mode.ts.
import type { Tool } from "@/tool"
import { enterPlanModeTool } from "@/tool/enter-plan-mode"
import type { AgentConfig } from "../types"

/** Build the plan-entry tool from `config.planExitPort`. Returns `undefined`
 *  when the port is not wired (byte-identical off). */
export const buildEnterPlanBlock = (config: AgentConfig): Tool | undefined => {
  if (config.planExitPort === undefined) return undefined
  return enterPlanModeTool() as Tool
}
