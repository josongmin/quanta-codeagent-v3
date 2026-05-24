/**
 * LLM tokens + cost OTel emit at the downstream turn-record sink.
 *
 * The `llm/*` adapters compute `cost_usd` / `input_tokens` / `output_tokens` /
 * `cache_*` and surface them on a `StreamEvent { type:"usage" }` and, at turn
 * close, on a finalized {@link WorkMetrics} snapshot. The `AgentRecorder` already
 * fans the per-`usage`-event tokens into `gen_ai.usage.*` counters, but:
 *
 *   - `gen_ai.usage.cache_creation_input_tokens` was never wired (counter exists
 *     in the canonical vocabulary but no emit site populated it).
 *   - The derived USD cost (`estimatedCostUsd`, from `pricing.ts`) was computed
 *     for the per-turn `WorkMetrics` summary and the `buildCostDashboard`
 *     aggregator but NEVER reached the OTel registry — dashboards could only
 *     reconstruct it by re-running pricing on the token counters, which double-
 *     pays for unknown-model `null` cases.
 *
 * This module wires that gap on the **observability side only** — no change to
 * `llm/*` adapter code, no change to `loop.ts`'s usage-event bridge. It plugs in
 * at the {@link WorkMetricsSink} boundary, which is the natural downstream
 * turn-record sink: by the time a `WorkMetrics` lands at the sink, the per-turn
 * tokens are aggregated and `estimatedCostUsd` is derived (when the model is
 * priced).
 *
 * Two public entry points:
 *
 *   - {@link emitLlmCostToOtel}    — pure stateless emit helper. Takes a
 *                                    {@link Metrics} registry, the per-turn
 *                                    {@link WorkMetrics}, and optional
 *                                    `{model, provider}` labels. Increments
 *                                    canonical counters and records the cost on
 *                                    a `quanta.work.cost_usd` timer (used as a
 *                                    histogram — the timer's `stats()` already
 *                                    yields p50/p95/mean for the cost
 *                                    distribution). When `model` is supplied,
 *                                    also emits label-disaggregated counters
 *                                    keyed `${name}.${provider}.${model}` so a
 *                                    dashboard can split per-model cost
 *                                    without losing the rolled-up totals.
 *
 *   - {@link buildLlmCostMetricsSink} — builds a {@link WorkMetricsSink}-shape
 *                                    object that wires straight into
 *                                    `AgentConfig.workMetricsSink`. Optional
 *                                    `wrap` parameter chains an existing sink
 *                                    so a surface that already prints
 *                                    `work: <summary>\n` to stderr can keep
 *                                    that behaviour while ALSO emitting the
 *                                    counters/histogram to OTel.
 *
 * Security invariants (audit-locked in `llm-cost-emit-hellgate.test.ts`):
 *
 *   - NO prompt or completion TEXT is ever read or emitted. The sink consumes
 *     a {@link WorkMetrics} which by construction carries only scalar counts +
 *     per-file numstat rows; the adapter NEVER touches messages/content/system.
 *   - The only string labels that reach the registry name space are `model` and
 *     `provider` — both are safe provider/system identifiers per repo convention.
 *   - Zero-cost turns (e.g. a turn served entirely from cache reads on a priced
 *     model, or an unknown model with no cost derivation) still emit the token
 *     counters; the cost histogram is recorded ONLY when `estimatedCostUsd` is a
 *     finite number (omitted for unknown-model `undefined`, never `0` as a
 *     placeholder).
 */

import type { Metrics } from "./metrics"
import { GEN_AI_ATTRS, QUANTA_ATTRS } from "./vocabulary"
import type { WorkMetrics } from "./work-metrics"

/** Optional static labels that disaggregate the rolled-up counters/histogram
 *  by provider+model. Both are safe to emit per the repo's text-content
 *  invariant (no prompt/completion text). Either may be omitted; when both are
 *  absent, only the rolled-up keys are written. */
