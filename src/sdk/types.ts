/**
 * `@/sdk/types` — curated public type surface (Phase 2.2 / audit C).
 *
 * Consumers import types from HERE, never from `@/agent` / `@/stream` deep
 * paths. Re-exporting a narrow whitelist keeps the 133-field `AgentConfig` and
 * the 27 optional wire-slots from leaking into consumer code. The
 * `boundary.slice.test` pins this whitelist.
 */

export type { AgentOutcome, StopReason } from "@/agent"
export type { LLMPort, Message } from "@/llm"
export type { AgentEvent } from "@/stream"
export type { Tool, ToolContext, ToolEvent } from "@/tool"
