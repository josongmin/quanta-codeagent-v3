/**
 * Tier-1 per-subsystem builder: PLAN-MUTATION tools block (ADR-0093 draft).
 *
 * Registers the 5 structured plan tools ONLY when `config.planStore` is wired.
 * The dispatch seam adapts the store into `ctx.planMutator` at every
 * dispatch; absent ⇒ tools NOT in registry + legacy plan-posture flow
 * byte-identical. The read surface (`current_plan`) is read-only:true; the 4
 * mutators stay read-only:false. All 5 are concurrency-safe.
 *
 * Behavior preserved verbatim from the previous monolithic
 * `buildSessionFeatures` body — only the *location* of this slice has moved.
 *
 * DEFAULT-OFF: `config.planStore` absent ⇒ this builder returns `undefined`
 * (byte-identical, RFC §1.2).
 */

import { buildPlanTools, type Tool } from "@/tool"
import type { AgentConfig } from "../types"

/** Build the structured plan-tool array from `config.planStore`. Returns
 *  `undefined` when the store is not wired. */
export const buildPlanMutationBlock = (config: AgentConfig): Tool[] | undefined => {
  if (config.planStore === undefined) return undefined
  return buildPlanTools().map((t) => t as Tool)
}
