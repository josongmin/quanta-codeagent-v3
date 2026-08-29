/**
 * The single pricing formula (MR-01).
 *
 * Takes the rate card as a PARAMETER rather than importing it, so this module
 * sits underneath the rate table instead of beside it — that keeps
 * `@/observability/pricing` free to own the card and delegate here without a
 * dependency cycle, and it lets tests price against a fixture card.
 *
 * There is deliberately no provider branch here. All of that lives in
 * `normalizeUsage`; by the time usage reaches this function the buckets are
 * disjoint and pricing is four multiplications. Two pricing implementations
 * previously disagreed precisely because each carried its own copy of the
 * provider rule.
 */
import type { ModelPrice, NormalizedUsage, UsageCost } from "./types"

const PER_TOKEN = 1_000_000

export interface PriceUsageOpts {
  /**
   * Rate-card key to fall back on when `usage.model` is absent from the card.
   *
   * Omitted ⇒ an unknown model costs `0` with `pricingKnown: false`, which is
   * what a caller that reports "unpriceable" (rather than an estimate) wants.
   * Supplied ⇒ the stand-in's rates are used and `pricingKnown` is still
   * `false`, so unknown spend stays visible without ever masquerading as
   * measured.
   */
  readonly fallbackModel?: string
  /** Stamped onto the result so a historical cost can be re-derived. */
  readonly pricingVersion: string
}

/** Price disjoint usage buckets against a rate card. Pure. */
export const priceUsage = (
  usage: NormalizedUsage,
  rates: Readonly<Record<string, ModelPrice>>,
  opts: PriceUsageOpts,
): UsageCost => {
  const known = Object.hasOwn(rates, usage.model)
  const pricingModel = known || opts.fallbackModel === undefined ? usage.model : opts.fallbackModel
  const price = rates[pricingModel]

  if (price === undefined) {
    return {
      totalUsd: 0,
      freshInputUsd: 0,
      cacheReadUsd: 0,
      cacheWriteUsd: 0,
      outputUsd: 0,
      pricingKnown: false,
      pricingModel,
      pricingVersion: opts.pricingVersion,
    }
  }

  const freshInputUsd = (usage.freshInputTokens * price.inPerM) / PER_TOKEN
  const cacheReadUsd = (usage.cacheReadTokens * price.cacheReadPerM) / PER_TOKEN
  // A provider that does not bill cache creation omits the rate entirely; that
  // is a $0 bucket, not a missing price.
  const cacheWriteUsd = (usage.cacheWriteTokens * (price.cacheWritePerM ?? 0)) / PER_TOKEN
  const outputUsd = (usage.outputTokens * price.outPerM) / PER_TOKEN

  return {
    totalUsd: freshInputUsd + cacheReadUsd + cacheWriteUsd + outputUsd,
    freshInputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    outputUsd,
    pricingKnown: known,
    pricingModel,
    pricingVersion: opts.pricingVersion,
  }
}
