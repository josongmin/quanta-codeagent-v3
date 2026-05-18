import type { z } from "zod"

export interface ToolContext {
  cwd: string
  signal: AbortSignal
}

export interface ToolResult {
  ok: boolean
  /** Text returned to the model as the tool_result content. */
  output: string
}

/**
 * Phase 1 tool contract. Two RFC-6.2 fields are intentionally deferred:
 * - `isConcurrencySafe(input)` — Phase 2 (parallel dispatch)
 * - `execute` returning `AsyncIterable<ToolEvent>` — collapsed to a single
 *   resolved result; streaming tool progress is a later phase.
 */
export interface Tool<I = unknown> {
  name: string
  description: string
  inputSchema: z.ZodType<I>
  isReadOnly(): boolean
  execute(input: I, ctx: ToolContext): Promise<ToolResult>
}

/** Provider-agnostic schema the agent forwards to the LLM. */
export interface ToolSpec {
  name: string
  description: string
  input_schema: Record<string, unknown>
}
