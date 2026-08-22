/**
 * `@/retrieval/cache` slice barrel — ADR-0263 EmbedCache.
 *
 * Single import surface for assemblers wiring the cache into the embed
 * pipeline. Concrete adapters live behind the {@link EmbedCache} port so
 * tests and the composition root pick between in-memory / sqlite / none
 * via {@link resolveEmbedCacheFromEnv} without depending on any adapter
 * file directly.
 */
export { hashText, isCanonicalModelTag, makeCacheKey } from "./hash"
export type { InMemoryEmbedCacheOptions } from "./in-memory-lru"
export { newInMemoryEmbedCache } from "./in-memory-lru"
export { newNoneEmbedCache } from "./none-cache"
export type { EmbedCache } from "./port"
export type { EmbedCacheKind } from "./registry"
export { resolveEmbedCacheFromEnv } from "./registry"
export type { SqliteEmbedCacheOptions } from "./sqlite-cache"
export { newSqliteEmbedCache } from "./sqlite-cache"
export type { CacheKey, EmbedCacheHit } from "./types"
export { CacheError } from "./types"
