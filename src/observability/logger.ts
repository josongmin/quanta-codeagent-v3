import { type LogLevel, runtimeConfig } from "@/shared"
import type { LogRecord, LogSink, StructuredLoggerOptions } from "./types"

/** Severity ordering. Mirrors the convention in `@/shared`'s line logger
 *  (debug < info < warn < error) so the two loggers stay threshold-compatible
 *  without this slice re-implementing or importing its private `write`. */
const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** Resolve the effective threshold: explicit option ›› `runtimeConfig().logLevel` ›› default.
 *  S5: a single owner of the env (`runtime-config.ts`) validates `QUANTA_LOG_LEVEL`
 *  once at startup — a garbage value falls back to `info` with a stderr warn,
 *  rather than silently dropping every log line. */
const resolveLevel = (explicit: LogLevel | undefined): LogLevel =>
  explicit ?? runtimeConfig().logLevel

const defaultSink: LogSink = (line) => {
  // stderr only: stdout is reserved for the agent stream (same rule as @/shared).
  process.stderr.write(`${line}\n`)
}

/**
 * Structured, JSON-per-line logger for machine-consumable observability.
 *
 * Distinct from `@/shared`'s `logger`, which emits a tiny human `[level] msg`
 * line. This one emits one `JSON.stringify(LogRecord)` per call so downstream
 * tooling (the agent loop, adapters, later a collector) can parse fields. It
 * deliberately reuses the shared level ordering + env var rather than wrapping
 * the shared logger, because the shared logger's output format is not JSON.
 */
export class StructuredLogger {
  private readonly threshold: number
  private readonly sink: LogSink
  private readonly now: () => number
  private readonly base: Record<string, unknown>

  constructor(options: StructuredLoggerOptions = {}, base: Record<string, unknown> = {}) {
    this.threshold = ORDER[resolveLevel(options.level)]
    this.sink = options.sink ?? defaultSink
    this.now = options.now ?? Date.now
    this.base = base
  }

  /** Derive a child logger that injects `fields` into every record (e.g. a request id). */
  child(fields: Record<string, unknown>): StructuredLogger {
    return new StructuredLogger(
      { level: this.levelName(), sink: this.sink, now: this.now },
      { ...this.base, ...fields },
    )
  }

  private levelName(): LogLevel {
    const entry = (Object.entries(ORDER) as [LogLevel, number][]).find(
      ([, n]) => n === this.threshold,
    )
    return entry ? entry[0] : "info"
  }

  private emit(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < this.threshold) return
    const record: LogRecord = {
      ts: this.now(),
      level,
      event,
      fields: { ...this.base, ...fields },
    }
    this.sink(JSON.stringify(record))
  }

  debug(event: string, fields?: Record<string, unknown>): void {
    this.emit("debug", event, fields)
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.emit("info", event, fields)
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.emit("warn", event, fields)
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.emit("error", event, fields)
  }
}

/** Shared default instance. Tests construct fresh instances instead. */
export const log = new StructuredLogger()
