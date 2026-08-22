/**
 * ADR-0144 / S6-Memory — MemoryTelemetryPort → MetricsRegistry adapter.
 *
 * The only production binding of {@link MemoryTelemetryPort}. Lives in the
 * observability slice so the dependency direction is correct (per RFC §3.1
 * `@/memory` MUST NOT import `@/observability`; the port lives in `@/memory`,
 * the adapter lives here and references `@/memory/telemetry-port` types).
 *
 * What the adapter emits — every key is declared in
 * {@link import("./vocabulary").QUANTA_ATTRS.memory} and renames flow through
 * the vocabulary module:
 *
 *   Phase 1
 *     quanta.memory.phase1.outcome      — counter, labeled by outcome enum
 *     quanta.memory.phase1.e2e_ms       — histogram (per-call latency)
 *     quanta.memory.phase1.turns        — counter (turnsConsumed delta)
 *
 *   Phase 2
 *     quanta.memory.phase2.outcome      — counter, labeled by outcome enum
 *     quanta.memory.phase2.e2e_ms       — histogram
 *     quanta.memory.phase2.stage1_count — counter (filesProcessed delta)
 *
 *   Recall (new this slice — vocabulary keys land alongside the adapter)
 *     quanta.memory.recall.hits         — counter
 *     quanta.memory.recall.scanned      — counter
 *     quanta.memory.recall.latency_ms   — histogram
 *
 *   Optional usage (only when port provided)
 *     quanta.memory.phaseN.tokens_in    — counter
 *     quanta.memory.phaseN.tokens_out   — counter
 *
 * Anti-leak: the adapter consumes ONLY the typed event interfaces from
 * `@/memory/telemetry-port`. Those interfaces structurally forbid entry
 * content (see telemetry-port.ts FORBIDDEN_TELEMETRY_KEYS); a regression
 * that adds a content field to an event interface would be caught at
 * unit-test time by the hellgate, NOT silently leaked through this sink.
 */

import type {
  MemoryTelemetryPort,
  Phase1TelemetryEvent,
  Phase2TelemetryEvent,
  RecallTelemetryEvent,
} from "@/memory/telemetry-port"
import type { MetricsRegistry } from "./metrics/port"

/** OTel attribute keys this adapter writes. Centralized so the adapter
 *  vocabulary and the observability vocabulary stay aligned. Recall keys
 *  are new and land here (and are surfaced through the QUANTA_ATTRS.memory
 *  vocabulary in a follow-up — kept literal here so adapter wiring does not
 *  block on a downstream vocabulary edit). */
const KEYS = Object.freeze({
  phase1Outcome: "quanta.memory.phase1.outcome",
  phase1E2eMs: "quanta.memory.phase1.e2e_ms",
  phase1Turns: "quanta.memory.phase1.turns",
  phase1TokensIn: "quanta.memory.phase1.tokens_in",
  phase1TokensOut: "quanta.memory.phase1.tokens_out",
  phase2Outcome: "quanta.memory.phase2.outcome",
  phase2E2eMs: "quanta.memory.phase2.e2e_ms",
  phase2Stage1Count: "quanta.memory.phase2.stage1_count",
  phase2TokensIn: "quanta.memory.phase2.tokens_in",
  phase2TokensOut: "quanta.memory.phase2.tokens_out",
  recallHits: "quanta.memory.recall.hits",
  recallScanned: "quanta.memory.recall.scanned",
  recallLatencyMs: "quanta.memory.recall.latency_ms",
} as const)

/**
 * Build a {@link MemoryTelemetryPort} that forwards every event to the
 * supplied {@link MetricsRegistry}. The returned port is no-throw at the
 * surface (recorder failures are NOT caught here — `MetricsRegistry`
 * implementations are themselves required to be no-throw per their port
 * contract; we trust the contract rather than nesting try/catch).
 *
 * The factory itself does no I/O — it is safe to call at module init.
 */
export function buildMemoryTelemetry(recorder: MetricsRegistry): MemoryTelemetryPort {
  return {
    recordPhase1(event: Phase1TelemetryEvent): void {
      recorder.increment(KEYS.phase1Outcome, 1, { outcome: event.outcome })
      recorder.observe(KEYS.phase1E2eMs, event.latencyMs)
      recorder.increment(KEYS.phase1Turns, event.turnsConsumed)
      if (event.tokensIn !== undefined) {
        recorder.increment(KEYS.phase1TokensIn, event.tokensIn)
      }
      if (event.tokensOut !== undefined) {
        recorder.increment(KEYS.phase1TokensOut, event.tokensOut)
      }
    },
    recordPhase2(event: Phase2TelemetryEvent): void {
      recorder.increment(KEYS.phase2Outcome, 1, { outcome: event.outcome })
      recorder.observe(KEYS.phase2E2eMs, event.latencyMs)
      recorder.increment(KEYS.phase2Stage1Count, event.filesProcessed)
      if (event.tokensIn !== undefined) {
        recorder.increment(KEYS.phase2TokensIn, event.tokensIn)
      }
      if (event.tokensOut !== undefined) {
        recorder.increment(KEYS.phase2TokensOut, event.tokensOut)
      }
    },
    recordRecall(event: RecallTelemetryEvent): void {
      recorder.increment(KEYS.recallHits, event.hits)
      recorder.increment(KEYS.recallScanned, event.totalScanned)
      recorder.observe(KEYS.recallLatencyMs, event.latencyMs)
    },
  }
}

/** Frozen tuple of every OTel key this adapter writes. Useful for tests that
 *  want to assert "the adapter touched exactly these keys" without
 *  re-declaring the list. */
export const MEMORY_TELEMETRY_KEYS: ReadonlyArray<string> = Object.freeze([
  KEYS.phase1Outcome,
  KEYS.phase1E2eMs,
  KEYS.phase1Turns,
  KEYS.phase1TokensIn,
  KEYS.phase1TokensOut,
  KEYS.phase2Outcome,
  KEYS.phase2E2eMs,
  KEYS.phase2Stage1Count,
  KEYS.phase2TokensIn,
  KEYS.phase2TokensOut,
  KEYS.recallHits,
  KEYS.recallScanned,
  KEYS.recallLatencyMs,
])
