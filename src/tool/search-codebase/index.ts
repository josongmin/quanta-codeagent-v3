/**
 * `search_codebase` tool (ADR-0278).
 *
 * Thin `Tool<I, O>` wrapper around a {@link SearchPipeline}. The factory
 * takes a pipeline at construction time; product surfaces wire one from
 * `search-pipeline-wire.ts`, which now defaults to lexical repo search and
 * upgrades to hybrid when indexing is enabled. The tool still stays OUT of
 * `buildDefaultTools()` because the concrete pipeline depends on cwd and
 * optional indexer lifecycle.
 *
 * The tool is read-only + concurrency-safe (the pipeline never mutates;
 * the indexer's write surface is owned by the composition-root polling
 * loop, NOT the tool). On `pipeline.search(...)` returning `Err`, the
 * tool yields a typed `ToolFailure { mode: "error", modelVisibleError:
 * error.kind }` so the model can branch by error kind.
 */

import { z } from "zod"
import type { PipelineError, SearchHit, SearchPipeline } from "@/retrieval/pipeline"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"

const DEFAULT_K = 10
const MAX_K = 50

export const searchCodebaseInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(4_000)
    .describe("Natural-language or symbol query describing what to find in the workspace"),
  k: z
    .number()
    .int()
    .positive()
    .max(MAX_K)
    .optional()
    .describe(`Max ranked hits to return (default ${DEFAULT_K}, max ${MAX_K})`),
})

export type SearchCodebaseInput = z.infer<typeof searchCodebaseInputSchema>

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

const intMeta = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v)
  return undefined
}

const rangeLabel = (metadata: Record<string, unknown> | undefined): string => {
  const startLine = intMeta(metadata?.startLine)
  const endLine = intMeta(metadata?.endLine)
  if (startLine === undefined && endLine === undefined) return ""
  if (startLine !== undefined && endLine !== undefined) {
    return startLine === endLine ? `:${startLine}` : `:${startLine}-${endLine}`
  }
  return `:${startLine ?? endLine}`
}

const renderHits = (query: string, hits: readonly SearchHit[]): string => {
  if (hits.length === 0) return `No hits for query: ${query}`
  const lines: string[] = [`Found ${hits.length} hit(s) for: ${query}`]
  for (const h of hits) {
    const md = h.metadata as Record<string, unknown> | undefined
    const path = typeof md?.path === "string" ? md.path : h.id
    const range = rangeLabel(md)
    const score = h.score.toFixed(4)
    const rawSnippet =
      h.text.trim() !== "" ? h.text : typeof md?.snippet === "string" ? md.snippet : ""
    const snippet = truncate(rawSnippet.replace(/\s+/g, " ").trim(), 160)
    lines.push(
      snippet === ""
        ? `${path}${range}  [${h.source} score=${score}]`
        : `${path}${range}  [${h.source} score=${score}] ${snippet}`,
    )
  }
  return lines.join("\n")
}

const errResult = (output: string, kind: PipelineError["kind"]): ToolResult => ({
  ok: false,
  output,
  failure: { mode: "error", modelVisibleError: kind },
})

/**
 * Factory — `searchCodebaseTool(pipeline)` returns a tool that
 * delegates every query to the injected pipeline. When the pipeline is
 * absent, callers should NOT register this tool at all (see ADR-0278
 * truth table) — the factory does NOT ship a no-pipeline fallback
 * because the model should never see a "no pipeline wired" error: a
 * disabled wire means the tool is simply not advertised.
 */
export const searchCodebaseTool = (pipeline: SearchPipeline): Tool<SearchCodebaseInput> => ({
  name: "search_codebase",
  description:
    "Workspace code search over the wired SearchPipeline. Depending on surface wiring this may " +
    "be lexical-only or hybrid lexical+semantic. Returns ranked hits with file path, line range, " +
    "and a short snippet. Use when you need to find where a concept or symbol lives without " +
    "knowing the exact file. Read-only.",
  inputSchema: searchCodebaseInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: SearchCodebaseInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = searchCodebaseInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `invalid input: ${parsed.error.message}`,
          failure: { mode: "error", modelVisibleError: "invalid-config" },
        },
      }
      return
    }
    if (ctx.signal.aborted) {
      yield { type: "result", result: errResult("aborted before start", "stage-failed") }
      return
    }
    const k = parsed.data.k ?? DEFAULT_K
    let outcome: Awaited<ReturnType<SearchPipeline["search"]>>
    try {
      outcome = await pipeline.search({ text: parsed.data.query, k })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      yield {
        type: "result",
        result: errResult(`pipeline threw: ${msg}`, "stage-failed"),
      }
      return
    }
    if (!outcome.ok) {
      yield {
        type: "result",
        result: errResult(`search failed: ${outcome.error.kind}`, outcome.error.kind),
      }
      return
    }
    yield {
      type: "result",
      result: { ok: true, output: renderHits(parsed.data.query, outcome.value) },
    }
  },
})
