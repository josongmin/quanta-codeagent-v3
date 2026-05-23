import { z } from "zod"
import { runShell } from "@/runtime"
import { byteCompare } from "@/shared"
import { FsJailError, resolveJailed } from "@/storage"
import { classifyFrame, type FrameTier } from "../parse-test-failure"
import type { Tool, ToolContext, ToolEvent } from "../types"

const schema = z.object({
  query: z.string().describe("Natural-language or symbol query describing the suspected fault"),
  path: z.string().optional().describe("File or directory to scope the search (default cwd)"),
  max_results: z.number().optional().describe("Max ranked lines to return (default 20)"),
  verbose: z.boolean().optional().describe("Include per-candidate score and frame tier in output"),
})

type Input = z.infer<typeof schema>

const DEFAULT_MAX = 20
const MAX_RG_LINES = 4000
const SNIPPET_CAP = 160

/** FrameTier additive penalty applied per candidate line (R-Phase9). Mirrors
 *  `parse_test_failure`'s tiering so localize's rank order is consistent with
 *  the build-log signal: user-code matches outrank test matches, both outrank
 *  vendored. `vendored = -50` effectively buries `node_modules/`, `.venv/`,
 *  etc. — hits are still RETURNED (visible to the model) but cannot push
 *  user-code matches out of `max_results`. */
const TIER_PENALTY: Record<FrameTier, number> = { user: 0, test: -2, vendored: -50 }

/** Definition-pattern grammar. Matches the line-leading shape of a symbol
 *  definition across JS/TS/Python/Rust/Go/etc.: captures the declared
 *  identifier in group 5. Used to boost definition sites over use sites
 *  ("owner = definition" — SKILL.md Stage 2 rule). */
const DEF_RE =
  /^\s*(export\s+)?(default\s+)?(async\s+)?(function|const|let|var|class|def|fn|impl|type|interface|enum|struct|trait)\s+([A-Za-z_$][\w$]*)/

const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

/** Split a query into lowercased subtokens, honoring camelCase / snake_case /
 *  kebab-case / dot separators (≥3 chars, deduped). Symmetric with the catalog
 *  tokenizer in `src/skill/tool-search.ts`, so `validateUserInput` ↔
 *  `validate_user_input` match the same set of identifiers regardless of
 *  which casing the user typed. */
const tokenize = (query: string): string[] => {
  const raw = query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3)
  return [...new Set(raw)]
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

/** Per-term outcome from one rg invocation. `files` is the distinct-file set
 *  for IDF; `saturated` is true if the term hit (or exceeded) MAX_RG_LINES
 *  rows — the self-measured noise-floor signal. */
interface TermStat {
  files: Set<string>
  saturated: boolean
}

/** Run ripgrep for one term, fold matches into the per-line hit map, and
 *  return the per-term stats used for IDF. The `hits` Map is single-threaded
 *  in the JS event loop — concurrent rg subprocesses, single writer. */
const collectTerm = async (
  term: string,
  ctx: ToolContext,
  scope: string | undefined,
  hits: Map<string, Hit>,
): Promise<TermStat> => {
  const stat: TermStat = { files: new Set(), saturated: false }
  const parts = ["rg", "--line-number", "--no-heading", "--color=never", "-i", "-e", sq(term)]
  if (scope) parts.push(sq(scope))
  const r = await runShell(parts.join(" "), { cwd: ctx.cwd, signal: ctx.signal })
  if (r.exitCode > 1 || r.timedOut) return stat
  const rows = r.stdout.split("\n")
  if (rows.length >= MAX_RG_LINES) stat.saturated = true
  for (const row of rows.slice(0, MAX_RG_LINES)) {
    const parsed = parseRow(row)
    if (!parsed) continue
    stat.files.add(parsed.file)
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
  return stat
}

/** Count files in scope via `rg --files`. Used as the BM25 corpus size N. */
const countScopeFiles = async (ctx: ToolContext, scope: string | undefined): Promise<number> => {
  const parts = ["rg", "--files"]
  if (scope) parts.push(sq(scope))
  const r = await runShell(parts.join(" "), { cwd: ctx.cwd, signal: ctx.signal })
  if (r.exitCode > 1 || r.timedOut) return 0
  // Count non-empty lines.
  let n = 0
  for (const ln of r.stdout.split("\n")) if (ln.length > 0) n++
  return n
}

/** Standard BM25 IDF, with self-measured noise floor: a saturating term
 *  (rg output truncated, i.e. the term matches *everywhere*) contributes 0.
 *  No hardcoded stop-word list — RFC §[no-heuristics-only-validated]. */
const idfFor = (term: string, stats: Map<string, TermStat>, N: number): number => {
  const s = stats.get(term)
  if (!s || s.saturated) return 0
  const df = s.files.size
  if (df === 0) return 0
  return Math.log((N - df + 0.5) / (df + 0.5) + 1)
}

/** Score a hit: Σ IDF(t) over distinct terms on the line, plus a path-name
 *  bonus weighted by max(IDF) (so a token appearing in the file path lifts
 *  the hit only when that token is itself discriminating), plus the
 *  definition-site boost, plus the FrameTier penalty. Deterministic. */
const scoreHit = (
  hit: Hit,
  tokens: string[],
  stats: Map<string, TermStat>,
  N: number,
  tier: FrameTier,
): number => {
  let s = 0
  let maxIdf = 0
  for (const t of hit.terms) {
    const i = idfFor(t, stats, N)
    s += i
    if (i > maxIdf) maxIdf = i
  }
  const lower = hit.file.toLowerCase()
  for (const t of tokens) if (lower.includes(t)) s += maxIdf * 0.5
  const m = hit.text.match(DEF_RE)
  if (m) {
    const ident = (m[5] ?? "").toLowerCase()
    const subtokens = new Set(tokenize(ident))
    for (const t of hit.terms)
      if (subtokens.has(t)) {
        s += 3
        break
      }
  }
  s += TIER_PENALTY[tier]
  return s
}

/** Render ranked hits grouped by file, in score order, capped at `max`. */
const render = (
  hits: Hit[],
  tokens: string[],
  stats: Map<string, TermStat>,
  N: number,
  max: number,
  verbose: boolean,
): string => {
  const ranked = hits
    .map((h) => {
      const tier = classifyFrame(h.file)
      return { h, tier, score: scoreHit(h, tokens, stats, N, tier) }
    })
    .sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : a.h.file !== b.h.file
          ? byteCompare(a.h.file, b.h.file)
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
    for (const { h, score, tier } of entries) {
      const snippet = h.text.length > SNIPPET_CAP ? `${h.text.slice(0, SNIPPET_CAP)}…` : h.text
      if (verbose) {
        out.push(`  ${file}:${h.line}  [score=${score.toFixed(2)} tier=${tier}]  ${snippet}`)
      } else {
        out.push(`  ${file}:${h.line}  ${snippet}`)
      }
    }
  }
  return out.join("\n")
}

