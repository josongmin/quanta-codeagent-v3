import type { z } from "zod"
import { errMessage } from "@/shared"
import type { DeferredResultRegistry } from "./deferred/port"
import { type DefineToolSpec, defineTool } from "./factory"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "./types"
/**
 * ADR-0287 — `defineToolAsync` wrapper. The async-tool seam.
 *
 * A normal `defineTool` builds a tool whose terminal `result` IS the final
 * answer. An async tool, by contrast, registers its work with a
 * `DeferredResultRegistry` (ADR-0286), yields a terminal `result` carrying
 * a `deferred` handle on the LEGACY shape (id + hint), and lets the
 * dispatch wire surface that handle to the LLM in the new "deferred"
 * format. The LLM then calls `poll_deferred` to retrieve the final result.
 *
 * INJECTION SHAPE — the registry is injected at FACTORY time (not via
 * `ToolContext`). Two reasons:
 *
 *  1. The `@/tool` slice's `ToolContext` mirror is locked (`types.ts` is
 *     part of the slice-fence-protected surface). Adding a new field would
 *     ripple into the duck-typed mirror discipline documented in
 *     `types.ts`'s top comment and the dispatch-side `buildToolContext`.
 *  2. An async tool's lifecycle is owned by ONE registry for ITS lifetime
 *     — moving handles between registries mid-session would break the LRU
 *     + the per-handle AbortController invariants. Factory-time injection
 *     makes the ownership relationship structural (you cannot accidentally
 *     swap the registry per-call).
 *
 * Default-OFF: when the registry passed to `defineToolAsync` is `undefined`
 * the wrapper RUNS the work synchronously and yields the result directly —
 * byte-identical to a plain `defineTool` for every caller that has not
 * opted in. This is the safety floor: a host that registers an async tool
 * but forgets to wire the registry still gets a working (synchronous)
 * tool.
 *
 * Slice-fence note: this file lives in `@/tool` and reaches only into
 * `@/tool/*` siblings — no cross-slice imports. The composition root in
 * `@/agent` constructs the registry and passes it here.
 */

/** Spec for an async tool. Mirrors `DefineToolSpec` minus the `execute`
 *  generator — the generator is BUILT by the wrapper around the supplied
 *  `work` function. */
export interface DefineToolAsyncSpec<I, O> {
  name: string
  description: string
  inputSchema: z.ZodType<I>
  isReadOnly(): boolean
  isConcurrencySafe(input: I): boolean
  /** The actual async work the tool performs. Receives the parsed input,
   *  the `ToolContext`, AND the per-handle AbortSignal the registry owns
   *  (chained from the registry's controller for the handle the wrapper
   *  registers). Must return a final `ToolResult`. */
  work(input: I, ctx: ToolContext, signal: AbortSignal): Promise<ToolResult>
  /** Optional message yielded on the placeholder result while the work runs.
   *  Default: `"<async work registered; poll with poll_deferred>"`. */
  pendingMessage?: string
  /** OPTIONAL closed-port DI seam — the registry that owns the lifecycle of
   *  the work this tool schedules. When `undefined` the wrapper degrades to
   *  synchronous execution (byte-identical default-OFF path). */
  registry?: DeferredResultRegistry
  // --- optional passthroughs (existing Tool surface) ---
  hitlTier?: DefineToolSpec<I, O>["hitlTier"]
  extractShellCommand?: DefineToolSpec<I, O>["extractShellCommand"]
  classifySource?: DefineToolSpec<I, O>["classifySource"]
}

/** Default model-facing placeholder text when no `pendingMessage` is set. */
export const DEFAULT_PENDING_MESSAGE = "<async work registered; poll with poll_deferred>"

/**
 * Build an async tool. Returns the same `Tool<I, O>` shape `defineTool`
 * returns — the dispatch + registry surfaces handle it uniformly.
 *
 * Behavior:
 *   1. If `spec.registry` is `undefined`, the wrapper RUNS the work
 *      synchronously and yields the result. Default-OFF degradation —
 *      byte-identical to plain `defineTool` for the existing pipeline.
 *   2. Otherwise the wrapper calls
 *      `registry.register((signal) => work(input, ctx, signal))`, gets a
 *      handle, and yields a placeholder result with
 *      `deferred: { id: handle.id, hint: pendingMessage }`. The dispatch
 *      wire detects `deferred` and surfaces it to the LLM in the new
 *      "deferred" format.
 */
export const defineToolAsync = <I, O = unknown>(spec: DefineToolAsyncSpec<I, O>): Tool<I, O> => {
  const pending = spec.pendingMessage ?? DEFAULT_PENDING_MESSAGE
  const registry = spec.registry
  const inner: DefineToolSpec<I, O> = {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    isReadOnly: spec.isReadOnly,
    isConcurrencySafe: spec.isConcurrencySafe,
    supportsDeferredResults: true,
    async *execute(input: I, ctx: ToolContext): AsyncIterable<ToolEvent> {
      if (registry === undefined) {
        // Default-OFF degradation. Run work synchronously; chain ctx.signal
        // so abort still flows.
        try {
          const result = await spec.work(input, ctx, ctx.signal)
          yield { type: "result", result }
        } catch (e) {
          const msg = errMessage(e)
          yield {
            type: "result",
            result: {
              ok: false,
              output: `${spec.name} failed: ${msg}`,
              failure: { mode: "error", modelVisibleError: msg },
            },
          }
        }
        return
      }
      const handle = registry.register((signal) => spec.work(input, ctx, signal))
      // Yield a placeholder result. `deferred` carries the legacy-shape
      // marker (`{id, hint?}`) — the dispatch wire reads it through
      // `result.deferred` and surfaces it to the LLM in the new format.
      yield {
        type: "result",
        result: {
          ok: true,
          output: pending,
          deferred: { id: handle.id, hint: pending },
        },
      }
    },
  }
  if (spec.hitlTier !== undefined) inner.hitlTier = spec.hitlTier
  if (spec.extractShellCommand !== undefined) inner.extractShellCommand = spec.extractShellCommand
  if (spec.classifySource !== undefined) inner.classifySource = spec.classifySource
  return defineTool(inner)
}
