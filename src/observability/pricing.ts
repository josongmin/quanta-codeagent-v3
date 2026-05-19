/**
 * Versioned static price table (RFC-0002 §5.3).
 *
 * Pure, no network. Every derived cost event stamps {@link PRICING_VERSION}
 * so prices can be re-derived after table drift. Unknown model ⇒ `null`
 * (not an error) — cost is best-effort evidence, never authoritative.
 */
export const PRICING_VERSION = "pricing.v1" as const

/** USD per 1,000,000 tokens. */
interface ModelPrice {
  /** Input (prompt) tokens, $/1M. */
  inPerM: number
  /** Output (completion) tokens, $/1M. */
  outPerM: number
}

/**
 * Public list prices, $/1M tokens. Sources (captured 2026-05-19):
 * - OpenAI pricing page (openai.com/api/pricing):
 *     gpt-4o        $2.50 in / $10.00 out
 *     gpt-4o-mini   $0.15 in / $0.60  out
 * - Anthropic pricing page (anthropic.com/pricing):
 *     claude-opus-4-7    $15 in / $75 out
 *     claude-sonnet-4-6  $3  in / $15 out
 *     claude-haiku-4-5   $1  in / $5  out
 *
 * cacheReadTokens are billed at the **input rate** in this version (a
 * conservative upper bound; provider cache discounts are modeled in a
 * future pricing.vN once we wire per-provider cache tiers).
 */
const TABLE: Readonly<Record<string, ModelPrice>> = {
  "gpt-4o": { inPerM: 2.5, outPerM: 10 },
  "gpt-4o-mini": { inPerM: 0.15, outPerM: 0.6 },
  "claude-opus-4-7": { inPerM: 15, outPerM: 75 },
  "claude-sonnet-4-6": { inPerM: 3, outPerM: 15 },
  "claude-haiku-4-5": { inPerM: 1, outPerM: 5 },
}

const PER_TOKEN = 1_000_000

/**
 * USD cost for a known model, or `null` for an unknown model.
 *
 * Zero tokens for a known model returns `0` (not `null`). Pure and
 * deterministic. `cacheReadTokens` (default 0) is billed at the input rate.
 */
export const costUsd = (
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
): number | null => {
  const price = TABLE[model]
  if (price === undefined) return null
  const inCost = ((inputTokens + cacheReadTokens) * price.inPerM) / PER_TOKEN
  const outCost = (outputTokens * price.outPerM) / PER_TOKEN
  return inCost + outCost
}
