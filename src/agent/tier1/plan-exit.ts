/**
 * Tier-1 per-subsystem builder: PLAN-EXIT tool block (ADR-0086).
 *
 * Registers `request_plan_exit` ONLY when a plan-exit port is wired. The
 * dispatch seam builds `ctx.requestPlanExit` from the same port; absent ⇒
 * the tool is not in the registry and the loop is byte-identical.
 *
 * Behavior preserved verbatim from the previous monolithic
 * `buildSessionFeatures` body — only the *location* of this slice has moved.
 *
 * DEFAULT-OFF: `config.planExitPort` absent ⇒ this builder returns
 * `undefined` (byte-identical, RFC §1.2).
 */

import { requestPlanExitTool, type Tool } from "@/tool"
import type { AgentConfig } from "../types"

/** Build the plan-exit tool from `config.planExitPort`. Returns `undefined`
 *  when the port is not wired. */
export const buildPlanExitBlock = (config: AgentConfig): Tool | undefined => {
  if (config.planExitPort === undefined) return undefined
  return requestPlanExitTool() as Tool
}
