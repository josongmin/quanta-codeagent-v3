import { z } from "zod"
import { runShell } from "@/runtime"
import { FsJailError, resolveJailed } from "@/storage"
import type { Tool, ToolContext, ToolEvent } from "../types"

const schema = z.object({
  query: z.string().describe("Natural-language or symbol query describing the suspected fault"),
  path: z.string().optional().describe("File or directory to scope the search (default cwd)"),
  max_results: z.number().optional().describe("Max ranked lines to return (default 20)"),
})

type Input = z.infer<typeof schema>

const DEFAULT_MAX = 20
const MAX_RG_LINES = 4000
const SNIPPET_CAP = 160

const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

/** Split a query into lowercased alphanumeric tokens ≥3 chars (deduped). */
const tokenize = (query: string): string[] => {
  const raw = query.toLowerCase().match(/[a-z0-9_]+/g) ?? []
  return [...new Set(raw.filter((t) => t.length >= 3))]
}

interface Hit {
  file: string
  line: number
  text: string
  terms: Set<string>
}

/** Parse one ripgrep `path:line:text` row. Returns undefined if malformed. */
const parseRow = (row: string): { file: string; line: number; text: string } | undefined => {
  const m = row.match(/^(.+?):(\d+):(.*)$/)
  if (!m) return undefined
  const [, file, lineStr, text] = m
  const line = Number(lineStr)
  if (!file || !Number.isFinite(line)) return undefined
  return { file, line, text: text ?? "" }
}

/** Run ripgrep for one term, fold matches into the per-line hit map. */
const collectTerm = async (
  term: string,
  ctx: ToolContext,
  scope: string | undefined,
  hits: Map<string, Hit>,
): Promise<void> => {
  const parts = ["rg", "--line-number", "--no-heading", "--color=never", "-i", "-e", sq(term)]
  if (scope) parts.push(sq(scope))
  const r = await runShell(parts.join(" "), { cwd: ctx.cwd, signal: ctx.signal })
  if (r.exitCode > 1 || r.timedOut) return
  for (const row of r.stdout.split("\n").slice(0, MAX_RG_LINES)) {
    const parsed = parseRow(row)
    if (!parsed) continue
    const key = `${parsed.file}:${parsed.line}`
    const existing = hits.get(key)
    if (existing) {
      existing.terms.add(term)
    } else {
      hits.set(key, {
        file: parsed.file,
        line: parsed.line,
        text: parsed.text.trim(),
        terms: new Set([term]),
      })
    }
  }
}

/** Score = distinct terms on the line, plus a small bonus when a query term
 *  also appears in the file path (filename relevance). Deterministic. */
const scoreHit = (hit: Hit, tokens: string[]): number => {
  const lower = hit.file.toLowerCase()
  const nameBonus = tokens.reduce((acc, t) => (lower.includes(t) ? acc + 0.5 : acc), 0)
  return hit.terms.size * 10 + nameBonus
}

/** Render ranked hits grouped by file, in score order, capped at `max`. */
const render = (hits: Hit[], tokens: string[], max: number): string => {
  const ranked = [...hits]
    .map((h) => ({ h, score: scoreHit(h, tokens) }))
    .sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : a.h.file !== b.h.file
          ? a.h.file.localeCompare(b.h.file)
          : a.h.line - b.h.line,
    )
    .slice(0, max)

  const byFile = new Map<string, typeof ranked>()
  for (const entry of ranked) {
    const bucket = byFile.get(entry.h.file) ?? []
    bucket.push(entry)
    byFile.set(entry.h.file, bucket)
  }

  const out: string[] = []
  for (const [file, entries] of byFile) {
    out.push(file)
    for (const { h } of entries) {
      const snippet = h.text.length > SNIPPET_CAP ? `${h.text.slice(0, SNIPPET_CAP)}…` : h.text
      out.push(`  ${file}:${h.line}  ${snippet}`)
    }
  }
  return out.join("\n")
}

/**
 * SWE-bench-style heuristic fault localizer. Tokenizes the query, gathers
 * candidate lines per term via ripgrep, then ranks by term-hit density with a
 * filename-relevance bonus. Read-only and concurrency-safe (rg has no side
 * effects). Deterministic for a fixed tree. Not an LSP — a fast locator.
 */
export const localizeTool: Tool<Input> = {
  name: "localize",
  description:
    "Rank likely fault locations for a query. Returns `path:line  <snippet>` rows " +
    "grouped by file, ordered by term-hit density and filename relevance.",
  inputSchema: schema,
  isReadOnly: () => true,
  // Only spawns ripgrep reads; no shared mutable state. Safe to parallelize.
  isConcurrencySafe: () => true,

  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    yield { type: "progress", message: `localizing: ${input.query}` }

    const tokens = tokenize(input.query)
    if (tokens.length === 0) {
      yield { type: "result", result: { ok: true, output: "(no candidates: empty query)" } }
      return
    }

    // S14: jail the scope path BEFORE any rg invocation. Without this,
    // `path: "/etc"` would scope the search to the host filesystem.
    let scope: string | undefined
    if (input.path !== undefined) {
      try {
        scope = resolveJailed(input.path, ctx.cwd)
      } catch (e) {
        if (e instanceof FsJailError) {
          yield { type: "result", result: { ok: false, output: e.message } }
          return
        }
        throw e
      }
    }

    const hits = new Map<string, Hit>()
    for (const term of tokens) {
      await collectTerm(term, ctx, scope, hits)
    }

    if (hits.size === 0) {
      yield { type: "result", result: { ok: true, output: "(no candidates)" } }
      return
    }

    const max = input.max_results ?? DEFAULT_MAX
    yield { type: "result", result: { ok: true, output: render([...hits.values()], tokens, max) } }
  },
}
