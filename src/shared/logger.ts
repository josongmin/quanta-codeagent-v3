/**
 * Structured stderr logger — composition root for the three pipeline stages:
 *
 *   1. sanitize  → {@link ./log-sanitize.ts}    (pure, no state)
 *   2. gate      → {@link ./log-rate-limit.ts}  (label-keyed leaky bucket)
 *   3. write     → {@link ./terminal-io.ts}     (stderr sink)
 *
 * R8 audit SRP split: this file was 272 LOC with four interleaved
 * responsibilities (sanitize / rate-limit / level-gating + write / test
 * seam). The split keeps level-gating + the four-method `logger` surface
 * here (where most call sites land via the `@/shared` barrel) and pushes
 * the sanitize regex set and the bucket machinery into siblings.
 *
 * Threshold gating reads from {@link runtimeConfig} on every `write` call so
 * an env override applied AFTER module load (integration tests, child-spawn
 * harness) is observed. The config itself is frozen at first access — see
 * `./runtime-config.ts` — so the threshold doesn't churn within a run.
 *
 * Logs go to stderr so stdout stays reserved for the agent stream.
 *
 * Rate-limit knob: `QUANTA_LOG_RATE_LIMIT=off` reverts the gate to
 * unbounded for incident triage where the suppressed signal itself is
 * forensic. See `log-rate-limit.ts` module-doc for capacity / refill
 * justification.
 *
 * ## Multi-tenant caller seam (R9 — R6 audit Agent2 #4 closure)
 *
 * Each of the four severity methods accepts an optional third arg
 * `{ caller }`. When omitted (every existing call site as of this commit)
 * the formatted output line is BYTE-IDENTICAL to the pre-seam shape —
 * single-process slices in the current desktop shape see no change. When
 * provided, the caller id is folded into the rate-limit BUCKET LABEL only
 * (via {@link labelFor}); the visible log line is unchanged. This gives
 * per-tenant quota isolation without re-shaping recorded session framing.
 * Threshold gating runs BEFORE the caller is read so a hostile caller
 * cannot smuggle a debug-level line past the configured threshold.
 */
import { consume, type LogCallSite, labelFor, rateLimitNow } from "./log-rate-limit"
import { sanitizeLogText } from "./log-sanitize"
import { type LogLevel, runtimeConfig } from "./runtime-config"
import { writeStderr } from "./terminal-io"

export { __resetLoggerRateLimit, __setLoggerNow, sanitizeCaller } from "./log-rate-limit"
export type { LogCallSite, LogLevel }

/** Canonical severity ordering (debug < info < warn < error). Single source
 *  of truth for every level-gating logger so the two output formats (this
 *  line logger + `@/observability`'s JSON logger) can never disagree on
 *  which levels are enabled at a given threshold. */
export const LOG_LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** Should a record at `level` be emitted given the configured `threshold`?
 *  Both arguments are level NAMES (not numeric ranks) so callers never touch
 *  the ordering map directly. `error` is the strictest threshold; `debug`
 *  the loosest. */
export const levelEnabled = (level: LogLevel, threshold: LogLevel): boolean =>
  LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[threshold]

const write = (level: LogLevel, msg: string, meta?: unknown, callSite?: LogCallSite): void => {
  const cfg = runtimeConfig()
  // Threshold gate FIRST — a hostile caller MUST NOT be able to smuggle a
  // debug-level line past the configured threshold by attaching a caller.
  if (!levelEnabled(level, cfg.logLevel)) return
  const safeMsg = sanitizeLogText(msg)
  const line = `[${level}] ${safeMsg}`
  const text = meta === undefined ? line : `${line} ${sanitizeLogText(JSON.stringify(meta))}`
  if (cfg.logRateLimitDisabled) {
    writeStderr(`${text}\n`)
    return
  }
  // Caller flows into the BUCKET LABEL only — the output line shape is
  // byte-identical regardless of caller (see file docblock §"Multi-tenant
  // caller seam").
  const label = labelFor(safeMsg, callSite?.caller)
  const decision = consume(label, level, rateLimitNow())
  if (!decision.emit) return
  if (decision.flushLine !== undefined) {
    writeStderr(`${decision.flushLine}\n`)
  }
  writeStderr(`${text}\n`)
}

export const logger = {
  debug: (msg: string, meta?: unknown, callSite?: LogCallSite) =>
    write("debug", msg, meta, callSite),
  info: (msg: string, meta?: unknown, callSite?: LogCallSite) => write("info", msg, meta, callSite),
  warn: (msg: string, meta?: unknown, callSite?: LogCallSite) => write("warn", msg, meta, callSite),
  error: (msg: string, meta?: unknown, callSite?: LogCallSite) =>
    write("error", msg, meta, callSite),
}
