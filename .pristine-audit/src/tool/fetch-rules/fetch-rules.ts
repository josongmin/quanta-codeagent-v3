/** `fetch_rules` — agent-requested rule retrieval (gap-other-agent GAP 6, ADR-0509).
 *
 *  Cursor's "agent-requested" rules: description-only rule files the model summons
 *  ON DEMAND (by describing its task) rather than having auto-injected every turn.
 *  This tool ranks the requestable-rules index by description overlap (via the
 *  injected {@link FetchRulesPort}) and returns the matching rule bodies in-band.
 *
 *  PURE interaction: it reads rules, never mutates files / runs shells.
 *  `isReadOnly:true`, `hitlTier:"none"`. NEVER throws past the loop — bad input or
 *  a thrown port collapses to a graceful `ok:false`. Plane-clean: `../types` +
 *  `zod` + `@/shared` only (the index + matcher live behind the port). */
import { z } from "zod"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "../types"
import type { FetchedRule, FetchRulesPort } from "./port"

/** Query cap — a focused lookup, not a context dump (sibling tools cap inputs). */
export const FETCH_RULES_MAX_QUERY = 2000
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10

export const fetchRulesInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(FETCH_RULES_MAX_QUERY)
    .describe(
      "Describe the task / convention / pattern you need rules for (keywords). " +
        "Returns the repo's agent-requested (description-only) rules ranked by match.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Max rules to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
})
export type FetchRulesInput = z.infer<typeof fetchRulesInputSchema>

const render = (rules: readonly FetchedRule[]): string => {
  if (rules.length === 0) return "No matching agent-requested rules."
  return rules.map((r) => `### ${r.name} — ${r.description}\n${r.body}`).join("\n\n")
}

export const fetchRulesTool = (port: FetchRulesPort): Tool<FetchRulesInput> => ({
  name: "fetch_rules",
  description:
    "Fetch the repo's agent-requested rules (description-only rule files) that " +
    "match a task description. Call this BEFORE implementing when you need a repo " +
    "convention or pattern; returns ranked rule bodies. Read-only.",
  inputSchema: fetchRulesInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  hitlTier: () => "none",
  async *execute(input, c: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = fetchRulesInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    if (c.signal.aborted) {
      yield { type: "result", result: { ok: false, output: "aborted before start" } }
      return
    }
    let matches: readonly FetchedRule[]
    try {
      matches = await port.fetch(parsed.data.query, parsed.data.limit ?? DEFAULT_LIMIT)
    } catch (e) {
      yield {
        type: "result",
        result: { ok: false, output: `fetch_rules failed: ${errMessage(e)}` },
      }
      return
    }
    yield { type: "result", result: { ok: true, output: render(matches) } }
  },
})
