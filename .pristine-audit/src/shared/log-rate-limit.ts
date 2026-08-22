/**
 * Label-keyed leaky bucket — the second stage of the line logger pipeline,
 * extracted from {@link ./logger.ts} (R8 audit SRP split). The sanitize
 * stage is pure ({@link ./log-sanitize.ts}); the writer in `logger.ts` only
 * consumes a `BucketDecision` from this module. All bucket state — the LRU
 * map, the synthetic-clock test seam, the suppression-flush formatting —
 * lives here.
 *
 * R4 audit-H DoS closure context: a hostile / mis-prompted code path that
 * triggers `logger.warn` inside a hot catch can emit millions of lines per
 * second, exhausting host stderr backpressure. We meter each write by the
 * first colon-delimited token of the message (the canonical
 * `<slice>.<op>:` label set by the 24h-ratchet errMessage swap), keep an
 * LRU of {@link LABEL_LRU_MAX} active labels, and refill 1 token/sec up to
 * {@link BUCKET_CAPACITY}. Bursts survive — sustained spam is dropped with
 * a single suppressed-count flush line. Default ON;
 * `QUANTA_LOG_RATE_LIMIT=off` reverts to unbounded for incident triage
 * where the suppressed signal itself is forensic.
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
 *
 * R5 audit-H closure: fresh bucket starts with 1 token (the first line
 * passes), NOT capacity. Otherwise an attacker who triggers
 * `LABEL_LRU_MAX + 1` distinct labels evicts an old bucket and gets a full
 * re-arm on re-touch (32 unique decoys × 10 capacity = 320/sec sustained vs
 * the documented 1/sec rate). Now sustained rate is bounded by refill
 * regardless of LRU churn.
 *
 * R5 audit-M2 closure: `[` / `]` are stripped from the LABEL when formatting
 * the suppression flush line so a hostile message-prefix cannot forge a
 * fake severity tag inside the flush template.
 *
 * R9 multi-tenant caller seam (R6 audit Agent2 #4 closure): the labeller
 * accepts an optional `caller` (per-tenant / per-slice id) and namespaces
 * the bucket label as `${caller}::${prefix}`. Two slices that emit the
 * same `slice.op:` prefix get distinct buckets so an adversarial slice
 * cannot quota-starve a benign sibling by spamming a shared message
 * prefix. The line FORMAT is unchanged (back-compat byte-identical when
 * caller omitted — every existing call site as of this commit); only the
 * INTERNAL bucket key changes. {@link sanitizeCaller} strips the
 * layer-owned `::` separator from injected ids (no sibling-bucket forgery)
 * + caps at 64 chars + collapses blank → undefined.
 */

import type { LogLevel } from "./runtime-config"

/** Optional call-site descriptor — see module-doc §"R9 multi-tenant caller
 *  seam". Default-OFF: omitting the field (every existing call site as of
 *  this commit) keeps the bucket label byte-identical to the legacy
 *  message-prefix-only form. */
export interface LogCallSite {
  /** Stable slice / tenant id (e.g. `"slice.search"`, `"tenant-A"`). Used
   *  ONLY as a bucket namespace; never emitted on the output line. Caller
   *  is responsible for choosing a stable id; this layer sanitizes (see
   *  {@link sanitizeCaller}). */
  readonly caller?: string
}

/** Strip the `::` namespace separator from a caller id so a malicious
 *  caller can't synthesize a sibling's bucket by embedding `tenantB::`
 *  inside its own id. Also trims surrounding whitespace and caps at 64
 *  chars so a giant caller can't be used to amplify a single bucket key.
 *  Empty / blank → `undefined` (treat as no caller; back-compat byte-
 *  identical to omitting the param). A single `:` is preserved — common
 *  in slice ids like `slice.op:phase`.
 *
 *  PURE: no I/O, no allocation beyond the result string, no observable
 *  side effects. Safe to call inside the hot logger write path. */
export const sanitizeCaller = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined
  // Strip every literal `::` occurrence (the separator we own) then trim.
  const stripped = raw.replaceAll("::", "").trim()
  if (stripped.length === 0) return undefined
  return stripped.length > 64 ? stripped.slice(0, 64) : stripped
}

/** Per-label bucket state. `tokens` is a float — fractional refill is
 *  allowed so a 250 ms gap restores 0.25 tokens. `suppressed` counts the
 *  writes rejected since the bucket last emptied (flushed on the next
 *  allowed write). */
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

/** Clock seam — tests inject {@link __setLoggerNow} to drive bucket time. */
let loggerNow: () => number = () => Date.now()

