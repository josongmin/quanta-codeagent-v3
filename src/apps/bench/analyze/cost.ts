/**
 * Cost / token / wall-clock summary for a bench run (ADR-0536 P1, pure).
 *
 * Token + wall-clock data come from two sources, in priority order:
 *   1. the run `report.json` — `perInstance[].usage` (token counts) + `durationMs`
 *      (present only when observability was on);
 *   2. fallback `observe/` trajectory JSONL — `quanta.trajectory.v1` events carry
 *      `inputTokens`/`outputTokens` (summed) + `ts` (wall-clock = last − first).
 *
 * When NEITHER source has token data the summary is honest about it (zeros +
 * `instancesWithUsage:0`) and {@link renderCost} prints an explicit caveat
 * rather than a misleading `$0.00`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { costUsd } from "@/observability"

/**
 * Per-call price override (USD / 1M tokens). This is NOT a maintained price
 * TABLE — the single source of truth for model prices is
 * `src/observability/pricing.ts` (`costUsd`, provider-aware cache math, versioned
 * via `PRICING_VERSION`). Callers pass `pricing` only to override or to price a
 * model the SSOT does not know (e.g. tests, `--pricing`). When no override is
 * given for the report's model, cost is derived from the SSOT.
 */
export interface ModelPricing {
  /** USD per 1M input tokens. */
  readonly inputPerMTok: number
  /** USD per 1M output tokens. */
  readonly outputPerMTok: number
}

export interface InstanceCost {
  readonly id: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly wallClockMs: number
  readonly costUsd: number
}

export interface CostSummary {
  readonly model: string
  readonly perInstance: readonly InstanceCost[]
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  readonly totalCostUsd: number
  readonly totalWallClockMs: number
  /** How many instances had REAL token data (in+out > 0). */
  readonly instancesWithUsage: number
  /** Whether the model has a known price. When false, costUsd is 0 not because
   *  the run was free but because we have no pricing — renderCost says so
   *  instead of presenting a fake `$0.00`. */
  readonly pricingKnown: boolean
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/** Pull a usage `{input,output,cacheRead}` token triple from a `perInstance[].usage`
 *  object, tolerating the common key spellings. `cacheRead` feeds the
 *  provider-aware cache math in the SSOT (`costUsd`). */
const usageTokens = (usage: unknown): { input: number; output: number; cacheRead: number } => {
  if (typeof usage !== "object" || usage === null) return { input: 0, output: 0, cacheRead: 0 }
  const u = usage as Record<string, unknown>
  const input = num(u.inputTokens) || num(u.input_tokens) || num(u.input) || num(u.promptTokens)
  const output =
    num(u.outputTokens) || num(u.output_tokens) || num(u.output) || num(u.completionTokens)
  const cacheRead =
    num(u.cacheReadTokens) ||
    num(u.cache_read_tokens) ||
    num(u.cachedTokens) ||
    num(u.cached_tokens)
  return { input, output, cacheRead }
}

/** Recursively sum every `inputTokens`/`outputTokens` numeric leaf in a value —
 *  the trajectory events nest token counts under `data`. */
const deepSumTokens = (v: unknown, acc: { input: number; output: number }): void => {
  if (Array.isArray(v)) {
    for (const item of v) deepSumTokens(item, acc)
    return
  }
  if (typeof v !== "object" || v === null) return
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === "inputTokens") acc.input += num(val)
    else if (k === "outputTokens") acc.output += num(val)
    else deepSumTokens(val, acc)
  }
}

/** Backfill tokens + wall-clock for one instance from its observe JSONL.
 *  Best-of-N runs emit one file PER attempt (`<instanceId>.0.jsonl`,
 *  `<instanceId>.1.jsonl`, …); sum tokens across ALL of them and span the
 *  wall-clock over every attempt, else an n-attempt run reports ~1/n of the
 *  real cost. Returns zeros if absent. */
const fromObserve = (
  observeDir: string,
  instanceId: string,
): { input: number; output: number; wallClockMs: number } => {
  if (!existsSync(observeDir)) return { input: 0, output: 0, wallClockMs: 0 }
  let files: string[]
  try {
    files = readdirSync(observeDir).filter(
      (f) => f.startsWith(`${instanceId}.`) && f.endsWith(".jsonl"),
    )
  } catch {
    return { input: 0, output: 0, wallClockMs: 0 }
  }
  if (files.length === 0) return { input: 0, output: 0, wallClockMs: 0 }
  const acc = { input: 0, output: 0 }
  let minTs = Number.POSITIVE_INFINITY
  let maxTs = Number.NEGATIVE_INFINITY
  for (const file of files) {
    try {
      for (const line of readFileSync(join(observeDir, file), "utf8").split("\n")) {
        if (line.trim() === "") continue
        let ev: unknown
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        deepSumTokens(ev, acc)
        const ts = num((ev as { ts?: unknown }).ts)
        if (ts > 0) {
          minTs = Math.min(minTs, ts)
          maxTs = Math.max(maxTs, ts)
        }
      }
    } catch {
      // skip an unreadable attempt file rather than dropping the whole instance
    }
  }
  const wallClockMs =
    Number.isFinite(minTs) && Number.isFinite(maxTs) ? Math.max(0, maxTs - minTs) : 0
  return { input: acc.input, output: acc.output, wallClockMs }
}

/** USD cost for one instance. Price source, in priority order:
 *   1. caller `pricing` override for the model (tests / `--pricing`) — simple
 *      input·rate + output·rate (the override type carries no cache rate);
 *   2. the observability pricing SSOT `costUsd` — provider-aware cache math
 *      (OpenAI cached-input carve-out / Anthropic discounted add). Unknown ⇒ 0
 *      (the caller marks `pricingKnown=false` so renderCost shows "—", not $0). */
