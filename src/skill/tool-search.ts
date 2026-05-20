import { z } from "zod"
import type { Tool, ToolContext, ToolEvent, ToolSpec } from "@/tool"

const schema = z.object({
  query: z
    .string()
    .describe(
      "Query to find tools in this agent's tool catalog. Use " +
        '"select:<tool_name>[,<tool_name>...]" for direct lookup by name, or ' +
        "keywords for a ranked search.",
    ),
  max_results: z.number().optional().describe("Maximum number of results (default 5)"),
})

type Input = z.infer<typeof schema>

/** Split a string into lowercase tokens, honoring camelCase / snake_case /
 *  kebab-case / dot / `mcp__` separators. Applied to BOTH catalog identifiers
 *  (tool name, aliases) and to user queries — a compound query like
 *  `"lspDocumentSymbol"` therefore matches `lsp_document_symbol` and vice
 *  versa, restoring the lexical symmetry the original whitespace-only query
 *  split lacked. */
const tokenize = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean)

/** Split a description into `[firstLine, body]`. The first line is everything
 *  up to (but not including) the first `\n` or sentence-terminating
 *  punctuation followed by whitespace/end (`. ` / `? ` / `! ` / trailing
 *  `.`). When the description has no such break the entire description IS
 *  the first line and `body` is empty. Used so first-line ("tagline")
 *  matches score higher than matches deep in the body. */
const splitDescription = (description: string): { firstLine: string; body: string } => {
  const nl = description.indexOf("\n")
  const sentenceMatch = description.match(/[.?!](?:\s|$)/)
  const candidates: number[] = []
  if (nl >= 0) candidates.push(nl)
  if (sentenceMatch && typeof sentenceMatch.index === "number") {
    candidates.push(sentenceMatch.index)
  }
  if (candidates.length === 0) return { firstLine: description, body: "" }
  const cut = Math.min(...candidates)
  return { firstLine: description.slice(0, cut), body: description.slice(cut) }
}

/**
 * Lexical relevance score of one tool spec against the (already-tokenized)
 * query terms. Weights:
 *   - exact name OR alias match (full query) → +Infinity short-circuit
 *   - per-term token hit on name or any alias → +10
 *   - per-term substring hit on name or any alias → +5
 *   - per-term substring hit on description FIRST LINE ("tagline") → +4
 *   - per-term substring hit on description BODY → +2
 * Aliases (optional) carry the same weight as the canonical name so an
 * intuitive synonym surfaces the right tool. Description first-line bumps
 * the tagline above buried body matches.
 */
/** Per-spec scoring bundle: the lowercase strings/sets needed to score every
 *  term against one tool spec. Extracted so the hot loop in `score` stays
 *  flat and readable. */
interface ScoringFields {
  nameTokens: Set<string>
  nameSubstrings: string[]
  firstLineLc: string
  bodyLc: string
}

const buildScoringFields = (spec: ToolSpec): ScoringFields => {
  const nameTokens = new Set(tokenize(spec.name))
  for (const a of spec.aliases ?? []) {
    for (const tok of tokenize(a)) nameTokens.add(tok)
  }
  const nameSubstrings = [
    spec.name.toLowerCase(),
    ...(spec.aliases ?? []).map((a) => a.toLowerCase()),
  ]
  const { firstLine, body } = splitDescription(spec.description)
  return {
    nameTokens,
    nameSubstrings,
    firstLineLc: firstLine.toLowerCase(),
    bodyLc: body.toLowerCase(),
  }
}

/** Per-term contribution to the score. Name/alias hits cap out at the
 *  better of token (10) or substring (5); description hits stack
 *  first-line (4) + body (2) independently. */
const scoreTerm = (term: string, f: ScoringFields): number => {
  let s = 0
  if (f.nameTokens.has(term)) s += 10
  else if (f.nameSubstrings.some((n) => n.includes(term))) s += 5
  if (f.firstLineLc.includes(term)) s += 4
  if (f.bodyLc.includes(term)) s += 2
  return s
}

const score = (spec: ToolSpec, terms: string[], rawQuery: string): number => {
  const rawLc = rawQuery.trim().toLowerCase()
  const nameLc = spec.name.toLowerCase()
  const aliasesLc = (spec.aliases ?? []).map((a) => a.toLowerCase())
  if (nameLc === rawLc || aliasesLc.includes(rawLc)) return Number.POSITIVE_INFINITY

  const fields = buildScoringFields(spec)
  let s = 0
  for (const term of terms) s += scoreTerm(term, fields)
  return s
}

const formatSpec = (spec: ToolSpec): string =>
  `### ${spec.name}\n${spec.description}\ninput_schema: ${JSON.stringify(spec.input_schema)}`

/** `select:A,B` mode — resolve tool specs by exact (case-insensitive) name
 *  OR alias. Resolution prefers a canonical-name hit and falls back to an
 *  alias match only when no name matches; this keeps existing select queries
 *  (which always used the canonical name) byte-identical and adds alias
 *  resolution as a strict superset. */
