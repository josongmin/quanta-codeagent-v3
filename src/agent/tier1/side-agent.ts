/**
 * Tier-1 per-subsystem builder: BACKGROUND SIDE-AGENT block (N1).
 *
 * Returns the side-agent management tools (`side_agent_spawn` / `_list` /
 * `_stop` / `_findings`) when the host wired a daemon registry
 * (`config.sideAgentDaemons`, minted by `maybeWireSideAgent` in the host
 * assembler under `QUANTA_SIDE_AGENT`); `[]` otherwise (DEFAULT-OFF —
 * byte-identical for every caller that did not opt in).
 *
 * The registry instance the tools manage is the SAME one the host's supervise
 * loop runs (`@/side-agent` `SideAgentDaemonRegistry`), so spawn/list/stop/drain
 * reflect the live daemons.
 */

import type { Tool } from "@/tool"
import { sideAgentTools } from "@/tool/side-agent"
import { canAdmitChildDepth, childDepthOf, effectiveCap } from "../spawn-depth"
import type { AgentConfig } from "../types"

/** Spawn-depth authority for daemon CREATION (rev.4 §4). A background side-agent
 *  is a descendant-spawn vector, so the agent that owns the block may mint one
 *  only if it may spawn ANY descendant: `childDepthOf(config)` (= own depth + 1)
 *  within the effective min-cap. Fail-closed on a malformed own depth (the same
 *  `SpawnLineageError` discipline the runner reject uses). This is the runtime
 *  authority behind the projection (which merely HIDES `side_agent_spawn` from a
 *  leaf) — it also denies a forced/held-runner creation the projection can't see. */
const admitsDaemonChild = (config: AgentConfig): boolean => {
  try {
    return canAdmitChildDepth(childDepthOf(config), effectiveCap(config.subagent?.maxDepth))
  } catch {
    return false
  }
}

export const buildSideAgentBlock = (config: AgentConfig): Tool[] =>
  config.sideAgentDaemons === undefined
    ? []
    : sideAgentTools(config.sideAgentDaemons, () => admitsDaemonChild(config))
