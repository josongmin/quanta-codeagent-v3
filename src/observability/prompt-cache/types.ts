/**
 * Prompt-cache observability — typed port (ADR-0179).
 *
 * Anthropic Messages API exposes prompt caching via `cache_control:
 * {type: "ephemeral"}` breakpoints on system / user blocks (≤4 breakpoints,
 * 5-minute TTL). Each completion's `usage` reports two disjoint buckets:
 *
 *   - `cache_creation_input_tokens` — tokens written into a fresh cache entry
 *     (one-time cost ~1.25× input rate).
 *   - `cache_read_input_tokens`     — tokens served from an existing cache
 *     entry (10× discount vs. standard input).
 *
 * ADR-0138 (`@/agent/budget-ledger`) already accumulates these counts and
 * bills them via per-model pricing. What is missing is a **per-prefix /
 * per-session cache hit-rate primitive**: an observability surface that
 * answers "of the tokens that would have been billed at input rate, what
 * fraction were cache reads?" + "how much USD did the cache save us?" +
 * "which named breakpoint is hitting vs. missing?"
 *
 * SOTA reference:
 *   - Claude Code surfaces raw `cache_read_input_tokens` in `/cost`; no
 *     hit-rate, no breakpoint attribution.
 *   - Cursor proprietary internal metric, no operator surface.
 *   - OpenAI Playground shows `usage.cached_tokens` (automatic caching, no
 *     declared breakpoints — different mechanism).
 *   - quanta first to expose typed `PromptCacheObserver` with named-breakpoint
 *     attribution + cost-savings math.
 *
 * Plane-clean: this module imports ONLY `@/shared` (QuantaError base) and the
 * sibling `MetricSink` port from `@/observability/metrics`. NO `@/agent/loop`,
 * `@/llm`, `@/tool` — those are future callers, never collaborators of this
 * primitive (RFC §3.1 slice fence).
 *
 * Default-OFF: nothing in the loop instantiates this observer today. Surfaces
 * (apps/agent bootstrap, future dispatch.ts auto-record from stream usage)
 * opt in by constructing `defaultPromptCacheObserver()` and routing each
 * completion's usage block through `record(...)`. With NO observer wired,
 * the budget-ledger continues to record raw token counts; no cache-specific
 * observability is emitted (zero call sites changed).
 *
 * Contract (6):
 *   1. PURE STORE: in-memory only, 0 I/O. The optional `MetricSink` is the
 *      ONLY transport — when absent, `snapshot()` is the only readout.
 *   2. NO-THROW on `record` happy path. Validation surfaces ONE `PromptCacheError`
 *      kind: `negative-tokens`. Unknown-model is NOT thrown — the observer
 *      falls back to the bundled pricing key (parity with ADR-0138 safe-LOUD
 *      posture so the operator notices the unknown model in the breakdown
 *      rather than getting $0 savings).
 *   3. exactOptionalPropertyTypes strict — every optional field is OMITTED on
 *      the wire when absent, never `undefined` (Closed-port plane discipline).
 *   4. SINK NO-THROW: a sink that throws on `send` is wrapped + swallowed; the
 *      observer's own aggregates still update.
 *   5. LRU EVENT CAP: when the retained event ring exceeds `maxEvents`,
 *      OLDEST events drop from the buffer BUT aggregates (perModel /
 *      perSession totals) are MONOTONIC — they do not shrink as events evict.
 *      This is deliberate: a long-running session reflects lifetime totals
 *      from the observer's perspective; the ring is for future "last N
 *      events" panels.
 *   6. DETERMINISTIC TIME: every wall-clock read goes through the injected
 *      `now()` so tests can pin event timing. `record` accepts `atMs` from
 *      the caller — the clock is for the LRU's eviction signal only.
 */

import type { MetricSink } from "@/observability/metrics"
import { QuantaError } from "@/shared"

/** One usage observation from a model stream end. Caller forwards these as
 *  soon as the completion settles — the same hook that feeds the budget
 *  ledger (ADR-0138). */
export interface CacheHitEvent {
  /** Model id, e.g. `"claude-opus-4-7"`. Used to look up pricing for the
   *  cost-savings math. */
  readonly model: string
  /** Owning session id (per-session rollup key). */
  readonly sessionId: string
  /** Optional 0-based turn index within the session. Omitted ⇒ caller did
   *  not have one to provide (the observer never invents one). */
  readonly turnIndex: number
  /** Epoch ms when the event was recorded (caller-supplied — usually the
   *  stream-end timestamp, NOT the registry clock). */
  readonly atMs: number
  /** Standard input tokens consumed (NOT including cache buckets). */
  readonly inputTokens: number
  /** Cache-creation tokens — wrote new entries (one-time write cost). */
  readonly cacheCreationTokens: number
  /** Cache-read tokens — hit existing entries (10× discount vs. input). */
  readonly cacheReadTokens: number
  /** Standard output tokens produced (carried for future per-turn rollup;
   *  not used in hit-rate math). */
  readonly outputTokens: number
}

