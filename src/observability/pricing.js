/**
 * Versioned static price table (RFC-0002 §5.3).
 *
 * Pure, no network. Every derived cost event stamps {@link PRICING_VERSION}
 * so prices can be re-derived after table drift. Unknown model ⇒ `null`
 * (not an error) — cost is best-effort evidence, never authoritative.
 */
export const PRICING_VERSION = "pricing.v2";
/**
 * Derive the billing provider from the model name. Kept inside observability so
 * the fix needs no cross-slice change: the model string already reaches every
 * cost callsite (`costUsd(model, …)`). `gpt`/`o1`/`o3`-prefixed → openai,
 * `claude`-prefixed → anthropic. Unknown prefixes default to anthropic, the
 * additive (and historically assumed) semantics — but unknown *models* still
 * return null from `costUsd` regardless, so this only matters for known models.
 */
export const providerOf = (model) => {
    const m = model.toLowerCase();
    if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3"))
        return "openai";
    return "anthropic";
};
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
const TABLE = Object.assign(Object.create(null), {
    "gpt-4o": { inPerM: 2.5, outPerM: 10, cacheReadPerM: 1.25 },
    "gpt-4o-mini": { inPerM: 0.15, outPerM: 0.6, cacheReadPerM: 0.075 },
    "claude-opus-4-7": { inPerM: 15, outPerM: 75, cacheReadPerM: 1.5 },
    "claude-sonnet-4-6": { inPerM: 3, outPerM: 15, cacheReadPerM: 0.3 },
    "claude-haiku-4-5": { inPerM: 1, outPerM: 5, cacheReadPerM: 0.1 },
});
const PER_TOKEN = 1_000_000;
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
export const costUsd = (model, inputTokens, outputTokens, cacheReadTokens = 0) => {
    // `Object.hasOwn` guard is redundant with the null-prototype TABLE above but
    // kept so the unknown-model contract survives even if TABLE is later changed
    // back to a plain object literal.
    if (!Object.hasOwn(TABLE, model))
        return null;
    const price = TABLE[model];
    if (price === undefined)
        return null;
    const outCost = (outputTokens * price.outPerM) / PER_TOKEN;
    let inCost;
    if (providerOf(model) === "openai") {
        // prompt_tokens already includes cached_tokens → carve out, don't add.
        // Clamp keeps the non-cached portion non-negative for malformed events.
        const cached = Math.min(cacheReadTokens, inputTokens);
        const fresh = inputTokens - cached;
        inCost = (fresh * price.inPerM + cached * price.cacheReadPerM) / PER_TOKEN;
    }
    else {
        // anthropic: input_tokens excludes cache reads → additive, discounted rate.
        inCost = (inputTokens * price.inPerM + cacheReadTokens * price.cacheReadPerM) / PER_TOKEN;
    }
    return inCost + outCost;
};
