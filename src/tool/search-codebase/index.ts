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

import { isAbsolute } from "node:path"
import { z } from "zod"
import type { PipelineError, SearchHit, SearchPipeline } from "@/retrieval/pipeline"
import { errMessage } from "@/shared"
import type { CoreToolContext, Tool, ToolEvent, ToolResult } from "../types"

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
  scope: z
    .string()
    .max(1_024)
    .optional()
    .describe(
      "Restrict results to a workspace-relative directory prefix, e.g. 'src/auth'. " +
        "Omit (or pass '') to search the whole workspace.",
    ),
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

/** The path a hit renders/filters under — `metadata.path` when present, else
 *  the hit id. Kept as ONE helper so `renderHits` and the scope filter agree
 *  on what "the path" is (drift between the two would let a scope filter and
 *  the rendered line disagree). */
const hitPath = (h: SearchHit): string => {
  const md = h.metadata as Record<string, unknown> | undefined
  return typeof md?.path === "string" ? md.path : h.id
}

/** ONE separator-space normalizer used by BOTH `normalizeScope` and `inScope`
 *  so the scope and the hit-path it is compared against always live in the same
 *  form (the prior split — scope kept `\`/`./`, path folded them — silently
 *  filtered out 100% of hits for a backslash / `./`-prefixed scope). Folds
 *  `\`→`/`, strips ALL repeated leading `./`, and strips trailing slashes.
 *  Pure string transform; never touches the filesystem. */
const foldPathish = (s: string): string =>
  s
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "")

/** Normalize a model-supplied `scope` to a workspace-relative directory
 *  prefix. Returns `null` when the scope escapes the workspace (absolute path,
 *  or any `..` segment) so the caller can reject with a typed error — the same
 *  posture the `grep`/`glob` tools take on a traversal pattern. An empty/blank
 *  scope — AND the current-directory family (`.`, `./`, `././`) — normalizes to
 *  `""` (no filter): a model passing `.` means "the whole workspace", not "a
 *  directory literally named dot" (which would match nothing). */
const normalizeScope = (scope: string): string | null => {
  const trimmed = scope.trim()
  if (trimmed === "") return ""
  if (isAbsolute(trimmed)) return null
  const cleaned = foldPathish(trimmed)
  if (cleaned === "" || cleaned === ".") return ""
  if (cleaned.split("/").includes("..")) return null
  return cleaned
}

/** Resolve a model-supplied `scope` into a normalized prefix (or a typed
 *  rejection). Extracted from `execute` so the generator stays under the
 *  cognitive-complexity budget. `undefined`/blank ⇒ `{ scope: "" }` (no
 *  filter); a traversal/absolute scope ⇒ `{ ok: false }`. */
const resolveScope = (
  raw: string | undefined,
): { ok: true; scope: string } | { ok: false; output: string } => {
  if (raw === undefined) return { ok: true, scope: "" }
  const norm = normalizeScope(raw)
  if (norm === null) return { ok: false, output: `scope escapes the workspace: ${raw}` }
  return { ok: true, scope: norm }
}

/** True when `path` is inside (or equal to) the relative `scope` prefix. Both
 *  sides go through {@link foldPathish} so a hit path recorded on either OS (or
 *  with a `./` prefix) matches a normalized scope. `scope === ""` ⇒ always true
 *  (no filter). */
const inScope = (path: string, scope: string): boolean => {
  if (scope === "") return true
  const p = foldPathish(path)
  return p === scope || p.startsWith(`${scope}/`)
}

const renderHits = (query: string, hits: readonly SearchHit[]): string => {
  if (hits.length === 0) return `No hits for query: ${query}`
  const lines: string[] = [`Found ${hits.length} hit(s) for: ${query}`]
  for (const h of hits) {
    const md = h.metadata as Record<string, unknown> | undefined
    const path = hitPath(h)
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

  async *execute(input: SearchCodebaseInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
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
    // Scope is a POST-filter: most pipelines (lexical default) don't honor a
    // path filter at the engine level, so we filter the ranked hits here. When
    // scoping, widen the candidate pool to the existing MAX_K cap so the filter
    // has enough to slice `k` from — NOT an invented multiplier, just the
    // already-enforced ceiling. Absent/blank scope ⇒ fetch exactly `k` and
    // skip the filter, byte-identical to the pre-scope path.
    const scoped = resolveScope(parsed.data.scope)
    if (!scoped.ok) {
      yield { type: "result", result: errResult(scoped.output, "invalid-config") }
      return
    }
    const filtering = scoped.scope !== ""
    const fetchK = filtering ? MAX_K : k
    let outcome: Awaited<ReturnType<SearchPipeline["search"]>>
    try {
      outcome = await pipeline.search({ text: parsed.data.query, k: fetchK })
    } catch (e) {
      const msg = errMessage(e)
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
    const hits = filtering
      ? outcome.value.filter((h) => inScope(hitPath(h), scoped.scope)).slice(0, k)
      : outcome.value
    yield {
      type: "result",
      result: { ok: true, output: renderHits(parsed.data.query, hits) },
    }
  },
})
