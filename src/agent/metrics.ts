import type { Metrics } from "@/observability"

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
}
