/**
 * ADR-0263 — EmbedCache slice public types.
 *
 * Idempotent embed cache keyed by `hash(text) + ":" + modelTag` so a
 * provider/model swap automatically invalidates every stale entry: the
 * canonical `modelTag` is part of the key, never inferred at lookup time.
 *
 * `CacheKey` is the canonical key shape — exported so adapters share the
 * exact same string composition (no per-adapter drift).
 */
import { QuantaError } from "@/shared"

/** Canonical cache key — `"{sha256(text)}:{modelTag}"`. */
export type CacheKey = string

/** A successful cache lookup. The vector is a fresh copy — caller mutation
 *  does not poison the underlying cache. */
export interface EmbedCacheHit {
  readonly vector: readonly number[]
  readonly cachedAt: number
}

/** Slice-local error. Extends `QuantaError` so the existing error taxonomy
 *  (`.code`) keeps working — downstream handlers branch on `code` not class. */
export class CacheError extends QuantaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("embed_cache", message, options)
  }
}
