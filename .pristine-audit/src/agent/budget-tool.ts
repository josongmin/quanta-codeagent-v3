/**
 * `budget_status` tool (ADR-0136).
 *
 * Read-only surface the agent can query to see its own per-session / per-day /
 * per-model cumulative cost. Wired by `src/agent/tier1/budget.ts` when
 * `config.budgetLedger` is provided; absent ⇒ the tool is NOT registered, so
 * the model never sees it (default-OFF, byte-identical for every existing
 * session).
 *
 * Slice posture:
 *   - imports `@/tool` (factory + types) + `zod` + the ledger module.
 *   - does NOT import `@/agent/loop`, `@/agent/dispatch`, `@/permission` —
 *     this is a self-contained leaf tool over a typed port.
 *
 * The factory takes a `BudgetLedger` (the only injected dependency). Callers
 * who want the tool but have no ledger can simply not wire it; the tier1
 * builder gates on the ledger's presence.
 */

import { z } from "zod"
import type { Tool } from "@/tool"
import { defineTool } from "@/tool"
import type { BudgetLedger, CostBreakdown } from "./budget-ledger"

/** Input schema for `budget_status`. Both fields optional; defaults are
 *  `scope:"all"`, `format:"compact"`. */
const inputSchema = z.object({
  scope: z.enum(["all", "session", "day"]).optional(),
  format: z.enum(["compact", "detailed"]).optional(),
})

type Input = z.infer<typeof inputSchema>

/** Format a number as a USD amount with 2 decimal places. */
const usd = (n: number): string => `$${n.toFixed(2)}`

/** Format a single per-model line: `<model>: $X.XX` (compact) or with token
 *  counts (detailed). */
const renderModelLine = (b: CostBreakdown, detailed: boolean): string => {
  if (!detailed) return `${b.model}: ${usd(b.totalCost)}`
  const tokens = `${b.inputTokens}in / ${b.outputTokens}out`
  const cache =
    b.cacheReadTokens + b.cacheWriteTokens > 0
      ? ` (cache r:${b.cacheReadTokens} w:${b.cacheWriteTokens})`
      : ""
  return `${b.model}: ${usd(b.totalCost)} — ${tokens}${cache}`
}

/** Format an inline token-count suffix when the caller asked for detailed
 *  output, else an empty string. Extracted so per-section renderers stay
 *  uniform. */
const tokenSuffix = (b: CostBreakdown, detailed: boolean): string =>
  detailed ? ` (${b.inputTokens} in / ${b.outputTokens} out)` : ""

/** Render a `By <label>:` block — heading line + one indented entry per
 *  Map key. Returns `[]` when the breakdown is empty so the caller can
 *  concat unconditionally. */
const renderKeyedBlock = (
  heading: string,
  map: ReadonlyMap<string, CostBreakdown>,
  detailed: boolean,
): string[] => {
  if (map.size === 0) return []
  const lines: string[] = [heading]
  for (const [k, b] of map) {
    lines.push(`    ${k}: ${usd(b.totalCost)}${tokenSuffix(b, detailed)}`)
  }
  return lines
}

/** Render the per-model block — distinct from the keyed block because model
 *  lines carry the richer `renderModelLine` (token + cache breakdown). */
const renderModelBlock = (map: ReadonlyMap<string, CostBreakdown>, detailed: boolean): string[] => {
  if (map.size === 0) return []
  const lines: string[] = ["  By model:"]
  for (const b of map.values()) {
    lines.push(`    ${renderModelLine(b, detailed)}`)
  }
  return lines
}

/** Render the full snapshot as a multi-line string. `scope` may filter the
 *  output to one of the breakdowns. */
const renderSnapshot = (
  ledger: BudgetLedger,
  scope: "all" | "session" | "day",
  format: "compact" | "detailed",
): string => {
  const snap = ledger.snapshot()
  const detailed = format === "detailed"
  const lines: string[] = [`Budget: ${usd(snap.totalCost)} total, ${snap.events} events`]
  if (scope === "all" || scope === "session") {
    lines.push(...renderKeyedBlock("  By session:", snap.perSession, detailed))
  }
  if (scope === "all" || scope === "day") {
    lines.push(...renderKeyedBlock("  By day:", snap.perDay, detailed))
  }
  if (scope === "all") {
    lines.push(...renderModelBlock(snap.perModel, detailed))
  }
  return lines.join("\n")
}

/** Build a `budget_status` tool over the given ledger. */
export const createBudgetStatusTool = (ledger: BudgetLedger): Tool<Input, unknown> =>
  defineTool<Input, unknown>({
    name: "budget_status",
    description:
      "Inspect cumulative LLM cost: total USD, per-session, per-day, per-model breakdown. " +
      "Read-only. `scope`: 'all' (default) | 'session' | 'day'. `format`: 'compact' (default) | 'detailed'.",
    inputSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input) {
      const scope = input.scope ?? "all"
      const format = input.format ?? "compact"
      const output = renderSnapshot(ledger, scope, format)
      yield { type: "result", result: { ok: true, output } }
    },
  })