const priceInstance = (
  model: string,
  override: ModelPricing | undefined,
  input: number,
  output: number,
  cacheRead: number,
): number => {
  if (override !== undefined) {
    return (input / 1e6) * override.inputPerMTok + (output / 1e6) * override.outputPerMTok
  }
  return costUsd(model, input, output, cacheRead) ?? 0
}

export const costSummaryFromReport = (args: {
  reportPath: string
  observeDir?: string
  pricing?: Record<string, ModelPricing>
}): CostSummary => {
  const report = JSON.parse(readFileSync(args.reportPath, "utf8")) as {
    model?: string
    perInstance?: Array<{ id?: string; usage?: unknown; durationMs?: unknown }>
  }
  const model = report.model ?? "unknown"
  const override = args.pricing?.[model]
  const pricingKnown = override !== undefined || costUsd(model, 0, 0) !== null
  const perInstance: InstanceCost[] = []
  for (const pi of report.perInstance ?? []) {
    const id = typeof pi.id === "string" ? pi.id : "?"
    let { input, output, cacheRead } = usageTokens(pi.usage)
    let wallClockMs = num(pi.durationMs)
    if (input === 0 && output === 0 && args.observeDir !== undefined) {
      const o = fromObserve(args.observeDir, id)
      input = o.input
      output = o.output
      // observe trajectories do not carry a cache-read breakdown → 0 (no discount
      // applied, never a double-count).
      cacheRead = 0
      if (wallClockMs === 0) wallClockMs = o.wallClockMs
    }
    perInstance.push({
      id,
      inputTokens: input,
      outputTokens: output,
      wallClockMs,
      costUsd: priceInstance(model, override, input, output, cacheRead),
    })
  }
  return {
    model,
    perInstance,
    totalInputTokens: perInstance.reduce((s, p) => s + p.inputTokens, 0),
    totalOutputTokens: perInstance.reduce((s, p) => s + p.outputTokens, 0),
    totalCostUsd: perInstance.reduce((s, p) => s + p.costUsd, 0),
    totalWallClockMs: perInstance.reduce((s, p) => s + p.wallClockMs, 0),
    instancesWithUsage: perInstance.filter((p) => p.inputTokens + p.outputTokens > 0).length,
    pricingKnown,
  }
}

/** Minimal structural view of an instance's rolled-up usage — kept dependency-
 *  free so cost.ts imports no runner/batch types. `InstanceResult` satisfies it. */
export interface RunUsageInput {
  readonly usage?: {
    readonly model: string
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens?: number
  }
}

/** One-line token + estimated-cost summary for a finished bench run, derived
 *  straight from the in-memory results (the SAME `InstanceUsage` that lands in
 *  `report.json`). Cost reuses the observability pricing SSOT per-instance, so a
 *  mixed-model run (model lanes) is priced correctly. Returns `undefined` when NO
 *  instance reported usage (observe off / usage-free corpus) so the run summary
 *  stays byte-identical in that case. Honest on price: when tokens exist but NO
 *  instance's model is priced, cost renders `—`, never a fake `$0`. */
export const runTokenCostLine = (results: readonly RunUsageInput[]): string | undefined => {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let costUsdTotal = 0
  let anyPriced = false
  let withUsage = 0
  for (const r of results) {
    const u = r.usage
    if (u === undefined) continue
    withUsage += 1
    inputTokens += u.inputTokens
    outputTokens += u.outputTokens
    cacheReadTokens += u.cacheReadTokens ?? 0
    const c = costUsd(u.model, u.inputTokens, u.outputTokens, u.cacheReadTokens ?? 0)
    if (c !== null) {
      costUsdTotal += c
      anyPriced = true
    }
  }
  if (withUsage === 0) return undefined
  const cache = cacheReadTokens > 0 ? ` (${cacheReadTokens} cache-read)` : ""
  const cost = anyPriced ? `$${costUsdTotal.toFixed(4)}` : "— (no pricing for model)"
  return `tokens ${inputTokens} in + ${outputTokens} out${cache} | est. cost ${cost} | ${withUsage}/${results.length} instances`
}

export const renderCost = (s: CostSummary): string => {
  const lines: string[] = [`=== Cost summary (model: ${s.model}) ===`, ""]
  if (s.instancesWithUsage === 0) {
    // Honest: do NOT present $0.00 as a real measurement.
    lines.push(
      "NO token usage recorded in the report or observe trajectories.",
      "Enable observability (QUANTA_OBSERVABILITY=1) on the run to capture tokens/cost.",
    )
    return lines.join("\n")
  }
  // When the model has no price, show `—` for $ instead of a misleading $0.0000.
  const money = (v: number): string => (s.pricingKnown ? v.toFixed(4) : "—")
  lines.push("| instance | input | output | wall(s) | $ |", "| --- | ---: | ---: | ---: | ---: |")
  for (const p of s.perInstance) {
    lines.push(
      `| ${p.id} | ${p.inputTokens} | ${p.outputTokens} | ${(p.wallClockMs / 1000).toFixed(1)} | ${money(p.costUsd)} |`,
    )
  }
  lines.push(
    "",
    `total: ${s.totalInputTokens} in + ${s.totalOutputTokens} out tokens | ` +
      `$${money(s.totalCostUsd)} | ${(s.totalWallClockMs / 1000).toFixed(1)}s wall | ` +
      `(${s.instancesWithUsage}/${s.perInstance.length} instances had token data)`,
  )
  if (!s.pricingKnown) {
    lines.push(
      "",
      `⚠️ NO pricing for model "${s.model}" — $ shown as "—" (NOT $0). ` +
        "Pass --pricing or add the model to src/observability/pricing.ts for real cost.",
    )
  }
  return lines.join("\n")
}
