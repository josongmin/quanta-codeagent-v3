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

/** Split a tool name into lowercase tokens (camelCase / snake / dot / mcp__). */
const tokenize = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean)

/**
 * Lexical relevance score of one tool spec against the query terms:
 * exact-name short-circuit, token hits, substring hits, description hits.
 */
const score = (spec: ToolSpec, terms: string[], rawQuery: string): number => {
  const nameLc = spec.name.toLowerCase()
  if (nameLc === rawQuery.trim().toLowerCase()) return Number.POSITIVE_INFINITY
  const nameTokens = new Set(tokenize(spec.name))
  const descLc = spec.description.toLowerCase()
  let s = 0
  for (const term of terms) {
    if (nameTokens.has(term)) s += 10
    else if (nameLc.includes(term)) s += 5
    if (descLc.includes(term)) s += 2
  }
  return s
}

const formatSpec = (spec: ToolSpec): string =>
  `### ${spec.name}\n${spec.description}\ninput_schema: ${JSON.stringify(spec.input_schema)}`

/** `select:A,B` mode — resolve tool specs by exact (case-insensitive) name. */
const runSelect = (all: ToolSpec[], rawSelection: string): { ok: boolean; output: string } => {
  const wanted = rawSelection
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const byName = new Map(all.map((t) => [t.name.toLowerCase(), t]))
  const found: ToolSpec[] = []
  const missing: string[] = []
  for (const w of wanted) {
    const hit = byName.get(w.toLowerCase())
    if (hit) found.push(hit)
    else missing.push(w)
  }
  const head = found.length === 0 ? "No matching tools found." : found.map(formatSpec).join("\n\n")
  const tail = missing.length > 0 ? `\n\nUnknown: ${missing.join(", ")}` : ""
  return { ok: found.length > 0, output: head + tail }
}

/** Keyword mode — lexical ranking over name + description. */
const runKeyword = (
  all: ToolSpec[],
  query: string,
  max: number,
): { ok: boolean; output: string } => {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^\+/, "")) // tolerate CC's "+required" prefix
    .filter(Boolean)
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
 *   - `select:A,B,C` — return those tools' schemas by exact name.
 *   - keyword        — lexical ranking over name + description.
 * Returns the best-matching tool schemas (name + description + input_schema) as
 * formatted text so the model can discover which of many available tools to use.
 *
 * Scope/honesty: this is purely a lexical *catalog discovery aid*. It searches
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
    'Use "select:Name1,Name2" for exact lookup by name, or keywords for a ranked ' +
    "search. This is a discovery aid only: every returned tool is already " +
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
