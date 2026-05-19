/**
 * Probe — plain-text renderers (RFC-0002 §7; Phase 1 = plain, no TUI §14).
 *
 * Pure functions: events in, strings out. No color, no I/O. The trajectory is
 * the only source — hotspots/cost are derived from the events themselves and
 * do NOT require `metrics.json` (RFC §3 원칙1).
 */
import { costUsd, PRICING_VERSION } from "@/observability"
import type { TrajectoryEvent } from "@/shared"
import type { AttemptTraj, RunSummaryLike } from "./parse"

const str = (e: TrajectoryEvent, key: string): string => {
  const v = e.data[key]
  return typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v)
}

const num = (e: TrajectoryEvent, key: string): number | undefined => {
  const v = e.data[key]
  return typeof v === "number" ? v : undefined
}

const truncate = (s: string, n = 100): string =>
  s.length <= n ? s : `${s.slice(0, n).replace(/\s+/g, " ")}…`

// ── timeline ────────────────────────────────────────────────────────────

/** Group every event by its turn span (`parentSpanId` or `spanId`). */
const turnKey = (e: TrajectoryEvent): string => {
  if (e.kind === "turn_start") return e.spanId ?? `t#${e.seq}`
  if (e.parentSpanId?.startsWith("t") && !e.parentSpanId.startsWith("tool:")) return e.parentSpanId
  return e.parentSpanId ?? e.spanId ?? "t#?"
}

const renderToolSpan = (events: TrajectoryEvent[]): string[] => {
  const call = events.find((e) => e.kind === "tool_call")
  const result = events.find((e) => e.kind === "tool_result")
  const name = str(call ?? events[0] ?? ({} as TrajectoryEvent), "name") || "tool"
  const lines = [`  • tool ${name}`]
  for (const p of events.filter((e) => e.kind === "tool_progress")) {
    lines.push(`      ↳ ${truncate(str(p, "message"), 80)}`)
  }
  if (result !== undefined) {
    const ok = result.data.ok === false ? "ERR" : "ok"
    const exit = num(result, "exitCode")
    const ms = num(result, "durationMs")
    const bits = [
      ok,
      exit !== undefined ? `exit=${exit}` : "",
      ms !== undefined ? `${ms}ms` : "",
    ].filter((b) => b !== "")
    lines.push(`      → ${bits.join(" ")}  ${truncate(str(result, "stdoutTail"), 80)}`.trimEnd())
  }
  return lines
}

const renderUsage = (e: TrajectoryEvent): string => {
  const model = str(e, "model") || "?"
  const i = num(e, "inputTokens") ?? 0
  const o = num(e, "outputTokens") ?? 0
  return `  ⊙ llm_usage ${model}: ${i} in / ${o} out tokens`
}

const renderTurn = (key: string, events: TrajectoryEvent[]): string[] => {
  const ts = events.find((e) => e.kind === "turn_start")
  const label = ts !== undefined ? `turn ${num(ts, "turn") ?? "?"}` : key
  const lines = [`── ${label} ──`]
  const text = events
    .filter((e) => e.kind === "assistant_text")
    .map((e) => str(e, "delta"))
    .join("")
  if (text.trim() !== "") lines.push(`  “${truncate(text, 120)}”`)
  const byTool = new Map<string, TrajectoryEvent[]>()
  for (const e of events) {
    if (e.kind === "tool_call" || e.kind === "tool_progress" || e.kind === "tool_result") {
      const k = e.spanId ?? "tool:?"
      byTool.set(k, [...(byTool.get(k) ?? []), e])
    }
  }
  for (const span of byTool.values()) lines.push(...renderToolSpan(span))
  for (const u of events.filter((e) => e.kind === "llm_usage")) lines.push(renderUsage(u))
  return lines
}

/** Per-turn assistant summary + indented span tree (RFC §7 timeline). */
export const renderTimeline = (events: TrajectoryEvent[]): string => {
  if (events.length === 0) return "(no events)"
  const turns = new Map<string, TrajectoryEvent[]>()
  const order: string[] = []
  for (const e of events) {
    const k = turnKey(e)
    if (!turns.has(k)) {
      turns.set(k, [])
      order.push(k)
    }
    turns.get(k)?.push(e)
  }
  const out: string[] = []
  for (const k of order) out.push(...renderTurn(k, turns.get(k) ?? []))
  const end = events.find((e) => e.kind === "session_end")
  if (end !== undefined) out.push(`── end: reason=${str(end, "reason") || "?"} ──`)
  return out.join("\n")
}

// ── hotspots ────────────────────────────────────────────────────────────

interface Span {
  label: string
  durationMs: number
}

const spansOf = (events: TrajectoryEvent[]): Span[] => {
  const spans: Span[] = []
  for (const e of events) {
    if (e.kind === "tool_result") {
      const ms = num(e, "durationMs")
      if (ms !== undefined) spans.push({ label: `tool ${str(e, "name") || "?"}`, durationMs: ms })
    }
  }
  return spans
}

/** Slowest spans (tool_result durationMs) Top-N — derived from events only. */
export const renderHotspots = (events: TrajectoryEvent[], topN = 10): string => {
  const spans = spansOf(events).sort((a, b) => b.durationMs - a.durationMs)
  if (spans.length === 0) return "hotspots: (no timed spans)"
  const lines = ["hotspots (slowest spans):"]
  for (const s of spans.slice(0, topN)) lines.push(`  ${s.durationMs}ms  ${s.label}`)
  return lines.join("\n")
}

// ── cost ────────────────────────────────────────────────────────────────

interface CostRow {
  instanceId: string
  inputTokens: number
  outputTokens: number
  model: string
  usd: number | null
}

const costRow = (instanceId: string, attempts: AttemptTraj[]): CostRow => {
  let inputTokens = 0
  let outputTokens = 0
  let model = ""
  for (const a of attempts) {
    for (const e of a.parsed.events) {
      if (e.kind !== "llm_usage") continue
      inputTokens += num(e, "inputTokens") ?? 0
      outputTokens += num(e, "outputTokens") ?? 0
      model = str(e, "model") || model
    }
  }
  return {
    instanceId,
    inputTokens,
    outputTokens,
    model: model || "?",
    usd: model === "" ? null : costUsd(model, inputTokens, outputTokens),
  }
}

const passedOf = (summary: RunSummaryLike | undefined, id: string): string => {
  const hit = summary?.instances?.find((i) => i.id === id)
  if (hit === undefined) return ""
  return hit.passed === true ? " [passed]" : " [not resolved]"
}

/** Per-instance token/USD table; stamps the pricingVersion used (RFC §7). */
export const renderCost = (
  instances: Map<string, AttemptTraj[]>,
  summary?: RunSummaryLike,
): string => {
  const lines = [`cost (pricingVersion=${PRICING_VERSION}):`]
  for (const [id, attempts] of [...instances.entries()].sort()) {
    const r = costRow(id, attempts)
    const usd = r.usd === null ? "n/a" : `$${r.usd.toFixed(4)}`
    lines.push(
      `  ${id}: ${r.inputTokens} in / ${r.outputTokens} out  (${r.model}) ${usd}${passedOf(summary, id)}`,
    )
  }
  if (instances.size === 0) lines.push("  (no instances)")
  return lines.join("\n")
}

/** Machine view of cost — explicitly carries NO certainty/verdict field. */
export const costJson = (
  instances: Map<string, AttemptTraj[]>,
): { pricingVersion: string; instances: CostRow[] } => ({
  pricingVersion: PRICING_VERSION,
  instances: [...instances.entries()].sort().map(([id, a]) => costRow(id, a)),
})
