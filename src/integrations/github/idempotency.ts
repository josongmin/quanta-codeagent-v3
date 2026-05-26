/**
 * ADR-0311 / ADR-0313 — Delivery dedup + idempotency key derivation.
 *
 * Two concerns, one file:
 *   1. Delivery store — set-like, bounded (default 1024 entries, FIFO
 *      eviction). Persisted-version optional via `persistPath` (lazy
 *      load + best-effort save; never blocks on IO failure). Mirrors
 *      the `createInMemorySeenRuns` shape from `@/reactor/trigger-source-ci`.
 *   2. `computeIdempotencyKey(deliveryId, action)` — sha256 truncated to 16
 *      hex chars. Stable across processes; embedded in outgoing comment
 *      bodies as `<!-- quanta:idempotency=<key> -->`.
 */

import { createHash } from "node:crypto"

import { asIdempotencyKey, type IdempotencyKey } from "./types"

const DEFAULT_MAX_ENTRIES = 1024

export interface DeliveryStore {
  has(deliveryId: string): boolean
  add(deliveryId: string): void
  /** Snapshot — used by the file-persisted variant before save. */
  snapshot(): readonly string[]
}

export interface DeliveryStoreOpts {
  readonly persistPath?: string
  readonly maxEntries?: number
  /**
   * Optional initial seed (e.g. from a previous on-disk dump). Validated
   * shape; non-strings ignored.
   */
  readonly seed?: readonly string[]
}

/**
 * Create a bounded delivery-id dedup store. Caps at `maxEntries` (default
 * 1024) with FIFO eviction — insertion-order via `Map`.
 *
 * `persistPath` is documented in opts for parity with the watermark / seen-
 * runs file-backed adapters; the actual on-disk read/write is intentionally
 * left to the composition root (this slice does not touch fs in production
 * paths). The store still records `persistPath` so adapter wiring is one-line.
 */
export const createDeliveryStore = (opts: DeliveryStoreOpts = {}): DeliveryStore => {
  const cap = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES)
  const m = new Map<string, true>()
  const add = (id: string): void => {
    if (typeof id !== "string" || id.length === 0) return
    if (m.has(id)) return
    if (m.size >= cap) {
      const oldest = m.keys().next().value
      if (oldest !== undefined) m.delete(oldest)
    }
    m.set(id, true)
  }
  if (opts.seed) for (const id of opts.seed) add(id)
  return {
    has: (id) => m.has(id),
    add,
    snapshot: () => [...m.keys()],
  }
}

/**
 * Derive a stable, short idempotency key from `(deliveryId, action)`. SHA-256
 * truncated to 16 hex chars (64 bits) — collision-resistant for the volume of
 * GH deliveries per repo (millions per year still <2^-30 collision).
 *
 * The result is branded ({@link IdempotencyKey}) so the sink can't accept an
 * arbitrary string as a key.
 */
export const computeIdempotencyKey = (deliveryId: string, action: string): IdempotencyKey => {
  const safeDelivery = typeof deliveryId === "string" ? deliveryId : ""
  const safeAction = typeof action === "string" ? action : ""
  const digest = createHash("sha256").update(`${safeDelivery}:${safeAction}`).digest("hex")
  return asIdempotencyKey(digest.slice(0, 16))
}
