/**
 * Default in-memory PromptCacheObserver (ADR-0179).
 *
 * Pure in-memory book that aggregates `CacheHitEvent`s into per-model /
 * per-session rollups + named-breakpoint attribution, then snapshots with
 * the hit-rate + cost-savings math evaluated on demand. The optional
 * `MetricSink` (ADR-0144) is the ONLY transport — absent ⇒ snapshot-only.
 *
 * Plane-clean: imports `@/observability/metrics` (sink port only) +
 * `@/shared` (logger / QuantaError). No `@/agent`, `@/llm`, `@/tool`.
 *
 * See `./types.ts` for the contract narrative.
 */

import type { MetricSink } from "@/observability/metrics"
import { logger } from "@/shared"
import type {
  CacheBreakpointAttribution,
  CacheHitEvent,
  CacheModelRollup,
  CachePerformanceSnapshot,
  PromptCacheObserver,
  PromptCacheObserverOpts,
} from "./types"
import { PromptCacheError } from "./types"

/** Default pricing — mirrors ADR-0138 `DEFAULT_MODEL_PRICING`'s cache-bearing
 *  entries. Kept INDEPENDENTLY from the budget-ledger so the observer can be
 *  imported without coupling to `@/agent/*` (the budget-bridge wires the two
 *  primitives at the surface layer, not at the module-graph layer). */
const DEFAULT_CACHE_PRICING: Readonly<
  Record<string, { inputPerM: number; cacheReadPerM: number; cacheWritePerM: number }>
