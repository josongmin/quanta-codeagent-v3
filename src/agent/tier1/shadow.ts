/**
 * Tier-1 per-subsystem builder: SHADOW STORE block (ADR-0119).
 *
 * Returns the `shadow_rewind` + `shadow_snapshots` tools when
 * `config.shadowOdb` is wired; empty array otherwise.
 *
 * DEFAULT-OFF: `config.shadowOdb` absent ⇒ this builder returns [], so the
 * loop sees no extra tools and the ToolRegistry stays byte-identical.
 */

import type { Tool } from "@/tool"
import { shadowTools } from "@/tool/shadow"
import type { AgentConfig } from "../types"

export const buildShadowBlock = (config: AgentConfig): Tool[] =>
  config.shadowOdb === undefined ? [] : shadowTools(config.shadowOdb)
