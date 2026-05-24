import type { z } from "zod"
import type { Result } from "@/shared"
import { err, ok } from "@/shared"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "./types"

/**
 * (absorb #1) `defineTool` — provider-agnostic tool factory mirroring v0's
 * `createProviderToolFactoryWithOutputSchema`. It wires four INDIVIDUALLY
 * OPTIONAL capabilities onto the existing {@link Tool} contract:
 *
 *   1. `outputSchema`            — validate `ToolResult.structured` (see {@link validateToolOutput})
 *   2. `toModelOutput`           — compact, model-facing rendering distinct from UI `output`
 *   3. `supportsDeferredResults` — typed deferred-result seam (see `./deferred`)
 *   4. streaming-input callbacks — `onInputStart` / `onInputDelta` / `onInputAvailable`
 *
 * A tool defined with NONE of the optional members is byte-identical to a
 * hand-written `Tool` literal — `defineTool` only copies fields that are
 * present (respecting `exactOptionalPropertyTypes`).
 *
 * CANONICAL TEMPLATE: this is the blessed way to construct a tool. The
 * representative built-ins `grep`, `glob`, `read`, and `write` are defined
 * through it (see their `index.ts`), so it is a production path — not a
 * test-only shim. New tools SHOULD use `defineTool`; the remaining hand-written
 * literals / `make*Tool(port)` builders are kept as-is only because migrating
 * them carries no behavior win (they predate the factory and are stable).
 *
 * The security passthroughs (`hitlTier`, `extractShellCommand`,
 * `classifySource`) are first-class spec members because the registry and the
 * dispatch redaction/HITL gates read them; a tool that touches a path or a
 * shell command MUST declare the relevant one here (see `read`/`write`).
 */

export interface DefineToolSpec<I, O> {
  name: string
  description: string
  inputSchema: z.ZodType<I>
  isReadOnly(): boolean
  isConcurrencySafe(input: I): boolean
  execute(input: I, ctx: ToolContext): AsyncIterable<ToolEvent>
  // --- optional passthroughs (existing Tool surface) ---
  hitlTier?: Tool<I, O>["hitlTier"]
  extractShellCommand?: Tool<I, O>["extractShellCommand"]
  classifySource?: Tool<I, O>["classifySource"]
  // --- absorb #1 optional capabilities ---
  outputSchema?: z.ZodType<O>
  toModelOutput?(result: ToolResult): string
  supportsDeferredResults?: boolean
  onInputStart?(): void
  onInputDelta?(delta: string): void
  onInputAvailable?(input: I): void
}

/** Build a {@link Tool} from a spec, copying only the optional members that are
 *  actually present so a plain tool stays structurally identical to a literal. */
export const defineTool = <I, O = unknown>(spec: DefineToolSpec<I, O>): Tool<I, O> => {
  const tool: Tool<I, O> = {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    isReadOnly: spec.isReadOnly,
    isConcurrencySafe: spec.isConcurrencySafe,
    execute: spec.execute,
  }
  if (spec.hitlTier !== undefined) tool.hitlTier = spec.hitlTier
  if (spec.extractShellCommand !== undefined) tool.extractShellCommand = spec.extractShellCommand
  if (spec.classifySource !== undefined) tool.classifySource = spec.classifySource
  if (spec.outputSchema !== undefined) tool.outputSchema = spec.outputSchema
  if (spec.toModelOutput !== undefined) tool.toModelOutput = spec.toModelOutput
  if (spec.supportsDeferredResults !== undefined) {
    tool.supportsDeferredResults = spec.supportsDeferredResults
  }
  if (spec.onInputStart !== undefined) tool.onInputStart = spec.onInputStart
  if (spec.onInputDelta !== undefined) tool.onInputDelta = spec.onInputDelta
  if (spec.onInputAvailable !== undefined) tool.onInputAvailable = spec.onInputAvailable
  return tool
}

/**
 * Pure helper: validate a structured value against a tool's `outputSchema`.
 * Returns a discriminated {@link Result} — `ok:true` with the parsed value, or
 * `ok:false` with a flattened, model-readable error message. NEVER throws.
 */
export const validateToolOutput = <O>(schema: z.ZodType<O>, value: unknown): Result<O, string> => {
  const parsed = schema.safeParse(value)
  if (parsed.success) return ok(parsed.data)
  const issues = parsed.error.issues
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(root)"
      return `${path}: ${i.message}`
    })
    .join("; ")
  return err(issues === "" ? "output failed schema validation" : issues)
}

/**
 * Dispatch-side helper: given a tool's terminal {@link ToolResult}, apply the
 * tool's `outputSchema` (if any). When validation fails, returns an `ok:false`
 * placeholder result whose `output` instructs the model to retry — this is what
 * the dispatch seam forwards instead of throwing past the loop. When the tool
 * has no `outputSchema`, the result is returned unchanged (byte-identical).
 */
export const enforceOutputSchema = <I, O>(tool: Tool<I, O>, result: ToolResult): ToolResult => {
  if (tool.outputSchema === undefined) return result
  // Only validate successful results that actually carry a structured payload.
  if (!result.ok) return result
  const v = validateToolOutput(tool.outputSchema, result.structured)
  if (v.ok) return result
  return {
    ok: false,
    output:
      `Tool \`${tool.name}\` returned a structured result that failed validation: ${v.error}. ` +
      "Re-issue the call with output that matches the declared schema.",
  }
}

/**
 * Dispatch-side helper: render a result for the MODEL, preferring the tool's
 * compact `toModelOutput` when present and falling back to `result.output`
 * (today's behavior). Pure; never throws.
 */
export const renderModelOutput = <I, O>(tool: Tool<I, O>, result: ToolResult): string =>
  tool.toModelOutput !== undefined ? tool.toModelOutput(result) : result.output

/** One streaming-input step, mirroring an LLM tool-use streaming event. */
export type StreamingInputStep =
  | { type: "start" }
  | { type: "delta"; delta: string }
  | { type: "available"; input: unknown }

/**
 * Pure driver that feeds a sequence of streaming-input steps to a tool's
 * optional `onInputStart` / `onInputDelta` / `onInputAvailable` callbacks. A
 * tool that implements none of them is a no-op. Returns the accumulated raw
 * delta string (the partial-JSON buffer the dispatch seam would parse).
 *
 * Test/replay driver only. Live `tool_use_start` / `tool_use_delta` /
 * `tool_use_end` events drive the per-tool callbacks through the
 * `StreamingTurnArgs.onToolInput` seam in `@/agent/streaming-dispatch.ts`
 * (default-OFF when no seam is wired). This function is the pure equivalent
 * the seam consumes — keeping it standalone lets tests exercise the callback
 * surface without spinning up a streaming dispatch.
 */
export const driveStreamingInput = <I, O>(
  tool: Tool<I, O>,
  steps: Iterable<StreamingInputStep>,
): string => {
  let buffer = ""
  for (const step of steps) {
    switch (step.type) {
      case "start":
        tool.onInputStart?.()
        break
      case "delta":
        buffer += step.delta
        tool.onInputDelta?.(step.delta)
        break
      case "available":
        tool.onInputAvailable?.(step.input as I)
        break
    }
  }
  return buffer
}