> = Object.freeze({
  "claude-opus-4-7": { inputPerM: 15, cacheReadPerM: 1.5, cacheWritePerM: 18.75 },
  "claude-sonnet-4-6": { inputPerM: 3, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
  "claude-haiku-4-5": { inputPerM: 1, cacheReadPerM: 0.1, cacheWritePerM: 1.25 },
})

/** Picked deliberately as the safe middle ground (mirrors ADR-0138). */
const FALLBACK_PRICING_KEY = "claude-sonnet-4-6"
const DEFAULT_MAX_EVENTS = 1000

/** Internal: mutable per-(model | session) accumulator. */
interface RollupAcc {
  inputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  savingsUsd: number
}

const emptyRollup = (): RollupAcc => ({
  inputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  savingsUsd: 0,
})

/** Hit-rate denominator = input + cache_create. When 0, hitRate = 0
 *  (avoid NaN; documented as a snapshot boundary). */
const computeHitRate = (
  inputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): number => {
  const denom = inputTokens + cacheCreationTokens
  if (denom <= 0) return 0
  return cacheReadTokens / denom
}

/** Savings = cacheRead × (inputPerM − cacheReadPerM) / 1e6.
 *  Floors at 0 when the discount is non-positive (defensive — should
 *  never happen with sane vendor pricing, but a misconfigured override
 *  must not produce a negative "savings"). */
const computeSavingsUsd = (
  cacheReadTokens: number,
  inputPerM: number,
  cacheReadPerM: number,
): number => {
  if (cacheReadTokens <= 0) return 0
  const delta = inputPerM - cacheReadPerM
  if (delta <= 0) return 0
  return (cacheReadTokens * delta) / 1_000_000
}

/** No-throw sink dispatch (contract #4 in types.ts). */
const safeSend = (sink: MetricSink | undefined, sample: Parameters<MetricSink["send"]>[0]): void => {
  if (sink === undefined) return
  try {
    sink.send(sample)
  } catch {
    // Swallow — the observer is part of the observability plane; a
    // misbehaving exporter must not crash the agent or block recording.
  }
}

/** Validate token counts BEFORE mutating any state. Throws on any negative
 *  count (caller bug — provider usage tokens are by definition >= 0). */
const validateEvent = (event: CacheHitEvent): void => {
  const bad = (n: number): boolean => !Number.isFinite(n) || n < 0
  if (
    bad(event.inputTokens) ||
    bad(event.cacheCreationTokens) ||
    bad(event.cacheReadTokens) ||
    bad(event.outputTokens)
  ) {
    throw new PromptCacheError(
      "negative-tokens",
      `negative or non-finite token count in CacheHitEvent (model=${event.model}, session=${event.sessionId})`,
    )
  }
}

/** Construct the default observer. */
export const defaultPromptCacheObserver = (
  opts: PromptCacheObserverOpts = {},
): PromptCacheObserver => {
  const pricing: Record<string, { inputPerM: number; cacheReadPerM: number; cacheWritePerM: number }> =
    { ...DEFAULT_CACHE_PRICING, ...(opts.pricing ?? {}) }
  const fallback =
    pricing[FALLBACK_PRICING_KEY] ?? DEFAULT_CACHE_PRICING[FALLBACK_PRICING_KEY] ?? {
      inputPerM: 0,
      cacheReadPerM: 0,
      cacheWritePerM: 0,
    }
  const sink = opts.metricsSink
  const maxEvents = Math.max(1, Math.floor(opts.maxEvents ?? DEFAULT_MAX_EVENTS))
  const now = opts.now ?? Date.now
  // Track whether we've already warned about each unknown model (don't spam
  // logs on a tight stream).
  const warnedUnknownModels = new Set<string>()

  // Sliding window of recent events (LRU). Aggregates below are MONOTONIC and
  // not recomputed from the ring — they accumulate across the entire lifetime
  // (contract #5).
  const eventRing: CacheHitEvent[] = []
  const perModel = new Map<string, RollupAcc>()
  const perSession = new Map<string, RollupAcc>()
  // Per-session × per-model split: needed because the recursive perSession
  // snapshot has its OWN perModel breakdown. Key: `session\x00model`.
  const perSessionModel = new Map<string, RollupAcc>()
  const breakpoints = new Map<string, CacheBreakpointAttribution>()

  // Lifetime totals (computed once on record so snapshot is O(states), not
  // O(events)).
  let totalInputTokens = 0
  let totalCacheCreationTokens = 0
  let totalCacheReadTokens = 0
  let totalSavingsUsd = 0

  const resolvePricing = (model: string): { inputPerM: number; cacheReadPerM: number } => {
    const hit = pricing[model]
    if (hit !== undefined) return hit
    if (!warnedUnknownModels.has(model)) {
      warnedUnknownModels.add(model)
      logger.warn(
        `prompt-cache: unknown model "${model}", falling back to ${FALLBACK_PRICING_KEY} pricing`,
      )
    }
    return fallback
  }

  const sessionModelKey = (sessionId: string, model: string): string => `${sessionId}\x00${model}`

  const updateRollup = (
    map: Map<string, RollupAcc>,
    key: string,
    event: CacheHitEvent,
    savings: number,
  ): void => {
    const r = map.get(key) ?? emptyRollup()
    r.inputTokens += event.inputTokens
    r.cacheCreationTokens += event.cacheCreationTokens
    r.cacheReadTokens += event.cacheReadTokens
    r.savingsUsd += savings
    map.set(key, r)
  }

  const emitMetrics = (event: CacheHitEvent, hitRate: number): void => {
    if (sink === undefined) return
    const labels = { model: event.model, session: event.sessionId }
    const at = now()
    safeSend(sink, {
      name: "prompt_cache.input_tokens",
      kind: "counter",
      value: event.inputTokens,
      labels,
      at,
    })
    safeSend(sink, {
      name: "prompt_cache.cache_read_tokens",
      kind: "counter",
      value: event.cacheReadTokens,
      labels,
      at,
    })
    safeSend(sink, {
      name: "prompt_cache.cache_write_tokens",
      kind: "counter",
      value: event.cacheCreationTokens,
      labels,
      at,
    })
    safeSend(sink, {
      name: "prompt_cache.hit_rate",
      kind: "gauge",
      value: hitRate,
      labels,
      at,
    })
  }

  const freezeRollup = (r: RollupAcc): CacheModelRollup =>
    Object.freeze({
      inputTokens: r.inputTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      cacheReadTokens: r.cacheReadTokens,
      hitRate: computeHitRate(r.inputTokens, r.cacheCreationTokens, r.cacheReadTokens),
      savingsUsd: r.savingsUsd,
    })

  const freezeBreakpoint = (b: CacheBreakpointAttribution): CacheBreakpointAttribution =>
    Object.freeze({ ...b })

  const buildPerModelMap = (
    src: Map<string, RollupAcc>,
  ): ReadonlyMap<string, CacheModelRollup> => {
    const out = new Map<string, CacheModelRollup>()
    for (const [k, v] of src.entries()) out.set(k, freezeRollup(v))
    return out
  }

  /** Build a snapshot for a single session, including its own per-model
   *  breakdown filtered to this session's events. perSession is empty in
   *  the nested snapshot (recursion stops at depth 1 — a session contains
   *  no further session scope). */
  const buildSessionSnapshot = (
    sessionId: string,
    rollup: RollupAcc,
  ): CachePerformanceSnapshot => {
    const sessionPerModel = new Map<string, RollupAcc>()
    for (const [k, v] of perSessionModel.entries()) {
      const [s, m] = k.split("\x00", 2) as [string, string]
      if (s === sessionId) sessionPerModel.set(m, v)
    }
    return Object.freeze({
      totalInputTokens: rollup.inputTokens,
      totalCacheCreationTokens: rollup.cacheCreationTokens,
      totalCacheReadTokens: rollup.cacheReadTokens,
      cacheHitRate: computeHitRate(
        rollup.inputTokens,
        rollup.cacheCreationTokens,
        rollup.cacheReadTokens,
      ),
      costSavingsUsd: rollup.savingsUsd,
      perModel: buildPerModelMap(sessionPerModel),
      perSession: new Map<string, CachePerformanceSnapshot>(),
    })
  }

  return {
    record(event: CacheHitEvent): void {
      validateEvent(event)
      const p = resolvePricing(event.model)
      const savings = computeSavingsUsd(event.cacheReadTokens, p.inputPerM, p.cacheReadPerM)

      // Push to ring AFTER validation; evict oldest when over cap (aggregates
      // do NOT shrink, contract #5).
      eventRing.push(event)
      while (eventRing.length > maxEvents) eventRing.shift()

      // Update per-model / per-session / per-(session,model) aggregates.
      updateRollup(perModel, event.model, event, savings)
      updateRollup(perSession, event.sessionId, event, savings)
      updateRollup(perSessionModel, sessionModelKey(event.sessionId, event.model), event, savings)

      // Update lifetime totals.
      totalInputTokens += event.inputTokens
      totalCacheCreationTokens += event.cacheCreationTokens
      totalCacheReadTokens += event.cacheReadTokens
      totalSavingsUsd += savings

      // Emit per-event metrics (4 samples when sink wired). Hit rate is the
      // EVENT-level rate (cache_read / (input + cache_create)) — not the
      // lifetime rate — so a per-turn gauge reflects per-turn behavior.
      const hitRate = computeHitRate(
        event.inputTokens,
        event.cacheCreationTokens,
        event.cacheReadTokens,
      )
      emitMetrics(event, hitRate)
    },

    attributeBreakpoint(name: string, tokenSpan: number, wasHit: boolean): void {
      // No-throw — caller-supplied tokenSpan that is non-finite or negative
      // contributes 0 to the running span; hit/miss count still updates.
      const span = Number.isFinite(tokenSpan) && tokenSpan > 0 ? tokenSpan : 0
      const existing = breakpoints.get(name)
      if (existing === undefined) {
        breakpoints.set(name, {
          breakpointName: name,
          tokenSpan: span,
          hitCount: wasHit ? 1 : 0,
          missCount: wasHit ? 0 : 1,
        })
        return
      }
      breakpoints.set(name, {
        breakpointName: name,
        tokenSpan: existing.tokenSpan + span,
        hitCount: existing.hitCount + (wasHit ? 1 : 0),
        missCount: existing.missCount + (wasHit ? 0 : 1),
      })
    },

    snapshot(): CachePerformanceSnapshot {
      const perModelFrozen = buildPerModelMap(perModel)
      const perSessionFrozen = new Map<string, CachePerformanceSnapshot>()
      for (const [sid, r] of perSession.entries()) {
        perSessionFrozen.set(sid, buildSessionSnapshot(sid, r))
      }
      const bpFrozen: ReadonlyMap<string, CacheBreakpointAttribution> | undefined =
        breakpoints.size === 0
          ? undefined
          : (() => {
              const m = new Map<string, CacheBreakpointAttribution>()
              for (const [k, v] of breakpoints.entries()) m.set(k, freezeBreakpoint(v))
              return m
            })()
      return Object.freeze({
        totalInputTokens,
        totalCacheCreationTokens,
        totalCacheReadTokens,
        cacheHitRate: computeHitRate(
          totalInputTokens,
          totalCacheCreationTokens,
          totalCacheReadTokens,
        ),
        costSavingsUsd: totalSavingsUsd,
        perModel: perModelFrozen,
        perSession: perSessionFrozen,
        // exactOptionalPropertyTypes — only set when populated.
        ...(bpFrozen !== undefined ? { breakpoints: bpFrozen } : {}),
      })
    },

    reset(): void {
      eventRing.length = 0
      perModel.clear()
      perSession.clear()
      perSessionModel.clear()
      breakpoints.clear()
      totalInputTokens = 0
      totalCacheCreationTokens = 0
      totalCacheReadTokens = 0
      totalSavingsUsd = 0
      warnedUnknownModels.clear()
    },
  }
}
