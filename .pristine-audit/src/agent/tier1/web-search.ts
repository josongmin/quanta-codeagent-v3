/**
 * Tier-1 per-subsystem builder: WEB SEARCH block (ADR-0127, Part 3).
 *
 * Returns `[webSearchTool(config.webSearch.provider)]` when a provider is
 * wired; `[]` otherwise (DEFAULT-OFF — byte-identical for every legacy
 * caller).
 *
 * The provider is operator-owned (Brave / DuckDuckGo / SerpAPI / etc.).
 * Concrete adapters live OUTSIDE the `@/tool` slice (no built-in default —
 * shipping a default would lock the user into a specific search backend and
 * a specific API key surface, both rejected as ADR-0127 alternatives).
 */

import type { Tool } from "@/tool"
import { webSearchTool } from "@/tool/web"
import type { AgentConfig } from "../types"

export const buildWebSearchBlock = (config: AgentConfig): Tool[] =>
  config.webSearch === undefined ? [] : [webSearchTool(config.webSearch.provider)]
