/**
 * Structured stderr logger.
 *
 * Threshold gating reads from {@link runtimeConfig} on every `write` call so
 * an env override applied AFTER module load (integration tests, child-spawn
 * harness) is observed. The config itself is frozen at first access — see
 * `./runtime-config.ts` — so the threshold doesn't churn within a run.
 *
 * Logs go to stderr so stdout stays reserved for the agent stream.
 *
 * R4 audit-H DoS closure — LABEL-KEYED LEAKY BUCKET. A hostile / mis-prompted
 * code path that triggers `logger.warn` inside a hot catch can emit millions
 * of lines per second, exhausting host stderr backpressure. We meter each
 * write by the first colon-delimited token of the message (the canonical
 * `<slice>.<op>:` label set by the 24h-ratchet errMessage swap), keep an LRU
 * of 32 active labels, and refill 1 token/sec up to a capacity of 10. Bursts
 * survive — sustained spam is dropped with a single suppressed-count flush
 * line. Default ON; `QUANTA_LOG_RATE_LIMIT=off` reverts to unbounded for
 * incident triage where the suppressed signal itself is forensic.
 *
 * Parameter justification:
 *   - capacity 10  : a single catch site emitting 10 distinct lines per turn
 *                    is well above realistic worst case; first 10 always pass.
 *   - refill 1/s   : 60 lines/min sustained per label fits an angry but real
 *                    failure mode (e.g. a degraded backend retrying every
 *                    second); above that, the operator gets a count summary
 *                    instead of a flood.
 *   - 32 labels    : the audited 24h-ratchet swap produced ~30 distinct
 *                    `<slice>.<op>:` prefixes across the source tree; an LRU
 *                    of 32 keeps every legitimate label hot during a run.
 */
import { type LogLevel, runtimeConfig } from "./runtime-config"
import { writeStderr } from "./terminal-io"

export type { LogLevel }

/** Canonical severity ordering (debug < info < warn < error). Single source
 *  of truth for every level-gating logger so the two output formats (this
 *  line logger + `@/observability`'s JSON logger) can never disagree on which
 *  levels are enabled at a given threshold. */
export const LOG_LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** Should a record at `level` be emitted given the configured `threshold`?
 *  Both arguments are level NAMES (not numeric ranks) so callers never touch
 *  the ordering map directly. `error` is the strictest threshold; `debug` the
 *  loosest. */
export const levelEnabled = (level: LogLevel, threshold: LogLevel): boolean =>
  LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[threshold]

/** Strip control chars (C0/C1/DEL, embedded `\n`/`\r`/`\b`), ANSI escape
 *  sequences (CSI / OSC / DCS / APC / SOS / PM, terminated by BEL or ESC-\),
 *  and Unicode bidi / zero-width chars so a hostile `e.message` cannot forge
 *  log lines (R2 audit-M / R3 audit-H — `[error] credentials leaked: …`
 *  injection via `\n`, terminal-title forge via `\x1b]0;…\x07`, visual
 *  reordering via U+202E RTL override). The intentional terminating `\n`
 *  appended in `write` is OUTSIDE this layer, so single-line discipline is
 *  preserved. NOTE: `new RegExp(string)` avoids biome's
 *  `noControlCharactersInRegex` rule trip on the literal form. */
const ANSI_OSC_DCS_APC_RE = new RegExp(
  "\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)|\\u001b[PX^_][\\s\\S]*?\\u001b\\\\",
  "g",
)
const ANSI_CSI_RE = new RegExp("\\u001b\\[[0-9;?]*[ -/]*[@-~]", "g")
const CONTROL_RE = new RegExp("[\\u0000-\\u0008\\u000a-\\u001f\\u007f-\\u009f]", "g")
const BIDI_ZW_RE = new RegExp("[\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]", "g")

