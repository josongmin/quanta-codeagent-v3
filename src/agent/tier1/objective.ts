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
 * GOAL-02: this builder is the COMPOSITION ROOT for the model's objective
 * capability. It mints the actor-fixed capability set over the host-supplied
 * port (`createObjectiveCapabilities`) and hands the tool slice ONLY the
 * `model` commands + the read port — the raw authority never reaches `@/tool`
 * (the leaf-domain fence in `tests/unit/_arch/slice-boundary-configs.ts` denies
 * it a VALUE import of `@/objective`, and the boundary ratchet pins the raw
 * protocol to composition roots). The LLM judge is a shadow observer with no
 * admission power; its production invocation waits for the GOAL-04 session
 * task lifecycle, so nothing is allocated here.
 */

import { createObjectiveCapabilities } from "@/objective"
import type { Tool } from "@/tool"
import { objectiveTools } from "@/tool/objective"
import type { AgentConfig } from "../types"

/** Build the objective tool trio when `config.objective` is wired. */
export const buildObjectiveBlock = (config: AgentConfig): Tool[] => {
  const port = config.objective
  if (port === undefined) return []
  const capabilities = createObjectiveCapabilities(port)
  return objectiveTools({ model: capabilities.model, read: capabilities.read })
}
