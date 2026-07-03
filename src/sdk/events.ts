/**
 * `@/sdk/events` — narrowing helpers over the 40+ variant {@link AgentEvent}
 * union (Phase 3.4 / audit D). Lets a consumer branch on the handful of events
 * they care about without a giant `switch` and keeps full type inference.
 */

import type { AgentEvent } from "@/stream"

type Variant<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>

export const isText = (e: AgentEvent): e is Variant<"assistant_text"> => e.type === "assistant_text"

export const isThinking = (e: AgentEvent): e is Variant<"assistant_thinking"> =>
  e.type === "assistant_thinking"

export const isToolCall = (e: AgentEvent): e is Variant<"tool_call"> => e.type === "tool_call"

export const isToolResult = (e: AgentEvent): e is Variant<"tool_result"> => e.type === "tool_result"

export const isUsage = (e: AgentEvent): e is Variant<"usage"> => e.type === "usage"

export const isError = (e: AgentEvent): e is Variant<"error"> => e.type === "error"

export const isDone = (e: AgentEvent): e is Variant<"done"> => e.type === "done"
