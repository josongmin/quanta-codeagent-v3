/**
 * Per-event cost math and aggregate folding for the cross-run budget ledger.
 *
 * Its own unit because that is exactly what it is: the arithmetic that turns
 * ONE `UsageEvent` into a `MutableCost`, and the fold that accumulates those
 * into the running per-model / per-session / per-day aggregates. The ledger
 * proper keeps the policy, the retention window, the breach memory, and the
 * durable codec — none of which this file knows about.
 *
 * The normalization boundary is here too: an event goes through
 * `normalizeUsage` BEFORE any rate is applied, so the provider's cache-token
 * convention is resolved once and this arithmetic has nothing provider-specific
 * left to get wrong.
 */
import { PRICING_VERSION } from "@/observability/pricing"
import {
  type ModelPrice,
  type NormalizedUsage,
  normalizeUsage,
  priceUsage,
} from "@/observability/usage-accounting"
// Type-only, so nothing at runtime points back at the ledger that imports us.
import type { UsageEvent } from "./budget-ledger"
import type { ModelPricing } from "./budget-ledger-pricing"

/** Convert tokens to USD given a per-million rate. Tokens × rate / 1M.
 *  Defensive: non-finite or negative tokens contribute 0 (a poisoned
 *  provider report cannot poison the ledger — same posture as
 *  `BudgetMeter.tick` in `@/agent/budget/meter.ts`). */
export const tokensToUsd = (tokens: number | undefined, perMillion: number | undefined): number => {
  if (tokens === undefined || perMillion === undefined) return 0
  if (!Number.isFinite(tokens) || tokens <= 0) return 0
  if (!Number.isFinite(perMillion) || perMillion <= 0) return 0
  return (tokens * perMillion) / 1_000_000
}

/** Fold one event's cost into a running aggregate keyed by model. */
export const foldInto = (agg: MutableCost, cost: MutableCost): void => {
  agg.inputCost += cost.inputCost
  agg.outputCost += cost.outputCost
  agg.cacheReadCost += cost.cacheReadCost
  agg.cacheWriteCost += cost.cacheWriteCost
  agg.totalCost += cost.totalCost
  agg.inputTokens += cost.inputTokens
  agg.outputTokens += cost.outputTokens
  agg.cacheReadTokens += cost.cacheReadTokens
  agg.cacheWriteTokens += cost.cacheWriteTokens
}

/** Internal: empty cost line for the running aggregator. Mutable so the
 *  aggregator can `+=` into it; we freeze before exposing externally. */
export type MutableCost = {
  model: string
  inputCost: number
  outputCost: number
  cacheReadCost: number
  cacheWriteCost: number
  totalCost: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export const emptyCost = (model: string): MutableCost => ({
  model,
  inputCost: 0,
  outputCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  totalCost: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

/** Compute the per-event cost using the resolved pricing (with fallback). */
export const positive = (n: number | undefined): number =>
  n !== undefined && Number.isFinite(n) && n > 0 ? n : 0

/**
 * Compute the per-event cost by DELEGATING to the single pricing formula.
 *
 * A4 — this used to be a second implementation of "normalized buckets × rates"
 * that merely agreed with `priceUsage`; now it IS `priceUsage`, with the
 * ledger's two policies applied around it:
 *
 *   1. FINITE-POSITIVE SANITIZE, first. Normalization deliberately lets
 *      NaN/Infinity through so the AUTHORITY can reject a broken report; the
 *      ledger's contract is the opposite — poisoned buckets contribute 0 and
 *      the event is retained. So every bucket is scrubbed BEFORE pricing, and
 *      no non-finite value can reach the formula.
 *   2. THE CALLER'S RATE CARD. The resolved pricing (override-merged, or the
 *      sonnet fallback) is projected into a one-key `ModelPrice` card so an
 *      operator override keeps winning through the delegation.
 */
export const computeEventCost = (event: UsageEvent, pricing: ModelPricing): MutableCost => {
  const c = emptyCost(event.model)
  const n = normalizeUsage({
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    ...(event.cacheReadTokens !== undefined ? { cacheReadTokens: event.cacheReadTokens } : {}),
    ...(event.cacheWriteTokens !== undefined ? { cacheWriteTokens: event.cacheWriteTokens } : {}),
  })
  c.inputTokens = positive(n.freshInputTokens)
  c.outputTokens = positive(n.outputTokens)
  c.cacheReadTokens = positive(n.cacheReadTokens)
  c.cacheWriteTokens = positive(n.cacheWriteTokens)

  const sanitized: NormalizedUsage = {
    model: n.model,
    provider: n.provider,
    freshInputTokens: c.inputTokens,
    cacheReadTokens: c.cacheReadTokens,
    cacheWriteTokens: c.cacheWriteTokens,
    outputTokens: c.outputTokens,
  }
  const card: Record<string, ModelPrice> = {
    [event.model]: {
      inPerM: pricing.inputPerM,
      outPerM: pricing.outputPerM,
      cacheReadPerM: pricing.cacheReadPerM ?? 0,
      ...(pricing.cacheWritePerM !== undefined ? { cacheWritePerM: pricing.cacheWritePerM } : {}),
    },
  }
  const priced = priceUsage(sanitized, card, { pricingVersion: PRICING_VERSION })
  c.inputCost = priced.freshInputUsd
  c.outputCost = priced.outputUsd
  c.cacheReadCost = priced.cacheReadUsd
  c.cacheWriteCost = priced.cacheWriteUsd
  c.totalCost = priced.totalUsd
  return c
}

export const AGGREGATE_EPSILON = 1e-12

export const isZeroish = (n: number): boolean => Math.abs(n) <= AGGREGATE_EPSILON

export const isEmptyAggregate = (agg: MutableCost): boolean =>
  isZeroish(agg.inputCost) &&
  isZeroish(agg.outputCost) &&
  isZeroish(agg.cacheReadCost) &&
  isZeroish(agg.cacheWriteCost) &&
  isZeroish(agg.totalCost) &&
  agg.inputTokens === 0 &&
  agg.outputTokens === 0 &&
  agg.cacheReadTokens === 0 &&
  agg.cacheWriteTokens === 0
