/**
 * W0.6 pricing provenance: known | unknown | estimated.
 *
 * Derived from the canonical {@link UsageCost} shape so ledger, meter, and
 * eval report do not each invent a second discriminant.
 */
import type { UsageCost } from "./types"

export type PricingProvenance = "known" | "unknown" | "estimated"

/** Classify a priced event. `pricingKnown` is the rate-card hit; a stand-in
 *  rate names a different `pricingModel`; unpriced zero keeps the event model. */
export const pricingProvenanceOf = (cost: UsageCost, model: string): PricingProvenance => {
  if (cost.pricingKnown) return "known"
  if (cost.pricingModel !== model) return "estimated"
  return "unknown"
}

const isProvenance = (raw: unknown): raw is PricingProvenance =>
  raw === "known" || raw === "unknown" || raw === "estimated"

/**
 * Persist/hydrate: a missing stamp is never promoted to `known`, even when the
 * model is on the rate card. A stored cost can still classify itself.
 */
export const hydratePricingProvenance = (
  raw: unknown,
  cost: UsageCost | undefined,
  model: string,
): PricingProvenance => {
  if (isProvenance(raw)) return raw
  if (cost !== undefined) return pricingProvenanceOf(cost, model)
  return "unknown"
}

/** Live `record` without a canonical cost: rate-card hit is known; a miss is
 *  the ledger's display-only sonnet fallback (estimated, not enforced). */
export const livePricingProvenance = (
  eventCost: UsageCost | undefined,
  stamped: unknown,
  model: string,
  modelOnCard: boolean,
): PricingProvenance => {
  if (isProvenance(stamped)) return stamped
  if (eventCost !== undefined) return pricingProvenanceOf(eventCost, model)
  return modelOnCard ? "known" : "estimated"
}

/** USD hard-cap enforcement applies only to measured (known) amounts. */
export const usdEnforced = (provenance: PricingProvenance): boolean => provenance === "known"