const runSelect = (all: ToolSpec[], rawSelection: string): { ok: boolean; output: string } => {
  const wanted = rawSelection
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const byName = new Map(all.map((t) => [t.name.toLowerCase(), t]))
  const byAlias = new Map<string, ToolSpec>()
  for (const t of all) {
    for (const a of t.aliases ?? []) {
      const key = a.toLowerCase()
      if (!byName.has(key) && !byAlias.has(key)) byAlias.set(key, t)
    }
  }
  const found: ToolSpec[] = []
  const missing: string[] = []
  for (const w of wanted) {
    const key = w.toLowerCase()
    const hit = byName.get(key) ?? byAlias.get(key)
    if (hit) found.push(hit)
    else missing.push(w)
  }
  const head = found.length === 0 ? "No matching tools found." : found.map(formatSpec).join("\n\n")
  const tail = missing.length > 0 ? `\n\nUnknown: ${missing.join(", ")}` : ""
  return { ok: found.length > 0, output: head + tail }
}

/** Keyword mode — lexical ranking over name + aliases + description.
 *  Query is split on whitespace AND on camelCase/snake/kebab/dot boundaries
 *  so a compound query (`"lspDocumentSymbol"`) decomposes into the same
 *  token vocabulary as the catalog identifiers it should match. */
const runKeyword = (
  all: ToolSpec[],
  query: string,
  max: number,
): { ok: boolean; output: string } => {
  // Preserve original case on the whitespace split so `tokenize` can still
  // see camelCase boundaries (`lspDocumentSymbol` → ["lsp","document",
  // "symbol"]). Each token is then lowercased downstream.
  const rawTerms = query
    .split(/\s+/)
    .map((t) => t.replace(/^\+/, "")) // tolerate CC's "+required" prefix
    .filter(Boolean)
  // Expand each whitespace-token through the identifier tokenizer so
  // `lspDocumentSymbol` → ["lsp", "document", "symbol"] participate in
  // ranking. Single-word queries are unchanged (`tokenize("read")` ⇒
  // ["read"]), preserving baseline scores for the common case.
  const expanded = new Set<string>()
  for (const t of rawTerms) {
    expanded.add(t.toLowerCase())
    for (const sub of tokenize(t)) expanded.add(sub)
  }
  const terms = [...expanded]
  const ranked = all
    .map((spec) => ({ spec, s: score(spec, terms, query) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, max)

  if (ranked.length === 0) {
    return { ok: false, output: `No matching tools found for: ${query}` }
  }
  return { ok: true, output: ranked.map((r) => formatSpec(r.spec)).join("\n\n") }
}

/**
 * The `ToolSearch` tool. Input `{ query, max_results? }`. Two modes:
 *   - `select:A,B,C` — return those tools' schemas by exact name or alias.
 *   - keyword        — lexical ranking over name + aliases + description.
 * Returns the best-matching tool schemas (name + description + input_schema) as
 * formatted text so the model can discover which of many available tools to use.
 *
 * Lexical accuracy improvements (intentional, still purely client-side):
 *   1. compound-query tokenization — `"lspDocumentSymbol"` decomposes to
 *      ["lsp", "document", "symbol"] and matches `lsp_document_symbol`.
 *   2. first-line ("tagline") weight 4 vs body weight 2 so the tool's
 *      summary punch line ranks above buried body keywords.
 *   3. optional `ToolSpec.aliases` carrying name-equivalent weight so
 *      common synonyms surface the right tool. Tools that omit `aliases`
 *      see byte-identical scoring.
 *
 * Scope/honesty: this is still a lexical *catalog discovery aid*. It searches
 * the tool catalog passed in and returns matching schemas as text — nothing
 * more. It does NOT defer tools, does NOT inject tool definitions into the live
 * API `tools` array, and does NOT emit `tool_reference` blocks. Our
 * provider-neutral LLMPort has no server-side tool deferral, so there is no
 * deferred-tool mechanism here to expand; every tool in the catalog is already
 * callable. ToolSearch only helps the model *find* the right one by name/topic.
 */
export const createToolSearchTool = (catalog: () => ToolSpec[]): Tool<Input> => ({
  name: "ToolSearch",
  description:
    "Search this agent's tool catalog and return matching tool schemas as text " +
    "(name, description, input_schema) so you can find the right tool among many. " +
    'Use "select:Name1,Name2" for exact lookup by name or alias, or keywords for a ' +
    "ranked search. This is a discovery aid only: every returned tool is already " +
    "available to call directly. It does not unlock or load anything.",
  inputSchema: schema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: Input, _ctx: ToolContext): AsyncIterable<ToolEvent> {
    const all = catalog()
    const max = input.max_results ?? 5
    const query = input.query.trim()

    const sel = query.match(/^select:(.+)$/i)
    const result = sel ? runSelect(all, sel[1] ?? "") : runKeyword(all, query, max)
    yield { type: "result", result }
  },
})
