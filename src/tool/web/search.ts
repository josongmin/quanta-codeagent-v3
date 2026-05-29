/**
 * `web_search` tool (ADR-0127, Part 2) — search the web through an INJECTED
 * provider port. Read-only; gracefully degrades to a typed ok:false when no
 * provider is wired (no crash, no throw — closed-port DI posture).
 *
 * Slice posture (RFC §3.1):
 *   - Imports ONLY: `zod`, `../types`. NO `@/agent`, `@/permission`,
 *     `@/storage`, `@/memory`, `@/stream`, `@/lsp`, `@/observability`.
 *   - Provider is a small READONLY port (`WebSearchProvider`); concrete
 *     implementations (Brave / DuckDuckGo / Bing / SerpAPI / etc.) live
 *     OUTSIDE this slice and are wired by the composition root via
 *     `AgentConfig.webSearch.provider`. The tool itself is provider-agnostic.
 *
 * Output formatting: ranked numbered list with title / url / snippet (the
 * snippet truncated to 200 chars). The model can pivot to `web_fetch` for
 * full content of any hit.
 */

import { z } from "zod"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"
export const WEB_SEARCH_DEFAULT_LIMIT = 5
export const WEB_SEARCH_MAX_LIMIT = 20
export const WEB_SEARCH_QUERY_MAX = 500
export const WEB_SEARCH_SNIPPET_MAX = 200

export const webSearchInputSchema = z.object({
  query: z.string().min(1).max(WEB_SEARCH_QUERY_MAX).describe("Search query string"),
  limit: z
    .number()
    .int()
    .positive()
    .max(WEB_SEARCH_MAX_LIMIT)
    .optional()
    .describe(`Max number of results (default ${WEB_SEARCH_DEFAULT_LIMIT})`),
})
export type WebSearchInput = z.infer<typeof webSearchInputSchema>

/** A single search-result hit. Closed-shape — extending requires bumping the
 *  port version + every consumer's `satisfies` clause. */
export interface WebSearchHit {
  readonly title: string
  readonly url: string
  readonly snippet: string
}

/** Closed-port the tool consumes. The provider is responsible for honoring
 *  the abort `signal` (the tool plumbs `ctx.signal` directly). A provider
 *  that throws is caught at the tool boundary — the tool NEVER lets a
 *  provider error escape to the loop. */
export interface WebSearchProvider {
  search(query: string, limit: number, signal?: AbortSignal): Promise<readonly WebSearchHit[]>
}

/** Build the ok:false result with optional typed failure. */
const errResult = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

/** Truncate snippet text at the cap with a single ellipsis. */
const truncateSnippet = (s: string): string => {
  if (s.length <= WEB_SEARCH_SNIPPET_MAX) return s
  return `${s.slice(0, WEB_SEARCH_SNIPPET_MAX)}…`
}

/** Format the hit list as a numbered model-readable block. Order preserved
 *  from the provider's array (the provider is the ranker; the tool is a
 *  formatter). */
const formatHits = (query: string, hits: readonly WebSearchHit[]): string => {
  if (hits.length === 0) {
    return `0 results for "${query}".`
  }
  const lines: string[] = [
    `${hits.length} result${hits.length === 1 ? "" : "s"} for "${query}":`,
    "",
  ]
  hits.forEach((h, i) => {
    lines.push(`${i + 1}. ${h.title}`)
    lines.push(`   ${h.url}`)
    lines.push(`   ${truncateSnippet(h.snippet)}`)
    lines.push("")
  })
  return lines.join("\n").trimEnd()
}

/** Factory — `webSearchTool()` (no args) returns a tool that always yields
 *  ok:false "no provider wired"; `webSearchTool(provider)` returns a tool
 *  that delegates to the injected provider.
 *
 *  The `provider`-less form is the DEFAULT-OFF behavior — it lets the tool
 *  surface stay in the registry / be advertised to the model without crashing
 *  when the host hasn't wired a search backend. */
export const webSearchTool = (provider?: WebSearchProvider): Tool<WebSearchInput> => {
  return {
    name: "web_search",
    description:
      "Search the web via the wired provider. Returns ranked results with title, URL, and snippet. " +
      "Read-only; the model may follow up with `web_fetch` on any hit URL.",
    inputSchema: webSearchInputSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    async *execute(input: WebSearchInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const parsed = webSearchInputSchema.safeParse(input)
      if (!parsed.success) {
        yield { type: "result", result: errResult(`invalid input: ${parsed.error.message}`) }
        return
      }
      if (ctx.signal.aborted) {
        yield { type: "result", result: errResult("aborted before start") }
        return
      }
      if (provider === undefined) {
        yield {
          type: "result",
          result: errResult("no web_search provider wired; configure via AgentConfig.webSearch", {
            mode: "error",
            modelVisibleError: "no_provider",
          }),
        }
        return
      }
      const limit = parsed.data.limit ?? WEB_SEARCH_DEFAULT_LIMIT
      let hits: readonly WebSearchHit[]
      try {
        hits = await provider.search(parsed.data.query, limit, ctx.signal)
      } catch (e) {
        const msg = errMessage(e)
        yield {
          type: "result",
          result: errResult(`provider error: ${msg}`, {
            mode: "error",
            modelVisibleError: msg,
          }),
        }
        return
      }
      yield {
        type: "result",
        result: { ok: true, output: formatHits(parsed.data.query, hits) },
      }
    },
  }
}
