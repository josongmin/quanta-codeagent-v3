import type { Metrics } from "@/observability"
import type { PersistStats, RecallStats } from "./memory-stats"

/**
 * Thin agent-loop metrics helper (RFC §8 Phase 3). The Metrics registry already
 * exists in @/observability; this just names the loop's counters/timers in one
 * place and no-ops when no registry is configured. Behavior-preserving: the
 * loop only touches an {@link AgentRecorder} when `config.metrics` is present.
 */

/** Stable metric names — kept in one place so the snapshot is predictable. */
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
}