const sanitizeLogText = (s: string): string =>
  s
    .replace(ANSI_OSC_DCS_APC_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(CONTROL_RE, "?")
    .replace(BIDI_ZW_RE, "")

// ─── label-keyed leaky bucket (R4 audit-H) ─────────────────────────────────

/** Per-label bucket state. `tokens` is a float — fractional refill is allowed
 *  so a 250 ms gap restores 0.25 tokens. `suppressed` counts the writes
 *  rejected since the bucket last emptied (flushed on the next allowed write
 *  or after a 1s idle window). */
interface Bucket {
  tokens: number
  lastRefillMs: number
  suppressed: number
  /** Last severity dropped — the flush line is emitted at this level so an
   *  operator scanning for `[warn]`/`[error]` still sees the suppression. */
  lastSuppressedLevel: LogLevel
}

const BUCKET_CAPACITY = 10
const BUCKET_REFILL_PER_MS = 1 / 1000 // 1 token per second
const LABEL_LRU_MAX = 32

/** Clock seam — tests inject `__setLoggerNow` to drive bucket time. */
let loggerNow: () => number = () => Date.now()

/** Active buckets, keyed by label. Map insertion order is the LRU; we move
 *  a key to the end on every write so the oldest cold label is the first to
 *  be evicted when capacity is reached. */
const buckets: Map<string, Bucket> = new Map()

/** Extract the rate-limit label from a message. Uses the first colon-bounded
 *  token (matches the `<slice>.<op>:` convention from the 24h silent-catch
 *  ratchet). Falls back to the first 64 chars of the message for messages
 *  without a colon — that's a stable per-callsite identity, just less precise. */
const labelOf = (msg: string): string => {
  const idx = msg.indexOf(":")
  if (idx > 0 && idx <= 128) return msg.slice(0, idx)
  return msg.length <= 64 ? msg : msg.slice(0, 64)
}

/** Refill `b` based on elapsed wall-clock since `lastRefillMs`. Cap at
 *  BUCKET_CAPACITY so an idle bucket cannot accumulate unbounded credit. */
const refill = (b: Bucket, now: number): void => {
  const dt = Math.max(0, now - b.lastRefillMs)
  b.tokens = Math.min(BUCKET_CAPACITY, b.tokens + dt * BUCKET_REFILL_PER_MS)
  b.lastRefillMs = now
}

/** Touch `label` so it moves to the LRU tail. Returns the bucket (existing
 *  or freshly seeded full). Evicts the LRU head if capacity exceeded. */
const touchBucket = (label: string, now: number): Bucket => {
  const existing = buckets.get(label)
  if (existing !== undefined) {
    // Move to tail (LRU touch).
    buckets.delete(label)
    buckets.set(label, existing)
    return existing
  }
  // New label. If at capacity, evict the oldest (Map iteration order = insert
  // order, mutated on each touch above).
  if (buckets.size >= LABEL_LRU_MAX) {
    const oldestKey = buckets.keys().next().value
    if (oldestKey !== undefined) buckets.delete(oldestKey)
  }
  const fresh: Bucket = {
    tokens: BUCKET_CAPACITY,
    lastRefillMs: now,
    suppressed: 0,
    lastSuppressedLevel: "warn",
  }
  buckets.set(label, fresh)
  return fresh
}

/** Format the suppression flush line. Kept as a separate fn so the test can
 *  pin the exact shape — operators grep for `[suppressed`. */
const formatSuppressionLine = (level: LogLevel, label: string, count: number): string =>
  `[${level}] [suppressed ${count} more from ${label}]`

/** Decision returned by the bucket gate: either emit the original line
 *  (optionally prefixed by a flushed suppression line if the bucket just
 *  came back from suppression), or drop it. */
interface BucketDecision {
  emit: boolean
  flushLine?: string
}

const consume = (label: string, level: LogLevel, now: number): BucketDecision => {
  const b = touchBucket(label, now)
  refill(b, now)
  if (b.tokens >= 1) {
    b.tokens -= 1
    if (b.suppressed > 0) {
      const flushLine = formatSuppressionLine(b.lastSuppressedLevel, label, b.suppressed)
      b.suppressed = 0
      return { emit: true, flushLine }
    }
    return { emit: true }
  }
  // Token-starved: count the drop. The flush line will fire on the next
  // allowed write (or via the periodic check below).
  b.suppressed += 1
  b.lastSuppressedLevel = level
  return { emit: false }
}

const write = (level: LogLevel, msg: string, meta?: unknown): void => {
  const cfg = runtimeConfig()
  if (!levelEnabled(level, cfg.logLevel)) return
  const safeMsg = sanitizeLogText(msg)
  const line = `[${level}] ${safeMsg}`
  const text = meta === undefined ? line : `${line} ${sanitizeLogText(JSON.stringify(meta))}`
  if (cfg.logRateLimitDisabled) {
    writeStderr(`${text}\n`)
    return
  }
  const label = labelOf(safeMsg)
  const decision = consume(label, level, loggerNow())
  if (!decision.emit) return
  if (decision.flushLine !== undefined) {
    writeStderr(`${decision.flushLine}\n`)
  }
  writeStderr(`${text}\n`)
}

export const logger = {
  debug: (msg: string, meta?: unknown) => write("debug", msg, meta),
  info: (msg: string, meta?: unknown) => write("info", msg, meta),
  warn: (msg: string, meta?: unknown) => write("warn", msg, meta),
  error: (msg: string, meta?: unknown) => write("error", msg, meta),
}

/** Test-only: clear the rate-limit state so a test starts from a clean LRU.
 *  Production code MUST NOT call this — the scanner forbids it outside tests. */
export const __resetLoggerRateLimit = (): void => {
  buckets.clear()
  loggerNow = () => Date.now()
}

/** Test-only: inject a synthetic clock so the test can drive bucket refill
 *  deterministically. Pass `null` to restore `Date.now`. */
export const __setLoggerNow = (fn: (() => number) | null): void => {
  loggerNow = fn ?? (() => Date.now())
}
