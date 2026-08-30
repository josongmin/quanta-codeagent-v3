/**
 * Default prompt-cache pricing (ADR-0182) — DERIVED, no longer a copy.
 *
 * A5 — this used to hard-code a mirror of the cache-bearing rate-card rows,
 * justified as plane-cleanliness against `@/agent/budget-ledger`. But the
 * canonical card lives in `@/observability/pricing` — the SAME slice — so the
 * duplication bought no isolation, only drift risk: a vendor price change had
 * to be re-typed here by hand, on faith. The table is now a projection of
 * {@link MODEL_RATE_CARD}: every entry that carries a cache-write rate
 * appears, field-mapped, and a card update propagates by construction.
 *
 * What deliberately SURVIVES from the old design:
 *   - the observer's slimmer field shape ({@link PromptCachePricing});
 *   - the operator override API (merged over this table by `default.ts`);
 *   - the unknown-model warn-once + sonnet fallback (safe-LOUD, ADR-0138 #4);
 *   - {@link SAFE_ZERO_PRICING} as the last-resort zero table.
 */

import { MODEL_RATE_CARD } from "../pricing"

/** Closed shape per pricing entry. exactOptionalPropertyTypes — every field is
 *  REQUIRED so the consumer never falls through to `undefined`. */
export interface PromptCachePricing {
  readonly inputPerM: number
  readonly outputPerM: number
  readonly cacheCreationPerM: number
  readonly cacheReadPerM: number
}

/** Identifier of the bundled fallback entry (operator-friendly: a string a
 *  reader can grep). */
export const FALLBACK_PRICING_MODEL = "claude-sonnet-4-6" as const

const derive = (): Record<string, PromptCachePricing> => {
  const out: Record<string, PromptCachePricing> = {}
  for (const [model, rate] of Object.entries(MODEL_RATE_CARD)) {
    // Cache-bearing entries only: a model with no cache-write rate has no
    // prompt-cache economics to observe.
    if (rate.cacheWritePerM === undefined) continue
    out[model] = Object.freeze({
      inputPerM: rate.inPerM,
      outputPerM: rate.outPerM,
      cacheCreationPerM: rate.cacheWritePerM,
      cacheReadPerM: rate.cacheReadPerM,
    })
  }
  return out
}

/** Bundled default pricing — the rate card's cache-bearing rows, projected.
 *  Frozen so a downstream caller cannot mutate the shared table by accident
 *  (the observer merges user overrides into a fresh object — never here). */
export const DEFAULT_PROMPT_CACHE_PRICING: Readonly<Record<string, PromptCachePricing>> =
  Object.freeze(derive())

/** Last-resort pricing if the fallback key itself is somehow absent (e.g. an
 *  operator passed `{}` to override the entire table). Zero rates make every
 *  computed savings = 0 — defensively safe rather than NaN. */
export const SAFE_ZERO_PRICING: PromptCachePricing = Object.freeze({
  inputPerM: 0,
  outputPerM: 0,
  cacheCreationPerM: 0,
  cacheReadPerM: 0,
})
