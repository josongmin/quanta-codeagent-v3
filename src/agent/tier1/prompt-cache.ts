/**
 * Tier-1 per-subsystem builder: PROMPT-CACHE STATUS block (ADR-0182).
 *
 * Returns `[promptCacheStatusTool(config.promptCacheObserver)]` when the host
 * wired a `PromptCacheObserver` (gate `QUANTA_PROMPT_CACHE_STATUS`, minted by
 * `maybeWirePromptCacheObserver` in the host assembler); `[]` otherwise
 * (DEFAULT-OFF — byte-identical for every caller that did not opt in).
 *
 * The SAME observer instance backs BOTH this tool and the loop's `emitUsage`
 * feed (`config.promptCacheObserver.record(...)`), so the snapshot the tool
 * renders reflects the cache buckets actually observed this session. Wiring the
 * tool without the loop feed would surface an empty snapshot — both legs share
 * the one instance the assembler puts on `config.promptCacheObserver`.
 */

import type { Tool } from "@/tool"
import { promptCacheStatusTool } from "@/tool/prompt_cache_status"
import type { AgentConfig } from "../types"

export const buildPromptCacheBlock = (config: AgentConfig): Tool[] =>
  config.promptCacheObserver === undefined
    ? []
    : [promptCacheStatusTool(config.promptCacheObserver) as Tool]
