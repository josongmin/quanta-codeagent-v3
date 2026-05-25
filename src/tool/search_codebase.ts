/**
 * `search_codebase` tool (ADR-0272) — search the workspace through an
 * INJECTED `SearchPipeline` (the composition-root wire from
 * `src/apps/agent/pipeline-wire.ts`). Read-only; gracefully degrades to a
 * typed `ok:false` when no pipeline is wired (no crash, no throw — same
 * closed-port DI posture as `webSearchTool`).
 *
 * Slice posture (RFC §3.1):
 *   - Imports ONLY: `zod`, `./factory`, `./types`. NO `@/agent`,
 *     `@/retrieval`, `@/memory`, `@/stream`, `@/lsp`, `@/observability`.
 *   - The `SearchPipeline` shape is DUCK-TYPED (single `search` method
 *     returning `Promise<Result<readonly SearchHit[], unknown>>`); this
 *     structural mirror lets the slice fence stay honest while the
 *     composition root passes the real `@/retrieval/pipeline` instance
 *     verbatim (the shape matches by construction).
 *
 * Output formatting: numbered list with rank / id / score / snippet. The
 * model picks a hit and follows up with `read` / `grep` for full content.
 */

import { z } from "zod"
import { defineTool } from "./factory"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "./types"

/** Duck-typed mirror of `@/retrieval/pipeline`'s `SearchHit`. Slice fence
 *  forbids the import; the structural match is enforced by the
 *  composition root passing the real type verbatim. */
export interface SearchCodebaseHit {
  readonly id: string
  readonly score: number
  readonly text: string
  readonly source?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Duck-typed mirror of `Result<readonly SearchHit[], unknown>`. */
export type SearchCodebaseResult =
  | { readonly ok: true; readonly value: readonly SearchCodebaseHit[] }
  | { readonly ok: false; readonly error: unknown }

/** Duck-typed mirror of `@/retrieval/pipeline`'s `SearchPipeline`. */
export interface SearchCodebasePipeline {
  search(query: { text: string; k: number }): Promise<SearchCodebaseResult>
}

export const SEARCH_CODEBASE_DEFAULT_K = 5
export const SEARCH_CODEBASE_MAX_K = 50
export const SEARCH_CODEBASE_QUERY_MAX = 500
export const SEARCH_CODEBASE_SNIPPET_MAX = 200

export const searchCodebaseInputSchema = z.object({
  query: z.string().min(1).max(SEARCH_CODEBASE_QUERY_MAX).describe("Search query string"),
  k: z
    .number()
    .int()
    .positive()
    .max(SEARCH_CODEBASE_MAX_K)
    .optional()
    .describe(`Max number of hits (default ${SEARCH_CODEBASE_DEFAULT_K})`),
})
export type SearchCodebaseInput = z.infer<typeof searchCodebaseInputSchema>

/** Build the `ok:false` result with optional typed failure. */
const errResult = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

/** Truncate snippet text at the cap with a single ellipsis. */
const truncateSnippet = (s: string): string => {
  if (s.length <= SEARCH_CODEBASE_SNIPPET_MAX) return s
  return `${s.slice(0, SEARCH_CODEBASE_SNIPPET_MAX)}…`
}

/** Format the hit list as a numbered model-readable block. */
const formatHits = (query: string, hits: readonly SearchCodebaseHit[]): string => {
  if (hits.length === 0) {
    return `0 results for "${query}".`
  }
  const lines: string[] = [
    `${hits.length} result${hits.length === 1 ? "" : "s"} for "${query}":`,
    "",
  ]
  hits.forEach((h, i) => {
    lines.push(`${i + 1}. ${h.id}  (score=${h.score.toFixed(3)})`)
    lines.push(`   ${truncateSnippet(h.text)}`)
    lines.push("")
  })
  return lines.join("\n").trimEnd()
}

/** Map a pipeline `PipelineError` shape to a short tag string for the
 *  `modelVisibleError` channel. Lifted to keep `execute` below the
 *  cognitive-complexity threshold (biome). */
const tagOfPipelineError = (e: unknown): string => {
  if (typeof e === "object" && e !== null && "kind" in e) {
    return String((e as { kind: unknown }).kind)
  }
  return "unknown"
}

/** Call the pipeline guarded against throws; collapse the result/error
 *  axes into a single discriminated `ToolResult`. Pure I/O helper —
 *  takes only what the call needs (no `ctx` dependency). */
const runPipelineSearch = async (
  pipeline: SearchCodebasePipeline,
  query: string,
  k: number,
): Promise<ToolResult> => {
  let result: SearchCodebaseResult
  try {
    result = await pipeline.search({ text: query, k })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return errResult(`pipeline error: ${msg}`, {
      mode: "error",
      modelVisibleError: msg,
    })
  }
  if (!result.ok) {
    const tag = tagOfPipelineError(result.error)
    return errResult(`pipeline returned err: ${tag}`, {
      mode: "error",
      modelVisibleError: tag,
    })
  }
  return { ok: true, output: formatHits(query, result.value) }
}

/**
 * Factory — `searchCodebaseTool()` (no args) returns a tool that always
 * yields `ok:false` "no pipeline wired"; `searchCodebaseTool(pipeline)`
 * returns a tool that delegates to the injected pipeline.
 *
 * The pipeline-less form is the DEFAULT-OFF behaviour — the tool can
 * stay in the registry / be advertised to the model without crashing
 * when the host hasn't wired a `SearchPipeline` (mirrors `webSearchTool`).
 */
export const searchCodebaseTool = (
  pipeline?: SearchCodebasePipeline,
): Tool<SearchCodebaseInput> => {
  return defineTool({
    name: "search_codebase",
    description:
      "Search the workspace via the wired SearchPipeline. Returns ranked hits with id and snippet. " +
      "Read-only; the model may follow up with `read` / `grep` for full content.",
    inputSchema: searchCodebaseInputSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    async *execute(input: SearchCodebaseInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const parsed = searchCodebaseInputSchema.safeParse(input)
      if (!parsed.success) {
        yield { type: "result", result: errResult(`invalid input: ${parsed.error.message}`) }
        return
      }
      if (ctx.signal.aborted) {
        yield { type: "result", result: errResult("aborted before start") }
        return
      }
      if (pipeline === undefined) {
        yield {
          type: "result",
          result: errResult(
            "no SearchPipeline wired; set QUANTA_PIPELINE=<preset> at composition root",
            { mode: "error", modelVisibleError: "no_pipeline_wired" },
          ),
        }
        return
      }
      const k = parsed.data.k ?? SEARCH_CODEBASE_DEFAULT_K
      const result = await runPipelineSearch(pipeline, parsed.data.query, k)
      yield { type: "result", result }
    },
  })
}
