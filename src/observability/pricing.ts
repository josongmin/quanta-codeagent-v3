/**
 * Versioned static price table (RFC-0002 §5.3).
 *
 * Pure, no network. Every derived cost event stamps {@link PRICING_VERSION}
 * so prices can be re-derived after table drift. Unknown model ⇒ `null`
 * (not an error) — cost is best-effort evidence, never authoritative.
 */
import { normalizeUsage } from "./usage-accounting/normalize"
import { priceUsage } from "./usage-accounting/price"
import type { ModelPrice } from "./usage-accounting/types"

export const PRICING_VERSION = "pricing.v3" as const

/**
 * Derive the billing provider from the model name. Kept inside observability so
 * the fix needs no cross-slice change: the model string already reaches every
 * cost callsite (`costUsd(model, …)`). `gpt`/`o1`/`o3`-prefixed → openai,
 * `claude`-prefixed → anthropic. Unknown prefixes default to anthropic, the
 * additive (and historically assumed) semantics — but unknown *models* still
 * return null from `costUsd` regardless, so this only matters for known models.
 */
export { providerOf } from "./usage-accounting/normalize"
/**
 * Provider determines how the reported `inputTokens` (prompt) usage field
 * relates to `cacheReadTokens`. This is NOT cosmetic — it changes the cost math:
 *
 * - **anthropic**: the API's `input_tokens` EXCLUDES cache reads. cache_read is
 *   a separate, disjoint bucket. Total billed input = input + cacheRead.
 * - **openai**: the API's `prompt_tokens` ALREADY INCLUDES `cached_tokens`.
 *   cache_read is a SUBSET of the reported input. Adding it again double-counts
 *   the cached tokens — the bug this module previously had.
 */
/** USD per 1,000,000 tokens. Canonical definition lives with the pricing
 *  formula; re-exported here so existing `@/observability/pricing` importers
 *  keep working. */
export type { ModelPrice, Provider } from "./usage-accounting/types"

/**
 * Public list prices, $/1M tokens. Sources (captured 2026-05-19 unless noted):
 * - OpenAI pricing page (openai.com/api/pricing):
 *     gpt-4o        $2.50 in / $10.00 out / $1.25 cached  (0.5×)
 *     gpt-4o-mini   $0.15 in / $0.60  out / $0.075 cached (0.5×)
 * - Anthropic pricing page (anthropic.com/pricing):
 *     claude-opus-4-7    $15 in / $75 out / $1.50 cache-read  (0.1×)
 *     claude-sonnet-4-6  $3  in / $15 out / $0.30 cache-read  (0.1×)
 *     claude-haiku-4-5   $1  in / $5  out / $0.10 cache-read  (0.1×)
 *
 * cache_read pricing is now PROVIDER-AWARE (pricing.v2). Previously cache_read
 * was billed at the full input rate AND added on top of `input` for every
 * provider; for OpenAI that double-counted, since `prompt_tokens` already
 * includes `cached_tokens`. See {@link costUsd} for the per-provider formula.
 *
 * Null-prototype on purpose: `model` is an untrusted external string, so a
 * plain object literal would resolve `TABLE["constructor"]` / `["toString"]` /
 * `["__proto__"]` to inherited `Object.prototype` members, defeating the
 * `=== undefined` unknown-model guard and yielding `NaN`. With no prototype
 * chain, every non-own key is genuinely `undefined`.
 */