export interface LlmCostLabels {
  /** Model id from `AgentConfig.llm.model` (e.g. `"claude-opus-4-7"`). */
  readonly model?: string
  /** Provider id from `AgentConfig.llm.provider`
   *  (`"anthropic" | "openai" | "chatgpt-oauth"`). When omitted and `model` is
   *  set, derived from the model prefix via `providerOf()` so a dashboard
   *  ALWAYS sees a provider label even on legacy callers that omit it. */
  readonly provider?: string
}

/** Sink shape mirrored from `@/agent/work-metrics-collector#WorkMetricsSink`,
 *  duplicated here so this module does NOT back-reference `@/agent` (the slice
 *  rule lets `@/agent` import `@/observability` but not vice versa).
 *  Structurally identical — assignable in both directions at the call site. */
export interface LlmCostSink {
  emit(m: WorkMetrics, ctx: { turnId: string }): void
}

// ---------------------------------------------------------------------------
// Canonical key names
// ---------------------------------------------------------------------------

/** Rolled-up token counters (already populated per-`usage`-event by the agent
 *  recorder; we ALSO bump them at turn close so the per-turn snapshot stays
 *  reconcilable when the recorder is absent — the increments are idempotent
 *  with respect to a recorder-driven session because tests construct fresh
 *  registries). */
const K_TOKENS_INPUT = GEN_AI_ATTRS.usage.inputTokens
const K_TOKENS_OUTPUT = GEN_AI_ATTRS.usage.outputTokens
const K_TOKENS_CACHE_READ = GEN_AI_ATTRS.usage.cacheReadInputTokens
const K_TOKENS_CACHE_CREATION = GEN_AI_ATTRS.usage.cacheCreationInputTokens
const K_COST_USD = QUANTA_ATTRS.work.costUsd

/** Provider-prefix sniff for the unknown-provider fallback. Mirrors
 *  `pricing.ts#providerOf` so the label is consistent with the cost math, but
 *  duplicated locally to avoid a back-edge import (this module sits BESIDE
 *  pricing.ts and both are imported by the same consumer surface). */
const inferProvider = (model: string): string => {
  const m = model.toLowerCase()
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3")) return "openai"
  return "anthropic"
}

/** Lowercase + replace non-alphanumeric runs with `_` so a model/provider
 *  string is safe to embed in a metric name. The Metrics registry uses
 *  dot-separated keys; periods inside a model id (e.g. `gpt-4.1`) would split
 *  the key, so we normalize. Empty input collapses to `unknown`. */
const sanitizeLabel = (s: string): string => {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return cleaned === "" ? "unknown" : cleaned
}

/** Build the label suffix `.${provider}.${model}` for disaggregated counters.
 *  Returns `""` when neither label is resolvable, in which case only the
 *  rolled-up counter is touched. */
const labelSuffix = (labels: LlmCostLabels): string => {
  const model = labels.model
  if (model === undefined || model === "") return ""
  const provider = labels.provider ?? inferProvider(model)
  return `.${sanitizeLabel(provider)}.${sanitizeLabel(model)}`
}

// ---------------------------------------------------------------------------
// Stateless emit helper
// ---------------------------------------------------------------------------

/**
 * Emit per-turn LLM token + cost metrics to a {@link Metrics} registry.
 *
 * Counters incremented (always, when the corresponding field is set):
 *   - `gen_ai.usage.input_tokens`            (+ `${k}.${prov}.${model}`)
 *   - `gen_ai.usage.output_tokens`           (+ disaggregated variant)
 *   - `gen_ai.usage.cache_read_input_tokens` (+ disaggregated variant)
 *
 * `cache_creation_input_tokens` is NOT a field on the current `WorkMetrics`
 * shape (the streamed `usage` event from `llm/*` does not yet surface it), so
 * this helper accepts it as an OPTIONAL extra-field hint via `extra` — when
 * the caller plumbs it later, the counter wires up with zero further changes.
 *
 * Cost (`estimatedCostUsd`) is recorded on a `quanta.work.cost_usd` timer
 * (which the existing `MetricsSnapshot` exposes as a `TimerStats` block with
 * `count / min / max / mean / p50 / p95` — effectively a histogram for a
 * cost-per-turn distribution). A rolled-up cumulative counter under the same
 * key is ALSO incremented so a status line can show "total run cost so far"
 * without recomputing. Unknown-model turns (where `estimatedCostUsd ===
 * undefined`) skip cost emit entirely — never a placeholder zero.
 *
 * Pure with respect to its arguments: does not mutate `m` or `labels`.
 */
