/**
 * Tool instrumentation (ADR-0160 — extends ADR-0158 24-metric recipe).
 *
 * Wraps a `Tool` interface to emit per-tool call counter + duration histogram.
 * Covers `read_image` / `web_fetch` / `web_search` / `pdf_read` / etc.
 *
 * Counters:
 *   tool.call.total     labels: tool, ok ("true"|"false")
 *
 * Histograms:
 *   tool.call.duration_ms     labels: tool
 *
 * Pure forwarding wrapper — no slice-side imports of `@/observability`.
 */

// biome-ignore lint/style/noRestrictedImports: type-only import (erased at compile time) — no runtime slice coupling; the AST slice-boundary scanner exempts type imports.
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import type { MetricsRegistry } from "./port"

const safe = (metrics: MetricsRegistry, fn: () => void): void => {
  try {
    fn()
  } catch {
    /* observability emission must not break the wrapped call */
  }
}

export interface ToolInstrumentOpts {
  /** Default prefix is "tool". */
  readonly namePrefix?: string
  /** Default = performance.now. */
  readonly now?: () => number
  /** Override the tool label (default = `tool.name`). Useful when wrapping
   *  a generic tool family with a more specific facet label. */
  readonly toolLabel?: string
}

export const instrumentTool = <I>(
  tool: Tool<I>,
  metrics: MetricsRegistry,
  opts?: ToolInstrumentOpts,
): Tool<I> => {
  const prefix = opts?.namePrefix ?? "tool"
  const now = opts?.now ?? (() => performance.now())
  const toolLabel = opts?.toolLabel ?? tool.name

  return {
    ...tool,
    async *execute(input: I, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const t0 = now()
      let okFlag = "true"
      try {
        for await (const ev of tool.execute(input, ctx)) {
          if (ev.type === "result" && ev.result.ok === false) okFlag = "false"
          yield ev
        }
      } catch (e) {
        okFlag = "false"
        throw e
      } finally {
        safe(metrics, () =>
          metrics.increment(`${prefix}.call.total`, 1, { tool: toolLabel, ok: okFlag }),
        )
        safe(metrics, () =>
          metrics.observe(`${prefix}.call.duration_ms`, now() - t0, { tool: toolLabel }),
        )
      }
    },
  }
}

/** Convenience: wrap many tools at once with one MetricsRegistry. */
export const instrumentTools = (
  tools: ReadonlyArray<Tool>,
  metrics: MetricsRegistry,
  opts?: Omit<ToolInstrumentOpts, "toolLabel">,
): Tool[] => tools.map((t) => instrumentTool(t, metrics, opts))
