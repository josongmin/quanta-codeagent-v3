/**
 * Provider → canonical usage normalization (MR-01).
 *
 * This is the ONLY place that knows a provider's cache-token convention. Once
 * a `RawUsage` passes through here the buckets are disjoint and every consumer
 * can treat them as plain addends.
 */
import type { NormalizedUsage, Provider, RawUsage } from "./types"

/**
 * Infer the billing provider from the model name.
 *
 * A FALLBACK, not a source of truth: pass `RawUsage.provider` whenever the
 * caller knows which adapter produced the numbers. Prefix inference is wrong
 * for any id that does not follow the vendor's usual naming (a proxy alias, a
 * fine-tune, a bench lane label), and the consequence of guessing wrong is a
 * silently mispriced call rather than an error.
 *
 * Unknown prefixes resolve to `anthropic` — the additive convention — because
 * that is the historical default this codebase's cost math assumed, so an
 * unrecognized name keeps behaving exactly as it did before.
 */
export const providerOf = (model: string): Provider => {
  const m = model.toLowerCase()
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3")) return "openai"
  return "anthropic"
}

/**
 * Clamp NEGATIVE token counts to 0; deliberately let NaN / Infinity through.
 *
 * The asymmetry is load-bearing and predates this module. A negative count
 * yields a positive FINITE cost that slips past the budget meter's `tick`
 * guard (which no-ops `n < 0`) while the token counters drop it, so cost and
 * tokens silently diverge — clamping keeps them consistent. A non-finite count
 * is a BROKEN usage report, and the existing pricing contract requires it to
 * stay visibly non-finite rather than be quietly rewritten to 0, so a
 * downstream check can detect it instead of trusting a wrong dollar figure.
 * `n < 0 ? 0 : n` preserves NaN (NaN < 0 is false) and Infinity by design.
 *
 * The admission check for non-finite usage belongs to the accounting authority,
 * which rejects such a record outright — an explicit rejection, never a silent
 * zero that would understate a bill.
 */
const clamp = (n: number | undefined): number => (n === undefined ? 0 : n < 0 ? 0 : n)

/**
 * Convert provider-shaped usage into disjoint buckets.
 *
 * - **anthropic**: `input_tokens` already EXCLUDES cache reads, so the reported
 *   input IS the fresh input and cache reads sit alongside it.
 * - **openai**: `prompt_tokens` INCLUDES `cached_tokens`, so the cached portion
 *   is carved OUT of the reported input and re-priced at the cache rate.
 *   Adding it on top instead double-bills every cached token.
 *
 * The OpenAI carve-out clamps `cacheRead` to the reported input, so a malformed
 * event claiming more cached tokens than prompt tokens yields `fresh = 0`
 * rather than a negative bucket.
 */
export const normalizeUsage = (raw: RawUsage): NormalizedUsage => {
  const provider = raw.provider ?? providerOf(raw.model)
  const input = clamp(raw.inputTokens)
  const reportedCacheRead = clamp(raw.cacheReadTokens)

  const cacheReadTokens =
    provider === "openai" ? Math.min(reportedCacheRead, input) : reportedCacheRead
  const freshInputTokens = provider === "openai" ? input - cacheReadTokens : input

  return {
    model: raw.model,
    provider,
    freshInputTokens,
    cacheReadTokens,
    cacheWriteTokens: clamp(raw.cacheWriteTokens),
    outputTokens: clamp(raw.outputTokens),
    ...(raw.reasoningTokens !== undefined ? { reasoningTokens: clamp(raw.reasoningTokens) } : {}),
  }
}

/** Total prompt tokens a call actually consumed, cached and fresh alike. Safe
 *  to sum precisely because the buckets are disjoint. */
export const promptTokensOf = (u: NormalizedUsage): number =>
  u.freshInputTokens + u.cacheReadTokens + u.cacheWriteTokens
