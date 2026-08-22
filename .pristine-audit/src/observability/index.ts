export {
  type Attrs,
  attrs,
  mergeAttrs,
  permissionAttrs,
  postDenialAttrs,
  workMetricsAttrs,
} from "./attrs"
export { makeContextOnlySpanSink } from "./context-only-sink"
export {
  buildCostDashboard,
  type CostDashboard,
  renderDashboardMarkdown,
  renderDashboardText,
} from "./cost-dashboard"
export {
  buildLlmCostMetricsSink,
  emitLlmCostToOtel,
  type LlmCostLabels,
  type LlmCostSink,
} from "./llm-cost-emit"
export { log, StructuredLogger } from "./logger"
export { buildMemoryTelemetry, MEMORY_TELEMETRY_KEYS } from "./memory-telemetry"
export { Metrics, metrics } from "./metrics"
export { instrumentToolsForExport } from "./metrics/instrument-tool"
export { PREVIEW_MAX, previewPayload } from "./payload-preview"
export {
  costUsd,
  MODEL_RATE_CARD,
  type ModelPrice,
  PRICING_VERSION,
  type Provider,
  providerOf,
} from "./pricing"
export { buildShellOtelObserver } from "./shell-exec-otel"
export {
  __resetSpanSink,
  endSpan,
  getSpanSink,
  markSpanScoped,
  recordAttrs,
  SPAN_NAMES,
  type Span,
  type SpanName,
  type SpanSink,
  type SpanStatus,
  setSpanSink,
  spanTraceRef,
  startSpan,
} from "./spans"
// C1: the async-safe active-span ref other clusters (recorder DI, cassette
// metadata) import to stamp the enclosing span onto their events. Exported from
// the parent barrel (not just the `tracing` sub-barrel) because the consumers
// live outside the tracing slice and read the ref structurally.
export { getActiveTraceRef, type TraceRef } from "./tracing/active-context"
export {
  createTurnTimingCapture,
  safeTtftMs,
  type TurnTiming,
  type TurnTimingCapture,
} from "./turn-timing"
export type {
  Counter,
  Gauge,
  LogRecord,
  LogSink,
  MetricsSnapshot,
  MonotonicClock,
  StructuredLoggerOptions,
  Timer,
  TimerStats,
  TimerStop,
} from "./types"
export { ERROR_ATTRS, GEN_AI_ATTRS, QUANTA_ATTRS, QUANTA_SPAN_NAMES } from "./vocabulary"
export {
  accumulateWorkMetrics,
  buildWorkMetrics,
  type FileDiffStat,
  parseNumstat,
  summarizeWorkMetrics,
  type WorkMetrics,
} from "./work-metrics"
