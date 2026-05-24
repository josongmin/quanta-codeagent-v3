/**
 * Prompt-cache observability barrel (ADR-0182).
 *
 * Re-exports the typed observer port + default in-memory adapter + budget
 * bridge. Surfaces import from `@/observability/prompt-cache`; the parent
 * `@/observability` barrel intentionally does NOT pull this in (Default-OFF —
 * surfaces opt-in by importing the sub-barrel explicitly, matching the
 * `@/observability/metrics` posture).
 */

export { wirePromptCacheToBudget } from "./budget-bridge"
export { defaultPromptCacheObserver } from "./default"
export {
  DEFAULT_PROMPT_CACHE_PRICING,
  FALLBACK_PRICING_MODEL,
  type PromptCachePricing,
  SAFE_ZERO_PRICING,
} from "./default-pricing"
export {
  type CacheBreakpointAttribution,
  type CacheHitEvent,
  type CacheModelRollup,
  type CachePerformanceSnapshot,
  PromptCacheError,
  type PromptCacheErrorCode,
  type PromptCacheObserver,
  type PromptCacheObserverOpts,
} from "./types"
