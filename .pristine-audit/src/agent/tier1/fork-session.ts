/**
 * Tier-1 per-subsystem builder: FORK-SESSION block (ADR-0201).
 *
 * Returns the `fork_session` tool when `config.fork.forker` is wired; empty
 * array otherwise.
 *
 * DEFAULT-OFF: `config.fork` absent ⇒ this builder returns [], so the loop
 * sees no extra tools and the ToolRegistry stays byte-identical.
 */

import type { Tool } from "@/tool"
import { forkSessionTools } from "@/tool/shadow"
import type { AgentConfig } from "../types"

export const buildForkSessionBlock = (config: AgentConfig): Tool[] =>
  config.fork === undefined ? [] : forkSessionTools(config.fork.forker)
