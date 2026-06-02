import type { PrewarmOutcome } from "@/llm"
import { GEN_AI_ATTRS, type Metrics, QUANTA_ATTRS } from "@/observability"
import type { PersistStats, RecallStats } from "./memory-stats"

/**
 * Thin agent-loop metrics helper (RFC §8 Phase 3). The Metrics registry already
 * exists in @/observability; this just names the loop's counters/timers in one
 * place and no-ops when no registry is configured. Behavior-preserving: the
 * loop only touches an {@link AgentRecorder} when `config.metrics` is present.
 */

/** Stable metric names — kept in one place so the snapshot is predictable.
 *
 * Token-usage counters reuse the canonical OTel GenAI vocabulary
 * (`gen_ai.usage.input_tokens` etc., declared in
 * `src/observability/vocabulary.ts`) so a CLI status line — or any future
 * surface (Tauri sidebar / Web REPL) — reads ONE well-known key, not a private
 * loop-local namespace. Claude Desktop 1.7196.3 `getContextUsage` parity. */
export const METRIC = {
  turns: "agent.turns",
  toolCalls: "agent.tool_calls",
  llmStream: "agent.llm_stream",
  toolExec: "agent.tool_exec",
  stopReason: "agent.stop_reason",
  recallCalls: "memory.recall.calls",
  recallEntries: "memory.recall.entries",
  recallSemantic: "memory.recall.semantic",
  recallFallback: "memory.recall.fallback",
  persistCalls: "memory.persist.calls",
  distilled: "memory.distilled",
  consolidateInserted: "memory.consolidate.inserted",
  consolidateMerged: "memory.consolidate.merged",
  consolidateSuperseded: "memory.consolidate.superseded",
  consolidateSkipped: "memory.consolidate.skipped",
  evictDecayed: "memory.evict.decayed",
  evictDeleted: "memory.evict.deleted",
  tokensInput: GEN_AI_ATTRS.usage.inputTokens,
  tokensOutput: GEN_AI_ATTRS.usage.outputTokens,
  cacheRead: GEN_AI_ATTRS.usage.cacheReadInputTokens,
  // ADR-0452 — session-startup prewarm + TTFM. Canonical `quanta.startup.*`
  // keys (vocabulary.ts) so any surface reads the same well-known names.
  ttfm: QUANTA_ATTRS.startup.timeToFirstMessageMs,
  prewarmDuration: QUANTA_ATTRS.startup.prewarmDurationMs,
  prewarmOutcome: QUANTA_ATTRS.startup.prewarmOutcome,
} as const

/** Loop-facing recorder. Wraps a {@link Metrics} instance; every method is a
 *  cheap counter/timer touch. Construct only when metrics are configured. */
export class AgentRecorder {
  constructor(private readonly metrics: Metrics) {}

  turn(): void {
    this.metrics.counter(METRIC.turns).inc()
  }

  toolCall(name: string): void {
    this.metrics.counter(METRIC.toolCalls).inc()
    this.metrics.counter(`${METRIC.toolCalls}.${name}`).inc()
  }

  stopReason(reason: string): void {
    this.metrics.counter(`${METRIC.stopReason}.${reason}`).inc()
  }

  /** Start an LLM-stream span; returns a stop fn recording elapsed ms. */
  llmStream(): () => number {
    return this.metrics.timer(METRIC.llmStream).start()
  }

  /** Start a tool-exec span; returns a stop fn recording elapsed ms. */
  toolExec(): () => number {
    return this.metrics.timer(METRIC.toolExec).start()
  }

  /** Record one recallContext outcome (RFC §8 memory observability). */
  memoryRecall(s: RecallStats): void {
    this.metrics.counter(METRIC.recallCalls).inc()
    this.metrics.counter(METRIC.recallEntries).inc(s.recalled)
    if (s.embedded) this.metrics.counter(METRIC.recallSemantic).inc()
    if (s.fellBack) this.metrics.counter(METRIC.recallFallback).inc()
  }

  /**
   * Record one token-usage report from a model stream (Claude Desktop
   * `getContextUsage` parity). `input` / `output` are the raw GenAI semconv
   * counters; `cacheRead` is registered lazily so the absent case stays a
   * true no-op (no counter created on the registry — matches the optional
   * shape of `StreamEvent { type:"usage" }`). All three keys are the canonical
   * OTel GenAI semconv strings, so a CLI status line / Tauri sidebar reads
   * the same names regardless of provider.
   */
  tokensUsed(input: number, output: number, cacheRead?: number): void {
    this.metrics.counter(METRIC.tokensInput).inc(input)
    this.metrics.counter(METRIC.tokensOutput).inc(output)
    if (cacheRead !== undefined) {
      this.metrics.counter(METRIC.cacheRead).inc(cacheRead)
    }
  }

  /** Record one persistSession outcome (RFC §8 memory observability). */
  memoryPersist(s: PersistStats): void {
    this.metrics.counter(METRIC.persistCalls).inc()
    this.metrics.counter(METRIC.distilled).inc(s.distilled)
    this.metrics.counter(METRIC.consolidateInserted).inc(s.inserted)
    this.metrics.counter(METRIC.consolidateMerged).inc(s.merged)
    this.metrics.counter(METRIC.consolidateSuperseded).inc(s.superseded)
    this.metrics.counter(METRIC.consolidateSkipped).inc(s.skipped)
    this.metrics.counter(METRIC.evictDecayed).inc(s.decayed)
    this.metrics.counter(METRIC.evictDeleted).inc(s.deleted)
  }

  /**
   * ADR-0452 — record the session-startup prewarm outcome (once per session).
   * `durationMs` is the wall-clock cost of the prewarm step itself (0 when the
   * port had no prewarm capability). `outcome` is the {@link PrewarmOutcome}.
   * Uses a gauge for the duration (point-in-time, one value per session) and a
   * per-outcome counter so dashboards can split warmed / skipped / failed.
   */
  prewarm(outcome: PrewarmOutcome, durationMs: number): void {
    this.metrics.gauge(METRIC.prewarmDuration).set(durationMs)
    this.metrics.counter(`${METRIC.prewarmOutcome}.${outcome}`).inc()
  }

  /**
   * ADR-0452 — record Time-To-First-Message (once per session): wall-clock ms
   * from session start to the first turn's LLM-stream dispatch. Gauge, since it
   * is a single per-session point-in-time value (Codex `age_at_first_turn_ms`
   * parity). The loop computes `ms` from the SAME injected clock used elsewhere
   * so the value is deterministic under a fake clock.
   */
  timeToFirstMessage(ms: number): void {
    this.metrics.gauge(METRIC.ttfm).set(ms)
  }
}
