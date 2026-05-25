/**
 * ADR-0263 — closed {@link EmbedCache} port.
 *
 * Every concrete adapter (in-memory LRU, sqlite, none) implements EXACTLY
 * this surface. Adding a method here is the OCP signal — every implementor
 * gets a compile-time exhaustive-check fail when they fall behind.
 *
 * Semantics:
 *   - {@link get} returns `null` on miss (NEVER `undefined`, NEVER throws).
 *   - {@link put} is idempotent — `put(text, tag, v)` then `get(text, tag)`
 *     returns a vector deep-equal to `v` (no aliasing, no quantisation).
 *   - {@link invalidate} drops ONLY entries tagged with `modelTag` and
 *     returns the number removed. A provider swap calls this with the
 *     OLD modelTag to evict every stale entry.
 *   - {@link size} returns the current entry count (post-eviction).
 *   - {@link clear} resets to empty.
 *
 * Adapters MAY add private state (LRU map, sqlite handle) but MUST NOT
 * widen the surface or change return semantics.
 */
import type { EmbedCacheHit } from "./types"

export interface EmbedCache {
  get(text: string, modelTag: string): EmbedCacheHit | null
  put(text: string, modelTag: string, vector: readonly number[]): void
  invalidate(modelTag: string): number
  size(): number
  clear(): void
}
