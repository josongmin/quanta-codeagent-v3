/**
 * Map a canonical {@link UsageCost} onto the ledger's mutable cost line.
 *
 * Does NOT re-price. Token buckets are still normalized from the event so the
 * drill-down window stays populated when the caller already priced the USD.
 */
import { normalizeUsage, type UsageCost } from "@/observability/usage-accounting"
import type { UsageEvent } from "../budget-ledger"
import { emptyCost, type MutableCost, positive } from "../budget-ledger-cost"

const finiteUsd = (n: number): number => (Number.isFinite(n) && n >= 0 ? n : 0)

export const mutableCostFromCanonical = (event: UsageEvent, priced: UsageCost): MutableCost => {
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
  c.inputCost = finiteUsd(priced.freshInputUsd)
  c.outputCost = finiteUsd(priced.outputUsd)
  c.cacheReadCost = finiteUsd(priced.cacheReadUsd)
  c.cacheWriteCost = finiteUsd(priced.cacheWriteUsd)
  c.totalCost = finiteUsd(priced.totalUsd)
  return c
}
