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
 * Events a tool streams while running. A tool yields zero or more `progress`
 * events, then exactly one terminal `result` — which MUST be the last event.
 */
export type ToolEvent =
  | { type: "progress"; message: string }
  | { type: "result"; result: ToolResult }

/**
 * Phase 2 tool contract (RFC §6.2). `execute` is an async generator yielding
 * `ToolEvent`s; `isConcurrencySafe(input)` lets the dispatcher batch pure
 * reads to run in parallel while keeping side-effecting calls serialized.
 */
export interface Tool<I = unknown> {
  name: string
  description: string
  inputSchema: z.ZodType<I>
  isReadOnly(): boolean
  /** True ⇒ this call has no observable interaction with any other call and
   *  may run concurrently with other concurrency-safe calls. */
  isConcurrencySafe(input: I): boolean
  execute(input: I, ctx: ToolContext): AsyncIterable<ToolEvent>
}

/** Provider-agnostic schema the agent forwards to the LLM. */
export interface ToolSpec {
  name: string
  description: string
  input_schema: Record<string, unknown>
}