const TABLE: Readonly<Record<string, ModelPrice>> = Object.assign(
  Object.create(null) as Record<string, ModelPrice>,
  {
    "gpt-4o": { inPerM: 2.5, outPerM: 10, cacheReadPerM: 1.25 },
    "gpt-4o-mini": { inPerM: 0.15, outPerM: 0.6, cacheReadPerM: 0.075 },
    // Anthropic cache-creation (write) ≈ 1.25× input — billed by the ledger.
    "claude-opus-4-7": { inPerM: 15, outPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 },
    "claude-sonnet-4-6": { inPerM: 3, outPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
    "claude-haiku-4-5": { inPerM: 1, outPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 },
    // ── gpt-5 family. CONFIRMED against OpenAI's API pricing page (captured
    // 2026-06-26: developers.openai.com/api/docs/pricing). The bench's primary
    // models (`--model` default `gpt-5.6-terra`; lanes gpt-5.4/gpt-5.5) are priced from
    // this single SSOT. cache-read is the documented 0.1× input rate for this
    // family (NOT gpt-4o's 0.5×). gpt-5 / gpt-5-mini are legacy GPT-5 launch
    // prices (absent from the current page); their cache-read follows the 0.1×
    // family rate. Truly-unknown models (e.g. lane alias `gpt-5-2`) stay `null`.
    // OpenAI model page captured 2026-08-26, after the 2026-07-30 price cut:
    // $2 input / $0.20 cached input / $12 output. GPT-5.6+ cache writes are
    // explicitly billed at 1.25× uncached input = $2.50/M.
    "gpt-5.6-terra": { inPerM: 2, outPerM: 12, cacheReadPerM: 0.2, cacheWritePerM: 2.5 },
    "gpt-5.5": { inPerM: 5, outPerM: 30, cacheReadPerM: 0.5 },
    "gpt-5.4": { inPerM: 2.5, outPerM: 15, cacheReadPerM: 0.25 },
    "gpt-5.4-mini": { inPerM: 0.75, outPerM: 4.5, cacheReadPerM: 0.075 },
    "gpt-5.4-nano": { inPerM: 0.2, outPerM: 1.25, cacheReadPerM: 0.02 },
    "gpt-5": { inPerM: 1.25, outPerM: 10, cacheReadPerM: 0.125 },
    "gpt-5-mini": { inPerM: 0.25, outPerM: 2, cacheReadPerM: 0.025 },
  },
)

/**
 * The rate card, exposed read-only as the SINGLE pricing SSOT. Consumers that
 * need per-component rates (the cross-run budget ledger's input/output/
 * cacheRead/cacheWrite breakdown) derive from THIS map instead of keeping a
 * second, drift-prone table. `costUsd` (total-cost, provider-aware) and the
 * ledger (per-component) are two views over the same numbers. Null-prototype is
 * preserved so an untrusted `model` key never resolves an inherited member.
 */
export const MODEL_RATE_CARD: Readonly<Record<string, ModelPrice>> = TABLE

/**
 * USD cost for a known model, or `null` for an unknown model.
 *
 * Zero tokens for a known model returns `0` (not `null`). Pure and
 * deterministic. The treatment of `cacheReadTokens` is PROVIDER-AWARE, derived
 * from the model name via {@link providerOf}:
 *
 *   - **anthropic** (`input_tokens` EXCLUDES cache reads):
 *       input·inRate + cacheRead·cacheRate + output·outRate
 *     i.e. cacheRead is an additional, disjoint bucket billed at the discounted
 *     cache-read rate.
 *
 *   - **openai** (`prompt_tokens` INCLUDES `cached_tokens`):
 *       (input − cacheRead)·inRate + cacheRead·cacheRate + output·outRate
 *     i.e. the cached portion is carved OUT of the reported input and re-priced
 *     at the discounted rate — NOT added on top. This fixes the prior
 *     double-count where `(input + cacheRead)·inRate` charged cached tokens
 *     twice (once inside `prompt_tokens`, once via `cacheRead`).
 *
 * `cacheReadTokens` is clamped to the reported `inputTokens` for OpenAI so a
 * malformed event (cached > prompt) can never produce a negative non-cached
 * portion.
 */
export const costUsd = (
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
): number | null => {
  // `Object.hasOwn` guard is redundant with the null-prototype TABLE above but
  // kept so the unknown-model contract survives even if TABLE is later changed
  // back to a plain object literal.
  if (!Object.hasOwn(TABLE, model)) return null

  // No `fallbackModel`: this entry point's contract is `null` for an unknown
  // model, so it must never be handed stand-in rates. Callers that prefer a
  // flagged ESTIMATE over "unpriceable" (the cross-run ledger) call
  // `priceUsage` directly with a fallback and read `pricingKnown`.
  const cost = priceUsage(
    normalizeUsage({ model, inputTokens, outputTokens, cacheReadTokens }),
    TABLE,
    { pricingVersion: PRICING_VERSION },
  )
  // `cacheWriteTokens` is structurally absent from this signature, so the
  // cache-write bucket is always 0 here. Cache-write-aware callers use
  // `priceUsage` directly — that is the whole reason the formula moved.
  return cost.totalUsd
}
