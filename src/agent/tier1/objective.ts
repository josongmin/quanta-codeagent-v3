/**
 * Tier-1 per-subsystem builder: OBJECTIVE block (ADR-0402).
 *
 * Returns the 3 objective tools (`objective_set` / `objective_update` /
 * `objective_get`) when `config.objective` is wired; empty array otherwise.
 *
 * DEFAULT-OFF: `config.objective` absent ⇒ this builder returns [], so the
 * loop sees no extra tools and the ToolRegistry stays byte-identical. Mirrors
 * `buildDelegateBlock` / `buildSubagentBgBlock` posture.
 *
 * SLICE FENCE: the `@/tool/objective` slice imports `@/objective` types
 * directly (the closed ADR-0394 substrate is its own slice — separate from the
 * agent core). This builder is the composition root that threads the host-
 * supplied `ObjectivePort` into the tool factory at session-start.
 */

import type { Tool } from "@/tool"
import { objectiveTools } from "@/tool/objective"
import type { AgentConfig } from "../types"

/** Build the objective tool trio when `config.objective` is wired. */
export const buildObjectiveBlock = (config: AgentConfig): Tool[] => {
  const port = config.objective
  if (port === undefined) return []
  return objectiveTools(port)
}
