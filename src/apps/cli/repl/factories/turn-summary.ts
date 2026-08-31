import {
  createDecisionCounterSink,
  defaultMetricsRegistry,
  type MetricsRegistry,
} from "@/observability/metrics/index"
import { emitOperatorNotice } from "@/shared"
import type { StreamPort } from "@/stream"
import { TeeStream } from "@/stream"
import { createTurnSummary, type TurnSummaryCollector } from "../../turn-summary"
import type { CliFeatureConfig } from "../cli-feature-config"

/** ADR-0270 — gated MetricsRegistry allocator for the decision-counter sink.
 *  Returns a fresh `defaultMetricsRegistry()` when the caller's typed
 *  feature flag is ON; otherwise `undefined` so the byte-identical no-tee
 *  path holds (no MetricsRegistry allocated, no sink port appended).
 *
 *  Default-OFF: `featureCfg.decisionMetricsEnabled` is `false` unless the
 *  operator opts in via `QUANTA_DECISION_METRICS` (parsed up-front in
 *  `cli-feature-config.ts`). */
const resolveDecisionMetricsRegistry = (enabled: boolean): MetricsRegistry | undefined =>
  enabled ? defaultMetricsRegistry() : undefined

/** ADR-0270 — append the decision → counter sink to a stream tee. Pure helper
 *  with NO env / NO global state — every input is explicit so tests can drive
 *  it directly and so the wiring inside `buildTurnSummaryAndStream` stays
 *  byte-identical when `metrics` is `undefined`.
 *
 *  When `metrics === undefined` the function returns the literal `stream`
 *  reference (no TeeStream allocated, no extra fan-out). When wired, it
 *  returns a new TeeStream that forwards every event to BOTH the upstream
 *  `stream` and the sink — exactly the same tee posture the turn-summary /
 *  debug / indicator consumers use. */
const appendDecisionCounterSink = (
  stream: StreamPort,
  metrics: MetricsRegistry | undefined,
): StreamPort => {
  if (metrics === undefined) return stream
  const sink = createDecisionCounterSink({ metrics })
  return new TeeStream([stream, sink])
}

/** Build the turn-summary collector + tee-wrap the upstream stream. Default-ON
 *  for TTY surfaces (auto-OFF on pipes/redirects) so the operator sees a
 *  per-turn signal box (tools / verify-guard / compaction / memory / recovery)
 *  WITHOUT opting in. Explicit `QUANTA_TURN_SUMMARY=0|false|off|no` reverts to
 *  the pre-summary code path (`{collector: disabled, stream}` ⇒ the renderer
 *  returns `""` and we write nothing).
 *
 *  Byte-identical: when the collector is disabled the returned `stream`
 *  reference is the literal input — no TeeStream allocated, no extra fan-out,
 *  so the existing recorder/stdout/indicator port path is identical to today's.
 *
 *  ADR-0270 wire seam — the decision-counter sink is folded into the SAME tee
 *  position as the turn-summary collector. When `QUANTA_DECISION_METRICS=1`
 *  AND the summary collector is enabled, the returned stream tees to BOTH
 *  consumers. When the env knob is off (default), no sink is appended and the
 *  returned stream is whatever the summary path produced — preserving the
 *  byte-identical no-tee path when both consumers are disabled. */
export const buildTurnSummaryAndStream = (
  featureCfg: CliFeatureConfig,
  stream: StreamPort,
): {
  collector: TurnSummaryCollector
  stream: StreamPort
  decisionMetrics: MetricsRegistry | undefined
} => {
  const { enabled, verbose } = featureCfg.turnSummary
  const collector = createTurnSummary({ enabled, verbose })
  const decisionMetrics = resolveDecisionMetricsRegistry(featureCfg.decisionMetricsEnabled)
  if (!enabled) {
    // Summary collector OFF — the decision-counter sink can still be appended
    // if the operator opts in via the env knob. When both are OFF (the
    // default), the returned stream is the literal input (byte-identical
    // no-tee path).
    return {
      collector,
      stream: appendDecisionCounterSink(stream, decisionMetrics),
      decisionMetrics,
    }
  }
  // WS-G (UUX-1-18) — this is the INNERMOST tee wrapping the recorder leg on
  // the default-ON TTY path, so a silently-swallowed recorder/collector
  // failure latches its one operator notice here.
  const teed = new TeeStream([stream, collector.asStreamPort()], {
    onFirstDegrade: (record) => {
      emitOperatorNotice({
        severity: "warn",
        source: "stream",
        message: `a turn-stream sink degraded: ${record.reason}`,
        hint: "some events may be missing from the recorder or UX chrome",
      })
    },
  })
  return { collector, stream: appendDecisionCounterSink(teed, decisionMetrics), decisionMetrics }
}