/** Resolve the optional scope path inside the jail. Returns `{ ok: scope }`
 *  on success, `{ ok: undefined, err }` if `path` violates the FS jail. */
const resolveScope = (
  inputPath: string | undefined,
  cwd: string,
): { scope: string | undefined; err?: string } => {
  if (inputPath === undefined) return { scope: undefined }
  try {
    return { scope: resolveJailed(inputPath, cwd) }
  } catch (e) {
    if (e instanceof FsJailError) return { scope: undefined, err: e.message }
    throw e
  }
}

/** True iff at least one token in `stats` is discriminating (non-saturated,
 *  matched ≥1 file). False means the whole query is noise in this tree. */
const hasDiscriminatingTerm = (tokens: string[], stats: Map<string, TermStat>): boolean => {
  for (const t of tokens) {
    const s = stats.get(t)
    if (s && !s.saturated && s.files.size > 0) return true
  }
  return false
}

/**
 * SWE-bench-style heuristic fault locator. Splits the query into camelCase /
 * snake / kebab / dot subtokens (symmetric with `tool-search.ts`), runs rg
 * per token in parallel, then ranks lines by BM25-lite IDF (with a
 * self-measured noise floor: a token whose rg output saturates contributes
 * zero, so high-frequency terms drop out without any hardcoded stop-word
 * list). FrameTier-aware via `classifyFrame` (vendored buried, test deprioritized),
 * definition-pattern boost rewards owner sites over use sites, optional
 * `verbose` mode exposes per-row score + tier. Read-only, concurrency-safe,
 * deterministic for a fixed tree. Source: Agentless (Xia et al., 2024)
 * file→function funnel + Codex signal hierarchy (`docs/reviews-codex-agent/
 * may-20-codex-signal.md`, source 10/10 > log 8/9 > rg 5/10) + BM25 IDF.
 */
export const localizeTool: Tool<Input> = {
  name: "localize",
  description:
    "Rank likely fault locations for a query. Returns `path:line  <snippet>` rows " +
    "grouped by file, ordered by BM25-lite IDF, filename relevance, definition-site " +
    "boost, and FrameTier (user > test > vendored).",
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
    const { scope, err } = resolveScope(input.path, ctx.cwd)
    if (err !== undefined) {
      yield { type: "result", result: { ok: false, output: err } }
      return
    }

    // Corpus size (N) and per-term rg in parallel. The `hits` Map is single-
    // threaded under the JS event loop — many concurrent rg subprocesses,
    // one writer. Output stays deterministic because `render` sorts by
    // (score desc, file bytes, line ASC); insertion order doesn't escape.
    const hits = new Map<string, Hit>()
    const stats = new Map<string, TermStat>()
    const [N, perTerm] = await Promise.all([
      countScopeFiles(ctx, scope),
      Promise.all(tokens.map((t) => collectTerm(t, ctx, scope, hits))),
    ])
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      const s = perTerm[i]
      if (t !== undefined && s !== undefined) stats.set(t, s)
    }

    if (N === 0 || hits.size === 0) {
      yield { type: "result", result: { ok: true, output: "(no candidates)" } }
      return
    }

    // Every term saturated → query is too generic to discriminate anything
    // in this tree. Surface the distinct user-visible message.
    if (!hasDiscriminatingTerm(tokens, stats)) {
      yield {
        type: "result",
        result: { ok: true, output: "(no candidates: query too generic for this tree)" },
      }
      return
    }

    const max = input.max_results ?? DEFAULT_MAX
    const verbose = input.verbose ?? false
    yield {
      type: "result",
      result: { ok: true, output: render([...hits.values()], tokens, stats, N, max, verbose) },
    }
  },
}
