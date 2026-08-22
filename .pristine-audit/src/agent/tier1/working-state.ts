/**
 * Tier-1 per-subsystem builder: WORKING STATE block (Codex memory L3
 * absorption).
 *
 * Builds the session-scoped `WorkingStateSession` handle + registers the
 * meta-tool that mutates it.
 *
 * Behavior preserved verbatim from the previous monolithic
 * `buildSessionFeatures` body — only the *location* of this slice has moved.
 *
 * DEFAULT-OFF: `config.workingState?.enabled !== true` ⇒ this builder returns
 * `undefined`, the L3 block is not rendered, and `update_working_state` is
 * NOT in the registry (byte-identical, RFC §1.2).
 */

import { createUpdateWorkingStateTool, type Tool } from "@/tool"
import type { AgentConfig } from "../types"
import { createWorkingStateSession, type WorkingStateSession } from "../working-state"

/** Materialized working-state block. The composer pushes `tool` into
 *  `extraTools` and retains `handle` on the returned `SessionFeatures` so the
 *  per-turn reminder can snapshot the current state. */
export interface WorkingStateBlock {
  handle: WorkingStateSession
  tool: Tool
}

/** Build the working-state block from `config.workingState`. Returns
 *  `undefined` unless `enabled === true`. */
export const buildWorkingStateBlock = (config: AgentConfig): WorkingStateBlock | undefined => {
  if (config.workingState?.enabled !== true) return undefined
  const handle = createWorkingStateSession()
  return { handle, tool: createUpdateWorkingStateTool(handle) as Tool }
}
