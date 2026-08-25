import { MODEL_RATE_CARD, type ModelPrice } from "@/observability/pricing"

/** Per-model pricing. All values are USD per one million tokens. */
export interface ModelPricing {
  readonly inputPerM: number
  readonly outputPerM: number
  readonly cacheReadPerM?: number
  readonly cacheWritePerM?: number
}

const deriveLedgerPricing = (
  card: Readonly<Record<string, ModelPrice>>,
): Record<string, ModelPricing> => {
  const out: Record<string, ModelPricing> = Object.create(null)
  for (const [model, rate] of Object.entries(card)) {
    out[model] = {
      inputPerM: rate.inPerM,
      outputPerM: rate.outPerM,
      cacheReadPerM: rate.cacheReadPerM,
      ...(rate.cacheWritePerM !== undefined ? { cacheWritePerM: rate.cacheWritePerM } : {}),
    }
  }
  return out
}

/** Ledger view of the canonical observability rate card. */
export const DEFAULT_MODEL_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze(
  deriveLedgerPricing(MODEL_RATE_CARD),
)
