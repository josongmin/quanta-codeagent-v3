/**
 * Default in-memory PromptCacheObserver (ADR-0182).
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

import type { MetricSink } from "@/observability/metrics/port"
import { logger } from "@/shared"
import {
  DEFAULT_PROMPT_CACHE_PRICING,
  FALLBACK_PRICING_MODEL,
  type PromptCachePricing,
  SAFE_ZERO_PRICING,
} from "./default-pricing"
import type {
  CacheBreakpointAttribution,
  CacheHitEvent,
  CacheModelRollup,
  CachePerformanceSnapshot,
  PromptCacheObserver,
  PromptCacheObserverOpts,
} from "./types"
import { PromptCacheError } from "./types"

/** PromptCacheObserverOpts.pricing uses a slimmer shape (no outputPerM —
 *  the observer doesn't read it). Project the bundled full table to that
 *  shape so the existing options API is unchanged. */
type ObserverPricing = { inputPerM: number; cacheReadPerM: number; cacheWritePerM: number }
const toObserverPricing = (p: PromptCachePricing): ObserverPricing => ({
  inputPerM: p.inputPerM,
  cacheReadPerM: p.cacheReadPerM,
  cacheWritePerM: p.cacheCreationPerM,
})
const BUNDLED_OBSERVER_PRICING: Readonly<Record<string, ObserverPricing>> = Object.freeze(
  Object.fromEntries(
    Object.entries(DEFAULT_PROMPT_CACHE_PRICING).map(([k, v]) => [k, toObserverPricing(v)]),
  ),
)
const BUNDLED_FALLBACK: ObserverPricing = toObserverPricing(
  DEFAULT_PROMPT_CACHE_PRICING[FALLBACK_PRICING_MODEL] ?? SAFE_ZERO_PRICING,
)

/** Internal: mutable per-(model | session) accumulator. */
interface RollupAcc {
  inputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  savingsUsd: number
}

interface SessionAcc {
  rollup: RollupAcc
  perModel: Map<string, RollupAcc>
}

const emptyRollup = (): RollupAcc => ({
  inputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  savingsUsd: 0,
})

const emptySessionAcc = (): SessionAcc => ({
  rollup: emptyRollup(),
  perModel: new Map<string, RollupAcc>(),
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
const safeSend = (
  sink: MetricSink | undefined,
  sample: Parameters<MetricSink["send"]>[0],
): void => {
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
  const pricing: Record<string, ObserverPricing> = {
    ...BUNDLED_OBSERVER_PRICING,
    ...(opts.pricing ?? {}),
  }
  const fallback = pricing[FALLBACK_PRICING_MODEL] ?? BUNDLED_FALLBACK
  const sink = opts.metricsSink
  const now = opts.now ?? Date.now
  // Track whether we've already warned about each unknown model (don't spam
  // logs on a tight stream).
  const warnedUnknownModels = new Set<string>()

  // Aggregate-only adapter: retain rollups, not event history. This keeps the
  // steady-state record path O(1) and makes snapshot cost scale with distinct
  // state keys rather than lifetime event count.
  const perModel = new Map<string, RollupAcc>()
  const perSession = new Map<string, SessionAcc>()
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
        `prompt-cache: unknown model "${model}", falling back to ${FALLBACK_PRICING_MODEL} pricing`,
      )
    }
    return fallback
  }

  const updateRollupAcc = (rollup: RollupAcc, event: CacheHitEvent, savings: number): void => {
    rollup.inputTokens += event.inputTokens
    rollup.cacheCreationTokens += event.cacheCreationTokens
    rollup.cacheReadTokens += event.cacheReadTokens
    rollup.savingsUsd += savings
  }

  const updateRollup = (
    map: Map<string, RollupAcc>,
    key: string,
    event: CacheHitEvent,
    savings: number,
  ): void => {
    const r = map.get(key) ?? emptyRollup()
    updateRollupAcc(r, event, savings)
    map.set(key, r)
  }

  const getOrCreateSession = (sessionId: string): SessionAcc => {
    const existing = perSession.get(sessionId)
    if (existing !== undefined) return existing
    const created = emptySessionAcc()
    perSession.set(sessionId, created)
    return created
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

  const buildPerModelMap = (src: Map<string, RollupAcc>): ReadonlyMap<string, CacheModelRollup> => {
    const out = new Map<string, CacheModelRollup>()
    for (const [k, v] of src.entries()) out.set(k, freezeRollup(v))
    return out
  }

  /** Build a snapshot for a single session. The per-model breakdown is stored
   *  under the session itself so snapshot stays O(session states), not
   *  O(session_count × global perSessionModel states). */
  const buildSessionSnapshot = (session: SessionAcc): CachePerformanceSnapshot => {
    const rollup = session.rollup
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
      perModel: buildPerModelMap(session.perModel),
      perSession: new Map<string, CachePerformanceSnapshot>(),
    })
  }

  return {
    record(event: CacheHitEvent): void {
      validateEvent(event)
      const p = resolvePricing(event.model)
      const savings = computeSavingsUsd(event.cacheReadTokens, p.inputPerM, p.cacheReadPerM)

      // Update per-model / per-session aggregates. Session-local per-model
      // state is stored under the session to keep snapshot linear in realized
      // state, not quadratic in sessions × models.
      updateRollup(perModel, event.model, event, savings)
      const session = getOrCreateSession(event.sessionId)
      updateRollupAcc(session.rollup, event, savings)
      updateRollup(session.perModel, event.model, event, savings)

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
      for (const [sid, session] of perSession.entries()) {
        perSessionFrozen.set(sid, buildSessionSnapshot(session))
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
      perModel.clear()
      perSession.clear()
      breakpoints.clear()
      totalInputTokens = 0
      totalCacheCreationTokens = 0
      totalCacheReadTokens = 0
      totalSavingsUsd = 0
      warnedUnknownModels.clear()
    },
  }
}
