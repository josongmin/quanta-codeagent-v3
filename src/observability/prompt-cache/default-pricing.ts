/**
 * Default prompt-cache pricing table (ADR-0182).
 *
 * Mirrors the cache-bearing entries from ADR-0138 (`DEFAULT_MODEL_PRICING`)
 * but kept INDEPENDENTLY so the observer slice does NOT couple to
 * `@/agent/budget-ledger` at the module-graph layer (plane-clean discipline:
 * `src/observability/prompt-cache/**` must not reach into `@/agent`). The
 * budget-bridge primitive composes the two slices at the surface layer; the
 * observer itself only needs cache-specific pricing.
 *
 * Pricing source: Anthropic public model pricing (`anthropic.com/pricing`)
 * snapshot 2026-05, plus OpenAI's GPT-5.6 Terra model page captured
 * 2026-08-26. Per-million-token rates in USD:
 *
 *   model              | input  | output | cache_create | cache_read
 *   -------------------|--------|--------|--------------|-----------
 *   claude-opus-4-7    | $15.00 | $75.00 | $18.75 (1.25×) | $1.50 (0.10×)
 *   claude-sonnet-4-6  |  $3.00 | $15.00 |  $3.75 (1.25×) | $0.30 (0.10×)
 *   claude-haiku-4-5   |  $1.00 |  $5.00 |  $1.25 (1.25×) | $0.10 (0.10×)
 *   gpt-5.6-terra      |  $2.00 | $12.00 |  $2.50 (1.25×) | $0.20 (0.10×)
 *
 * The cache_create × 1.25 and cache_read × 0.10 multipliers are Anthropic's
 * documented constants — every Claude model in this table follows them. A
 * vendor update that breaks the ratio MUST be reflected here AND in
 * `@/agent/budget-ledger`'s pricing table; a drift-detection test belongs in
 * `tests/integration/` (consumer-side; both slices visible there).
 *
 * Fallback policy: unknown model → `claude-sonnet-4-6` pricing (safe middle
 * ground; matches ADR-0138 clause #4 safe-LOUD posture — a `logger.warn` is
 * emitted on first sighting of an unknown model so the operator notices
 * silent fallback in the breakdown rather than getting $0 savings).
 *
 * `outputPerM` is carried for completeness (the observer does not use it in
 * hit-rate / savings math, but a future tool surface — e.g. a per-model cost
 * breakdown that ALSO shows output cost — may consume it from the same
 * table). Today only `inputPerM`, `cacheCreationPerM`, `cacheReadPerM` are
 * read by `default.ts`.
 */

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

/** Bundled default pricing. Frozen so a downstream caller cannot mutate the
 *  shared table by accident (the observer merges user overrides into a fresh
 *  object — never into this frozen one). */
export const DEFAULT_PROMPT_CACHE_PRICING: Readonly<Record<string, PromptCachePricing>> =
  Object.freeze({
    "claude-opus-4-7": Object.freeze({
      inputPerM: 15,
      outputPerM: 75,
      cacheCreationPerM: 18.75,
      cacheReadPerM: 1.5,
    }),
    "claude-sonnet-4-6": Object.freeze({
      inputPerM: 3,
      outputPerM: 15,
      cacheCreationPerM: 3.75,
      cacheReadPerM: 0.3,
    }),
    "claude-haiku-4-5": Object.freeze({
      inputPerM: 1,
      outputPerM: 5,
      cacheCreationPerM: 1.25,
      cacheReadPerM: 0.1,
    }),
    "gpt-5.6-terra": Object.freeze({
      inputPerM: 2,
      outputPerM: 12,
      cacheCreationPerM: 2.5,
      cacheReadPerM: 0.2,
    }),
  })

/** Last-resort pricing if the fallback key itself is somehow absent (e.g. an
 *  operator passed `{}` to override the entire table). Zero rates make every
 *  computed savings = 0 — defensively safe rather than NaN. */
export const SAFE_ZERO_PRICING: PromptCachePricing = Object.freeze({
  inputPerM: 0,
  outputPerM: 0,
  cacheCreationPerM: 0,
  cacheReadPerM: 0,
})