/** Per-breakpoint attribution row. A "breakpoint" is one declared
 *  `cache_control: {type: "ephemeral"}` anchor in the request (Anthropic
 *  caps at 4); the caller names it (`"system-prefix"`, `"rules"`,
 *  `"memory-recall"`, `"tool-defs"`, ...) and reports per turn whether the
 *  breakpoint hit the cache. */
export interface CacheBreakpointAttribution {
  /** Caller-supplied breakpoint name (free-form, NOT validated by the
   *  observer — names ARE the keys in the breakpoints map). */
  readonly breakpointName: string
  /** Cumulative tokens this breakpoint has covered across all calls
   *  (sum of `tokenSpan` passed to `attributeBreakpoint`). */
  readonly tokenSpan: number
  /** Cumulative hits. */
  readonly hitCount: number
  /** Cumulative misses. */
  readonly missCount: number
}

/** Per-(model | session) cost-savings rollup. Used twice: once inside the
 *  top-level snapshot (`perModel` / `perSession`) and as the SHAPE returned
 *  by the `perSession` map's recursive nested snapshot when the caller
 *  drills down. */
export interface CacheModelRollup {
  readonly inputTokens: number
  readonly cacheCreationTokens: number
  readonly cacheReadTokens: number
  /** `cache_read / (input + cache_create)`. 0 when the denominator is 0
   *  (no input + no cache_create on record). */
  readonly hitRate: number
  /** USD saved vs. paying input rate for the cache-read tokens.
   *  Formula: `cacheReadTokens × (inputPerM − cacheReadPerM) / 1e6`. */
  readonly savingsUsd: number
}

/** Top-level snapshot. `perSession` is a recursive scope (one snapshot per
 *  session, scoped to that session's events). `breakpoints` is OPTIONAL —
 *  omitted (exactOptionalPropertyTypes) when no `attributeBreakpoint` calls
 *  have been made. */
export interface CachePerformanceSnapshot {
  readonly totalInputTokens: number
  readonly totalCacheCreationTokens: number
  readonly totalCacheReadTokens: number
  /** Top-level hit rate: `cache_read / (input + cache_create)`. 0..1. */
  readonly cacheHitRate: number
  /** Top-level cost savings vs. paying input rate for cache-read tokens. */
  readonly costSavingsUsd: number
  /** Per-model rollup keyed by `model`. */
  readonly perModel: ReadonlyMap<string, CacheModelRollup>
  /** Recursive per-session snapshot. Each value is a FULL snapshot scoped
   *  to that session — same fields, same shapes — so a caller can drill
   *  down without re-iterating events. */
  readonly perSession: ReadonlyMap<string, CachePerformanceSnapshot>
  /** Per-breakpoint attribution. OMITTED when no breakpoint was named. */
  readonly breakpoints?: ReadonlyMap<string, CacheBreakpointAttribution>
}

/** Public observer surface. */
export interface PromptCacheObserver {
  /** Record one usage event. Validates token counts; emits 4 metric samples
   *  per call when a sink is wired (`prompt_cache.input_tokens`,
   *  `prompt_cache.cache_read_tokens`, `prompt_cache.cache_write_tokens`,
   *  `prompt_cache.hit_rate`). Throws `PromptCacheError("negative-tokens",
   *  ...)` on any negative token count; otherwise no-throw. */
  record(event: CacheHitEvent): void
  /** Attribute tokens to a named breakpoint. Caller invokes once per turn
   *  for each known `cache_control` breakpoint with the byte/token span
   *  and whether the breakpoint hit the cache. */
  attributeBreakpoint(name: string, tokenSpan: number, wasHit: boolean): void
  /** Read-only snapshot. Always returns a populated, frozen object. */
  snapshot(): CachePerformanceSnapshot
  /** Reset ALL state (events, breakpoints, aggregates). */
  reset(): void
}

/** Observer options. */
export interface PromptCacheObserverOpts {
  /** ADR-0138 pricing — for cost-savings math. Merged with the bundled
   *  default pricing; caller entries WIN on name collision. */
  readonly pricing?: Readonly<
    Record<string, { inputPerM: number; cacheReadPerM: number; cacheWritePerM: number }>
  >
  /** MetricSink (ADR-0144) — emit counters + a hit-rate gauge per record. */
  readonly metricsSink?: MetricSink
  /** LRU ring cap on retained events. Default 1000. Clamped to >= 1.
   *  Aggregates DO NOT shrink as events evict (contract #5). */
  readonly maxEvents?: number
  /** Injected clock for the LRU's eviction signal. Default `Date.now`. */
  readonly now?: () => number
}

/** Closed 2-arm error code union. */
export type PromptCacheErrorCode = "unknown-model" | "negative-tokens"

/** Throwing surface. Today the observer only emits `negative-tokens`;
 *  `unknown-model` is RESERVED for a future strict-mode flag (operator
 *  may opt-in to throw on unknown-pricing so dashboards never silently
 *  fall back). */
export class PromptCacheError extends QuantaError {
  readonly errorCode: PromptCacheErrorCode
  constructor(code: PromptCacheErrorCode, message: string) {
    super(`prompt-cache:${code}`, message)
    this.errorCode = code
  }
}
