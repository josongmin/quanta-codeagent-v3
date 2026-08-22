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
 *
 * RFC-03 C1: in production `config.objective` IS the revisioned mutation
 * authority (`createObjectiveStore` now returns it), so `asObjectiveAuthority`
 * recovers the SAME instance — model-originated tool mutations and internal
 * system mutations share one revision/CAS domain. The unwrap happens HERE, not
 * in the tool slice: `@/tool` is denied a VALUE import of `@/objective` (the
 * leaf-domain fence in `tests/unit/_arch/slice-boundary-configs.ts`), and this
 * builder is exactly the agent BRIDGE that fence names as the composer. It adds
 * no policy — for a port that is already the authority the call is identity.
 */

import { asObjectiveAuthority } from "@/objective"
import type { Tool } from "@/tool"
import { objectiveTools } from "@/tool/objective"
import type { AgentConfig } from "../types"

/** Build the objective tool trio when `config.objective` is wired. */
export const buildObjectiveBlock = (config: AgentConfig): Tool[] => {
  const port = config.objective
  if (port === undefined) return []
  return objectiveTools(asObjectiveAuthority(port))
}
