/**
 * Versioned static price table (RFC-0002 §5.3).
 *
 * Pure, no network. Every derived cost event stamps {@link PRICING_VERSION}
 * so prices can be re-derived after table drift. Unknown model ⇒ `null`
 * (not an error) — cost is best-effort evidence, never authoritative.
 */
export const PRICING_VERSION = "pricing.v2" as const

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
export type Provider = "openai" | "anthropic"

/**
 * Derive the billing provider from the model name. Kept inside observability so
 * the fix needs no cross-slice change: the model string already reaches every
 * cost callsite (`costUsd(model, …)`). `gpt`/`o1`/`o3`-prefixed → openai,
 * `claude`-prefixed → anthropic. Unknown prefixes default to anthropic, the
 * additive (and historically assumed) semantics — but unknown *models* still
 * return null from `costUsd` regardless, so this only matters for known models.
 */
export const providerOf = (model: string): Provider => {
  const m = model.toLowerCase()
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3")) return "openai"
  return "anthropic"
}

/** USD per 1,000,000 tokens. */
export interface ModelPrice {
  /** Input (prompt) tokens, $/1M. */
  inPerM: number
  /** Output (completion) tokens, $/1M. */
  outPerM: number
  /**
   * Cache-READ tokens, $/1M. Provider-documented discounted rate:
   *   - OpenAI gpt-4o family ≈ 0.5× input rate.
   *   - OpenAI gpt-5 family ≈ 0.1× input rate (per the gpt-5.x pricing page).
   *   - Anthropic cache read ≈ 0.1× input rate.
   * Always set explicitly per model so the discount is auditable.
   */
  cacheReadPerM: number
  /**
   * Cache-CREATION (write) tokens, $/1M. Anthropic bills a one-time premium
   * (≈ 1.25× input) to WRITE the prompt cache; OpenAI does not bill cache
   * creation separately (the field is omitted). {@link costUsd} does NOT read
   * this field — it is part of the single rate-card SSOT consumed by the
   * cross-run cost ledger (`@/agent/budget-ledger`), which DOES bill the
   * cache-creation bucket. Kept here so there is ONE rate table, not two.
   */
  cacheWritePerM?: number
}

/**
 * Public list prices, $/1M tokens. Sources (captured 2026-05-19):
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
    // models (`--model` default `gpt-5.4`; lanes gpt-5.4/gpt-5.5) are priced from
    // this single SSOT. cache-read is the documented 0.1× input rate for this
    // family (NOT gpt-4o's 0.5×). gpt-5 / gpt-5-mini are legacy GPT-5 launch
    // prices (absent from the current page); their cache-read follows the 0.1×
    // family rate. Truly-unknown models (e.g. lane alias `gpt-5-2`) stay `null`.
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

const PER_TOKEN = 1_000_000

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
  const price = TABLE[model]
  if (price === undefined) return null

  // Defensive NEGATIVE clamp (negatives only — NaN/Infinity deliberately pass
  // through as non-finite so a downstream check can DETECT a bad usage report
  // rather than trust a wrong dollar figure; see the pricing-hellgate
  // "Infinity / NaN … do not silently produce a bogus finite cost" contract).
  // A negative token count, by contrast, yields a positive FINITE cost that
  // would slip past the budget meter's `tick` guard (which no-ops `n < 0`)
  // while the token counters drop it — diverging cost from tokens. Clamping
  // negatives to 0 keeps cost consistent with the token counters for every
  // caller. `x < 0 ? 0 : x` preserves NaN (NaN<0 is false ⇒ NaN) and Infinity.
  const inTok = inputTokens < 0 ? 0 : inputTokens
  const outTok = outputTokens < 0 ? 0 : outputTokens
  const cacheTok = cacheReadTokens < 0 ? 0 : cacheReadTokens

  const outCost = (outTok * price.outPerM) / PER_TOKEN

  let inCost: number
  if (providerOf(model) === "openai") {
    // prompt_tokens already includes cached_tokens → carve out, don't add.
    // Clamp keeps the non-cached portion non-negative for malformed events.
    const cached = Math.min(cacheTok, inTok)
    const fresh = inTok - cached
    inCost = (fresh * price.inPerM + cached * price.cacheReadPerM) / PER_TOKEN
  } else {
    // anthropic: input_tokens excludes cache reads → additive, discounted rate.
    inCost = (inTok * price.inPerM + cacheTok * price.cacheReadPerM) / PER_TOKEN
  }
  return inCost + outCost
}
