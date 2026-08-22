/**
 * `prompt_cache_status` tool (ADR-0182) — read-only surface over the
 * `PromptCacheObserver` (ADR-0182 / ADR-0179 lineage) so the agent can
 * answer "is prompt caching actually working?" without the operator having to
 * tail metrics.
 *
 * Caller-wired: this tool is NOT part of `buildDefaultTools` (mirrors the
 * `gitTools(runner)` / `lspNavTools(provider)` / `shadowTools(...)` posture).
 * The composition root constructs it with a `PromptCacheObserver` instance
 * — usually the same observer wired into the dispatch seam that forwards
 * each completion's `usage` block — and registers the returned `Tool<>`.
 * Without an observer wired the tool is simply absent from the registry;
 * sessions that never call it are byte-identical (Default-OFF).
 *
 * Slice posture (RFC §3.1):
 *   - Imports `@/observability/prompt-cache` (the sibling primitive),
 *     `zod`, and the local `./types`. NO `@/agent`, `@/permission`,
 *     `@/memory`, `@/llm` (the observer types are the only cross-slice
 *     surface; the dispatch seam owns the agent-side composition).
 *   - The `@/observability` slice-fence path-key in biome.json blocks the
 *     BARE `@/observability` specifier; subpath imports like
 *     `@/observability/prompt-cache` are allowed (same posture
 *     `coverage_check` uses for `@/observability/coverage`). The shadowing
 *     `src/observability/metrics.ts` legacy file is bypassed by reaching
 *     into the `prompt-cache/` directory directly.
 *   - No-throw: every failure mode yields a typed `ok:false` `ToolResult`.
 *
 * Read-only + concurrency-safe: the observer's `snapshot()` is a pure
 * in-memory roll-up with no side effect; multiple snapshot calls in flight
 * are safe.
 *
 * Why no shell / no FS:
 *   - The observer holds the state; the operator already chose where to
 *     send metrics (the wired `MetricSink`). This tool's job is to render
 *     the snapshot in plain text for the model. Persisting the snapshot to
 *     disk is a SEPARATE concern (the metric sink ADR-0154 OTel exporter or
 *     ADR-0180 health-snapshot file handle persistence) — not this tool's.
 */

import { z } from "zod"
import type { CachePerformanceSnapshot, PromptCacheObserver } from "@/observability/prompt-cache"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "./types"
/** Input schema. All fields are OPTIONAL — the most common invocation is
 *  `prompt_cache_status()` (no args) to get the lifetime + per-session
 *  rollup. `sessionId` narrows to one session's drill-down (still includes
 *  the lifetime header so the model has the baseline). `topN` caps the
 *  per-session list when there are many sessions (default 10). */
export const promptCacheStatusInputSchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe("Narrow output to one session id; omit for lifetime + all sessions."),
  topN: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Cap the per-session list at this many sessions, sorted by savings descending. Default 10.",
    ),
})
export type PromptCacheStatusInput = z.infer<typeof promptCacheStatusInputSchema>

/** Format a fraction as a percent with one decimal place (`"76.4%"`). */
const fmtPct = (r: number): string => `${(r * 100).toFixed(1)}%`

/** Format USD as `$X.XX` — two decimals, no thousands separator (keep the
 *  model-facing text deterministic for snapshot tests). */
const fmtUsd = (v: number): string => `$${v.toFixed(2)}`

/** Format a token count compactly: 1_234_567 → "1.23M", 12_345 → "12.3K".
 *  No locale separators (deterministic). */
const fmtTokens = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.floor(n))
}

/** Compute the hypothetical no-cache cost from a snapshot. Conservative:
 *  if EVERY cache_read had been billed at input rate (the user's mental
 *  model of "what would I pay without caching?"), the cost would be:
 *    no_cache_input_tokens × input_rate
 *  But the per-model `inputPerM` is INSIDE the observer (not on the
 *  snapshot). Without re-reaching into pricing here, we use the savings
 *  identity:
 *    hypothetical_no_cache_cost = actual_cost + savings_usd
 *  …where `actual_cost` is the operator's RAW spend on cache reads. Since
 *  the observer only carries `savingsUsd` (vs. paying input rate), the
 *  cleanest pair the model can reason about is `savings_usd` + the percent
 *  saved. We therefore present:
 *    - tokens served
 *    - hit rate
 *    - $ savings vs hypothetical no-cache spend (the OBSERVER computes this)
 *  We DO NOT fabricate an "actual cost" number from raw token counts here
 *  because we'd need the per-model price table — that lives in the
 *  observer's closure, not on the snapshot. Operators wanting raw $ should
 *  pair this tool with the budget-ledger (`/cost` panel) per ADR-0138. */
