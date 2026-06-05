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
import type { AgentConfig } from "../types"

export const buildSideAgentBlock = (config: AgentConfig): Tool[] =>
  config.sideAgentDaemons === undefined ? [] : sideAgentTools(config.sideAgentDaemons)
