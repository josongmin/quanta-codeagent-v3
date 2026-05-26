/**
 * Cache-control thread-stability audit — types (ADR-0319).
 *
 * Anthropic's Messages API anchors prompt-cache breakpoints with
 * `cache_control: { type: "ephemeral" }` markers on content blocks. The cache
 * hit/miss decision is based on the SHA-256 of the prefix up to (and
 * including) the marked block; a single byte of drift between two calls in
 * the same thread/session invalidates the cache. Codex avoids this whole
 * class of problems by passing `prompt_cache_key = thread_id` on every
 * request (codex-rs/core/src/client.rs:751) — server-side keying. Anthropic
 * has no equivalent: the prefix bytes ARE the key.
 *
 * This module provides a passive audit primitive: callers feed in a series
 * of prefix snapshots taken across the same thread/session and the analyzer
 * reports whether each marked breakpoint stayed byte-identical. It does NOT
 * touch the production code path — it is a diagnostic for the test bench
 * and for future regression coverage.
 *
 * Slice fence: imports ONLY `node:crypto` from inside this directory's
 * helpers; the public types here have no runtime dependencies. The analyzer
 * does NOT reach into `@/agent/prompt`, `@/llm/adapters/anthropic`, or
 * `@/observability/prompt-cache` — those are FUTURE callers, never
 * collaborators (RFC §3.1 plane-clean rule).
 *
 * Default-OFF: no production code instantiates the analyzer today; the
 * tools live here so a regression suite can opt in.
 */

/**
 * One captured snapshot of a single cache-control candidate block. A
 * snapshot pairs the exact `content` string the provider would see with
 * whether a `cache_control: ephemeral` marker is present and an offline
 * `hash` of the content for cheap equality comparison.
 *
 * `hash` is callee-supplied (typically `sha256` from `./hash.ts`) so the
 * analyzer can stay pure: callers who already hashed the content (e.g. via
 * a replay recorder) can reuse the hash, callers who haven't can ask
 * `./hash.ts` to compute it for them. The analyzer never re-hashes.
 *
 * `position` is the caller's labelled "where in the prefix is this block"
 * — e.g. `"system[0]"`, `"system[1]:user_append"`, `"messages[last]:text"`
 * — used for diff reporting only. Free-form, never validated; the value
 * `""` is legal (the analyzer reports `<unnamed>` in that case).
 */
export interface CachePrefixSnapshot {
  /** Human-readable position label for diff reports. */
  readonly position: string
  /** The exact bytes the provider would see for this block's `text`
   *  field. */
  readonly content: string
  /** Cache-control marker presence. `"ephemeral"` ⇒ caller declared a
   *  breakpoint here; `undefined` ⇒ no marker on this block. */
  readonly cacheControl: "ephemeral" | undefined
  /** Hex-encoded SHA-256 of `content` (caller-supplied; see `./hash.ts`).
   *  64 lowercase hex chars by convention; the analyzer compares as
   *  strings so any stable encoding works. */
  readonly hash: string
}

/**
 * Possible per-position drift kinds, surfaced when two snapshots at the
 * same `position` disagree across a thread.
 *
 *   - `content` — the `content` string differs (hash will also differ).
 *   - `marker`  — the `cacheControl` flag differs (one has the marker,
 *                 the other does not). The cache prefix is INVALIDATED
 *                 the moment a marker moves; this is as bad as content
 *                 drift.
 *   - `missing` — the position is present in one batch and absent in
 *                 another (the snapshot list length / labels do not
 *                 align). Reported as instability so the caller cannot
 *                 silently lose breakpoints.
 */
export type DriftKind = "content" | "marker" | "missing"

/**
 * One drift finding. `firstIndex` / `secondIndex` are 0-based indices into
 * the input `batches` (which one drifted from which) — handy for narrowing
 * down which turn introduced the drift.
 */
export interface DriftFinding {
  readonly position: string
  readonly kind: DriftKind
  readonly firstIndex: number
  readonly secondIndex: number
  /** Optional sample of WHAT differed (first ~80 chars of each side) for
   *  human-readable reports. OMITTED for `marker` / `missing` since
   *  there is no content delta. */
  readonly firstSample?: string
  readonly secondSample?: string
}

/**
 * Per-position attribution. `missingMarker: true` highlights breakpoints
 * the caller declared the FIRST time but dropped later (or vice versa) —
 * the analyzer ALWAYS flags this, even when content also drifts, because
 * a missing marker is the more diagnostic finding for cache miss audits.
 */
export interface PositionReport {
  readonly position: string
  readonly stable: boolean
  /** True when at least one batch declared a marker at this position. */
  readonly anyMarker: boolean
  /** True when at least one batch did NOT declare a marker at this
   *  position (mixed marker presence ⇒ this is `true` AND `anyMarker`
   *  is true ⇒ the analyzer reports a `marker` drift). */
  readonly missingMarker: boolean
}

/**
 * Top-level stability report. `stable === true` ⇔ every position across
 * every snapshot batch agreed on both `hash` and `cacheControl`.
 *
 * The report is INTENTIONALLY conservative: any drift, anywhere, flips
 * `stable` to false. A caller that wants to ignore tail-message drift
 * (e.g. the per-turn `<system-reminder>`) should filter snapshots
 * BEFORE feeding them in — the analyzer never invents a policy.
 */
export interface StabilityReport {
  readonly stable: boolean
  readonly totalBatches: number
  readonly totalPositions: number
  readonly findings: readonly DriftFinding[]
  readonly perPosition: readonly PositionReport[]
}