const _SAVINGS_FORMULA_DOC = true
void _SAVINGS_FORMULA_DOC

const isFinitePositive = (n: number): boolean => Number.isFinite(n) && n > 0

/** Render a top-level snapshot (lifetime). */
const renderLifetimeHeader = (snap: CachePerformanceSnapshot): string[] => {
  const totalServed =
    snap.totalInputTokens + snap.totalCacheCreationTokens + snap.totalCacheReadTokens
  const lines: string[] = []
  lines.push("Prompt cache report:")
  lines.push(`  Hit rate:        ${fmtPct(snap.cacheHitRate)}`)
  lines.push(`  Total input:     ${fmtTokens(totalServed)} tokens`)
  lines.push(`    - regular:     ${fmtTokens(snap.totalInputTokens)}`)
  lines.push(`    - cache write: ${fmtTokens(snap.totalCacheCreationTokens)}`)
  lines.push(`    - cache read:  ${fmtTokens(snap.totalCacheReadTokens)}`)
  lines.push(`  Savings:         ${fmtUsd(snap.costSavingsUsd)} vs no-cache hypothetical`)
  return lines
}

/** Render per-session list, sorted by savings descending (operator wants
 *  the highest-impact sessions first). `topN` caps. */
const renderPerSessionList = (snap: CachePerformanceSnapshot, topN: number): string[] => {
  const lines: string[] = []
  if (snap.perSession.size === 0) return lines
  const ranked: { id: string; child: CachePerformanceSnapshot }[] = []
  for (const [id, child] of snap.perSession.entries()) ranked.push({ id, child })
  ranked.sort((a, b) => b.child.costSavingsUsd - a.child.costSavingsUsd)
  lines.push("")
  lines.push("By session (top by savings):")
  const shown = ranked.slice(0, topN)
  for (const { id, child } of shown) {
    lines.push(`  ${id}: hit=${fmtPct(child.cacheHitRate)} saved=${fmtUsd(child.costSavingsUsd)}`)
  }
  if (ranked.length > shown.length) {
    lines.push(`  … (${ranked.length - shown.length} more sessions omitted)`)
  }
  return lines
}

/** Render per-breakpoint attribution when present. */
const renderBreakpoints = (snap: CachePerformanceSnapshot): string[] => {
  const lines: string[] = []
  if (snap.breakpoints === undefined || snap.breakpoints.size === 0) return lines
  lines.push("")
  lines.push("By breakpoint:")
  const ranked: { name: string; hit: number; miss: number; span: number }[] = []
  for (const [name, b] of snap.breakpoints.entries()) {
    ranked.push({ name, hit: b.hitCount, miss: b.missCount, span: b.tokenSpan })
  }
  ranked.sort((a, b) => b.hit + b.miss - (a.hit + a.miss))
  for (const r of ranked) {
    const total = r.hit + r.miss
    const rate = total > 0 ? r.hit / total : 0
    lines.push(
      `  ${r.name}: hit=${r.hit} miss=${r.miss} (${fmtPct(rate)}) span=${fmtTokens(r.span)}`,
    )
  }
  return lines
}

/** Render a single-session drill-down. */
const renderSingleSession = (id: string, child: CachePerformanceSnapshot): string[] => {
  const totalServed =
    child.totalInputTokens + child.totalCacheCreationTokens + child.totalCacheReadTokens
  const lines: string[] = []
  lines.push("")
  lines.push(`Session ${id}:`)
  lines.push(`  Hit rate:        ${fmtPct(child.cacheHitRate)}`)
  lines.push(`  Total input:     ${fmtTokens(totalServed)} tokens`)
  lines.push(`  Savings:         ${fmtUsd(child.costSavingsUsd)}`)
  if (child.perModel.size > 0) {
    lines.push("  By model:")
    const rows: {
      model: string
      row: typeof child.perModel extends ReadonlyMap<string, infer V> ? V : never
    }[] = []
    for (const [model, row] of child.perModel.entries()) rows.push({ model, row })
    rows.sort((a, b) => b.row.savingsUsd - a.row.savingsUsd)
    for (const { model, row } of rows) {
      lines.push(
        `    ${model}: hit=${fmtPct(row.hitRate)} saved=${fmtUsd(row.savingsUsd)} read=${fmtTokens(row.cacheReadTokens)}`,
      )
    }
  }
  return lines
}

