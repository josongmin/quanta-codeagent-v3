/**
 * ADR-0326 — System prompt session-level cache.
 *
 * Barrel re-export. Future wire-up (a separate ADR — see
 * `docs/decisions/0326-*.md` §Follow-up) will import from here. The
 * slice is plane-clean: nothing here reaches into `@/agent/prompt`,
 * `@/llm/cache-control-audit`, or any other slice — those are FUTURE
 * callers, never collaborators.
 */

export { makeStrictDriftCache } from "./drift-detector"
export { sha256Hex } from "./hash"
export type { InMemorySystemPromptCacheOptions } from "./in-memory-cache"
export { createInMemorySystemPromptCache } from "./in-memory-cache"
export type { SystemPromptCachePort } from "./port"
export type {
  CachedPrompt,
  CacheStats,
  InvalidationReason,
  SystemPromptCacheKey,
} from "./types"
export {
  asCacheKey,
  DriftDetectedError,
} from "./types"
