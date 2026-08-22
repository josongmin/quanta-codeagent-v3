import type { LogLevel } from "@/shared"

/** A single structured log line. One `LogRecord` ⇒ one JSON object on stderr. */
export interface LogRecord {
  /** Unix epoch milliseconds (`Date.now()`), injectable for deterministic tests. */
  ts: number
  level: LogLevel
  /** Stable machine-readable event name, e.g. `"agent.turn.start"`. */
  event: string
  /** Arbitrary structured context. Always present (defaults to `{}`). */
  fields: Record<string, unknown>
}

/** Sink for rendered log lines. Defaults to stderr; injectable for tests. */
export type LogSink = (line: string) => void

export interface StructuredLoggerOptions {
  /** Override the level threshold. Defaults to `QUANTA_LOG_LEVEL` env, then `"info"`. */
  level?: LogLevel
  /** Where rendered lines go. Defaults to `process.stderr.write`. */
  sink?: LogSink
  /** Clock for the `ts` field. Defaults to `Date.now`. Inject for determinism. */
  now?: () => number
}

/** Monotonically increasing tally. */
export interface Counter {
  inc: (delta?: number) => void
  value: () => number
}

/** Arbitrary point-in-time value (last write wins). */
export interface Gauge {
  set: (value: number) => void
  value: () => number
}

/** Stops a running timer, recording the elapsed milliseconds, and returns it. */
export type TimerStop = () => number

/** Records durations. `start()` opens a span; the returned `stop()` records it. */
export interface Timer {
  /** Begin a span. Returns a `stop()` that records elapsed ms when called. */
  start: () => TimerStop
  /** Record a known duration directly (ms). Useful for externally-measured spans. */
  record: (ms: number) => void
}

/** Aggregated distribution for a single timer. */
export interface TimerStats {
  count: number
  min: number
  max: number
  mean: number
  /** Median (50th percentile), nearest-rank method. */
  p50: number
  /** 95th percentile, nearest-rank method. */
  p95: number
}

/** Immutable point-in-time view of the whole registry. */
export interface MetricsSnapshot {
  counters: Record<string, number>
  gauges: Record<string, number>
  timers: Record<string, TimerStats>
}

/** Clock for timers. Defaults to `performance.now`. Inject for determinism. */
export type MonotonicClock = () => number