/** Build the full text payload from a snapshot. */
const renderSnapshot = (
  snap: CachePerformanceSnapshot,
  opts: { sessionFilter?: string; topN: number },
): string => {
  const blocks: string[][] = []
  blocks.push(renderLifetimeHeader(snap))
  if (opts.sessionFilter !== undefined) {
    const child = snap.perSession.get(opts.sessionFilter)
    if (child === undefined) {
      blocks.push(["", `(no events recorded for session "${opts.sessionFilter}")`])
    } else {
      blocks.push(renderSingleSession(opts.sessionFilter, child))
    }
  } else {
    blocks.push(renderPerSessionList(snap, opts.topN))
  }
  blocks.push(renderBreakpoints(snap))
  // Footnote on the "savings" semantic (the math is non-obvious — the
  // observer computes USD saved vs. paying input rate for cache-read
  // tokens; an operator pairing this with `/cost` (ADR-0138 budget-ledger)
  // sees the dual axis).
  if (
    isFinitePositive(snap.totalCacheReadTokens) ||
    isFinitePositive(snap.totalCacheCreationTokens)
  ) {
    blocks.push([
      "",
      "Savings = cache_read × (input_rate − cache_read_rate). Hit rate = cache_read / (input + cache_create).",
    ])
  }
  return blocks
    .flat()
    .filter((s, i, a) => !(s === "" && a[i - 1] === ""))
    .join("\n")
}

/** Factory: build the tool bound to a concrete observer. */
export const promptCacheStatusTool = (
  observer: PromptCacheObserver,
): Tool<PromptCacheStatusInput> => ({
  name: "prompt_cache_status",
  description:
    "Report Anthropic prompt-cache effectiveness: hit rate (cache_read / (input + " +
    "cache_create)), total tokens served, and USD saved versus paying input rate " +
    "for cache reads. Optional sessionId narrows to one session; topN (default 10) " +
    "caps the per-session list. Pure in-memory snapshot — no I/O.",
  inputSchema: promptCacheStatusInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: PromptCacheStatusInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    if (ctx.signal.aborted) {
      const result: ToolResult = {
        ok: false,
        output: "prompt_cache_status: aborted before start",
        failure: { mode: "rejected", reason: "aborted" },
      }
      yield { type: "result", result }
      return
    }
    let snap: CachePerformanceSnapshot
    try {
      snap = observer.snapshot()
    } catch (e) {
      const msg = errMessage(e)
      const result: ToolResult = {
        ok: false,
        output: `prompt_cache_status: snapshot failed: ${msg}`,
        failure: { mode: "error", modelVisibleError: msg },
      }
      yield { type: "result", result }
      return
    }
    const topN = input.topN ?? 10
    const sessionFilter = input.sessionId
    const opts = sessionFilter !== undefined ? { sessionFilter, topN } : { topN }
    const output = renderSnapshot(snap, opts)
    yield { type: "result", result: { ok: true, output } }
  },
})

/** Stand-alone error-render helper for the "tracker absent" surface a caller
 *  can use BEFORE wiring a real observer (e.g. when the composition root
 *  detected no observer and wants to register a placeholder that surfaces
 *  a typed `ok:false`). Tools registered with the real factory above never
 *  hit this branch — it exists so a defensive caller can stay symmetric. */
export const promptCacheStatusUnwiredTool = (): Tool<PromptCacheStatusInput> => ({
  name: "prompt_cache_status",
  description:
    "Report Anthropic prompt-cache effectiveness. Currently UNWIRED in this " +
    "session — no observer is attached; calling this tool returns ok:false.",
  inputSchema: promptCacheStatusInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(_input: PromptCacheStatusInput, _ctx: ToolContext): AsyncIterable<ToolEvent> {
    const result: ToolResult = {
      ok: false,
      output:
        "prompt_cache_status is unavailable: no prompt-cache observer is wired in this session.",
      failure: { mode: "rejected", reason: "observer_not_attached" },
    }
    yield { type: "result", result }
  },
})