/** Active buckets, keyed by label. Map insertion order is the LRU; we move
 *  a key to the end on every write so the oldest cold label is the first
 *  to be evicted when capacity is reached. */
const buckets: Map<string, Bucket> = new Map()

/** Extract the rate-limit label from a message. Uses the first colon-
 *  bounded token (matches the `<slice>.<op>:` convention from the 24h
 *  silent-catch ratchet). Falls back to the first 64 chars of the message
 *  for messages without a colon — that's a stable per-callsite identity,
 *  just less precise. */
const labelOf = (msg: string): string => {
  const idx = msg.indexOf(":")
  if (idx > 0 && idx <= 128) return msg.slice(0, idx)
  return msg.length <= 64 ? msg : msg.slice(0, 64)
}

/** Refill `b` based on elapsed wall-clock since `lastRefillMs`. Cap at
 *  {@link BUCKET_CAPACITY} so an idle bucket cannot accumulate unbounded
 *  credit. */
const refill = (b: Bucket, now: number): void => {
  const dt = Math.max(0, now - b.lastRefillMs)
  b.tokens = Math.min(BUCKET_CAPACITY, b.tokens + dt * BUCKET_REFILL_PER_MS)
  b.lastRefillMs = now
}

/** Touch `label` so it moves to the LRU tail. Returns the bucket (existing
 *  or freshly seeded with `tokens: 1`). Evicts the LRU head if capacity
 *  exceeded. See module-doc R5 audit-H closure for the cold-start = 1
 *  rationale. */
const touchBucket = (label: string, now: number): Bucket => {
  const existing = buckets.get(label)
  if (existing !== undefined) {
    // Move to tail (LRU touch).
    buckets.delete(label)
    buckets.set(label, existing)
    return existing
  }
  // New label. If at capacity, evict the oldest (Map iteration order =
  // insert order, mutated on each touch above).
  if (buckets.size >= LABEL_LRU_MAX) {
    const oldestKey = buckets.keys().next().value
    if (oldestKey !== undefined) buckets.delete(oldestKey)
  }
  const fresh: Bucket = {
    // R5 audit-H: 1 token (NOT capacity) — cold-start gives one free line;
    // sustained spam is bounded by refill rate (1/s).
    tokens: 1,
    lastRefillMs: now,
    suppressed: 0,
    lastSuppressedLevel: "warn",
  }
  buckets.set(label, fresh)
  return fresh
}

/** Strip `[` / `]` from a label so a hostile message-prefix cannot forge a
 *  fake suppression line (R5 audit-M2). `[error] [fake ` becomes
 *  `?error? ?fake` when concatenated into the flush template. */
const stripBracketsForFlush = (label: string): string => label.replace(/[[\]]/g, "?")

/** Format the suppression flush line. Kept as a separate fn so the test
 *  can pin the exact shape — operators grep for `[suppressed`. */
const formatSuppressionLine = (level: LogLevel, label: string, count: number): string =>
  `[${level}] [suppressed ${count} more from ${stripBracketsForFlush(label)}]`

/** Decision returned by the bucket gate: either emit the original line
 *  (optionally prefixed by a flushed suppression line if the bucket just
 *  came back from suppression), or drop it. */
export interface BucketDecision {
  emit: boolean
  flushLine?: string
}

/** Consult the bucket for `label` at severity `level` and time `now`. The
 *  writer in `logger.ts` interprets the decision: emit + optional flush
 *  line, or drop silently and let the next allowed write carry the count. */
export const consume = (label: string, level: LogLevel, now: number): BucketDecision => {
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
  // allowed write.
  b.suppressed += 1
  b.lastSuppressedLevel = level
  return { emit: false }
}

/** Read the bucket clock — wraps the test seam so the writer never touches
 *  `loggerNow` directly. */
export const rateLimitNow = (): number => loggerNow()

/** Resolve the label for `msg` (colon-bounded prefix, ≤128 chars, else first
 *  64 chars of the message). When `caller` is supplied (after
 *  {@link sanitizeCaller}), the label is namespaced as
 *  `${caller}::${prefix}` so two slices that emit the same prefix get
 *  distinct buckets. Caller omitted → byte-identical to the legacy
 *  prefix-only label (back-compat invariant). Exported so the writer can
 *  derive the label from the already-sanitized text. */
export const labelFor = (msg: string, caller?: string): string => {
  const prefix = labelOf(msg)
  const safeCaller = sanitizeCaller(caller)
  return safeCaller === undefined ? prefix : `${safeCaller}::${prefix}`
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