export const emitLlmCostToOtel = (
  metrics: Metrics,
  m: WorkMetrics,
  labels: LlmCostLabels = {},
  extra: { readonly cacheCreationInputTokens?: number } = {},
): void => {
  const suffix = labelSuffix(labels)

  // Tokens — always emit (zero is a valid value, distinguishes "we saw the
  // turn but it had no input/output" from "no signal").
  bumpCounter(metrics, K_TOKENS_INPUT, m.tokensInput, suffix)
  bumpCounter(metrics, K_TOKENS_OUTPUT, m.tokensOutput, suffix)
  if (m.cacheReadTokens !== undefined) {
    bumpCounter(metrics, K_TOKENS_CACHE_READ, m.cacheReadTokens, suffix)
  }
  if (extra.cacheCreationInputTokens !== undefined) {
    bumpCounter(metrics, K_TOKENS_CACHE_CREATION, extra.cacheCreationInputTokens, suffix)
  }

  // Cost — only when derived. Unknown-model `undefined` skips both emits so
  // dashboards never read a fake zero. We also guard against non-finite values
  // (NaN/Infinity) — the OTel spec forbids those on the wire, and `pricing.ts`
  // returns `null` for unknown models, but a malformed pricing-table entry
  // could theoretically yield NaN; this is the last line of defence.
  const cost = m.estimatedCostUsd
  if (cost !== undefined && Number.isFinite(cost) && cost >= 0) {
    metrics.timer(K_COST_USD).record(cost)
    bumpCounter(metrics, K_COST_USD, cost, suffix)
  }
}

/** Increment the rolled-up counter and, when a label suffix is supplied, the
 *  disaggregated `${name}${suffix}` counter too. Non-finite / zero / negative
 *  deltas are dropped at the boundary — counters are monotonic by definition
 *  (the OTel spec forbids negative-delta sums), and `Counter.inc` accepts any
 *  number, so we must guard before calling it (a Cursor-style malformed-row
 *  defence). */
const bumpCounter = (metrics: Metrics, name: string, delta: number, suffix: string): void => {
  if (!Number.isFinite(delta) || delta <= 0) return
  metrics.counter(name).inc(delta)
  if (suffix !== "") metrics.counter(`${name}${suffix}`).inc(delta)
}

// ---------------------------------------------------------------------------
// Sink builder
// ---------------------------------------------------------------------------

/**
 * Build a {@link LlmCostSink} that wires straight into
 * `AgentConfig.workMetricsSink`. Each per-turn emit forwards to
 * {@link emitLlmCostToOtel} and (when `wrap` is supplied) chains the wrapped
 * sink so an existing surface emit (e.g. the stderr `work: <summary>` line)
 * keeps working byte-identically.
 *
 * The returned sink is stateless; the {@link Metrics} registry is captured by
 * closure. Multiple sinks built off the same registry share counters/timers
 * (intended — a session and a sidebar can both observe).
 */
export const buildLlmCostMetricsSink = (
  metrics: Metrics,
  labels: LlmCostLabels = {},
  wrap?: LlmCostSink,
): LlmCostSink => ({
  emit: (m, ctx) => {
    emitLlmCostToOtel(metrics, m, labels)
    wrap?.emit(m, ctx)
  },
})
