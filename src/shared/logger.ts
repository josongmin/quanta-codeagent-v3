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
 *
 * ## R10 — `logger.child({ caller })` ergonomic API
 *
 * Passing the per-tenant `caller` as a third argument at every call site is
 * boilerplate and easy to forget. `logger.child({ caller })` returns a
 * sub-logger whose four severity methods auto-inject the caller into the
 * bucket label. Calling code (e.g. `PluginHost` — one log line per tenant
 * frame) constructs the sub-logger once per tenant and uses it like the
 * base logger:
 *
 *   const log = logger.child({ caller: this.proc.serviceName })
 *   log.warn("plugin-host: dropping non-object frame", { ... })
 *
 * Recursive composition concatenates the caller chain (`.` separator):
 * `logger.child({ caller: "A" }).child({ caller: "B" })` yields a sub-
 * logger whose effective caller is `A.B`. The concatenated id is run
 * through {@link sanitizeCaller} so a child component containing the
 * layer-owned `::` separator cannot synthesise a sibling's bucket id.
 *
 * Properties (sealed by `tests/unit/logger-child-ergonomic-hellgate.test.ts`):
 *
 *   - Output byte-identical: the visible log line shape is unchanged
 *     regardless of how deep the `child()` chain is. Caller flows into the
 *     BUCKET LABEL only.
 *   - Threshold gate runs FIRST: a hostile child caller cannot smuggle a
 *     debug-level line past the configured threshold.
 *   - Recursive: `.child()` itself returns a `Logger`, so `child().child()`
 *     composes — every chain produces a Logger with the same surface as
 *     the root.
 *   - Cost-free: the sub-logger is four arrow closures + a self-reference;
 *     no state, no map, no allocation per write.
 *
 * The third positional `callSite` argument on the sub-logger's methods is
 * preserved for back-compat with code that explicitly opts in to per-call
 * overrides. When supplied, it OVERRIDES the bound caller (the per-call
 * override is the explicit signal). Omitted ⇒ the bound caller is used —
 * the ergonomic path.
 */
import { consume, type LogCallSite, labelFor, rateLimitNow, sanitizeCaller } from "./log-rate-limit"
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

/** Surface of both the base {@link logger} and every sub-logger returned by
 *  {@link Logger.child}. Closed: any tool that takes a logger should accept
 *  this exact shape so the sub-logger composes cleanly. */
export interface Logger {
  debug: (msg: string, meta?: unknown, callSite?: LogCallSite) => void
  info: (msg: string, meta?: unknown, callSite?: LogCallSite) => void
  warn: (msg: string, meta?: unknown, callSite?: LogCallSite) => void
  error: (msg: string, meta?: unknown, callSite?: LogCallSite) => void
  /** Return a sub-logger that auto-injects `cs.caller` into the bucket
   *  label of every emit. Recursive: the returned logger has its own
   *  `child()`, and the caller chain is concatenated with `.` and passed
   *  through {@link sanitizeCaller}. See file docblock §"R10 — `logger.child`
   *  ergonomic API". */
  child: (cs: LogCallSite) => Logger
}

/** Build a sub-logger that binds `boundSite` into every emit. The four
 *  severity methods route to the shared {@link write} with the bound
 *  call-site as default; a per-call `callSite` override (rare — explicit
 *  opt-in) takes precedence so an ergonomic sub-logger can still emit a
 *  one-off line under a different bucket without re-deriving it.
 *
 *  `child` concatenates the bound caller with the new component
 *  (`bound.caller.newChild.caller`) and re-sanitizes once — so a hostile
 *  child component containing `::` cannot forge a sibling bucket via the
 *  composed id (the existing single-call defence holds at every depth).
 *
 *  Cost: four arrow closures + a `child` arrow that captures `boundSite`.
 *  No state, no map, no allocation per write call — strictly equivalent
 *  to inlining `logger.<level>(msg, meta, boundSite)` at every site. */
const buildChild = (boundSite: LogCallSite): Logger => ({
  debug: (msg, meta, callSite) => write("debug", msg, meta, callSite ?? boundSite),
  info: (msg, meta, callSite) => write("info", msg, meta, callSite ?? boundSite),
  warn: (msg, meta, callSite) => write("warn", msg, meta, callSite ?? boundSite),
  error: (msg, meta, callSite) => write("error", msg, meta, callSite ?? boundSite),
  child: (cs) => {
    // Concatenate the bound caller chain with the new component (`.`
    // separator) then re-sanitize once. A child component bringing the
    // layer-owned `::` separator is stripped — the bucket id is always
    // the fused, sanitized chain. Empty / undefined components fall back
    // to the bound caller (back-compat: child({}) == child of same id).
    const next =
      cs.caller === undefined || cs.caller === ""
        ? boundSite.caller
        : `${boundSite.caller ?? ""}.${cs.caller}`
    return buildChild(makeCallSite(sanitizeCaller(next)))
  },
})

/** Build a {@link LogCallSite} from a possibly-undefined caller, respecting
 *  `exactOptionalPropertyTypes`: when `caller` is undefined the key is
 *  OMITTED entirely (sanitizeCaller returns undefined for blank / forged-
 *  separator ids — those must collapse to the legacy no-caller bucket). */
const makeCallSite = (caller: string | undefined): LogCallSite =>
  caller === undefined ? {} : { caller }

export const logger: Logger = {
  debug: (msg: string, meta?: unknown, callSite?: LogCallSite) =>
    write("debug", msg, meta, callSite),
  info: (msg: string, meta?: unknown, callSite?: LogCallSite) => write("info", msg, meta, callSite),
  warn: (msg: string, meta?: unknown, callSite?: LogCallSite) => write("warn", msg, meta, callSite),
  error: (msg: string, meta?: unknown, callSite?: LogCallSite) =>
    write("error", msg, meta, callSite),
  child: (cs: LogCallSite) => buildChild(makeCallSite(sanitizeCaller(cs.caller))),
}
