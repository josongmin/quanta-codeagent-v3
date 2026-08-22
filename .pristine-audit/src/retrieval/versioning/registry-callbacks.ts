/**
 * Process-local invalidation callback registry — ADR-0266.
 *
 * Consumers (e.g. an LRU cache, a persisted index) register a callback
 * that the invalidator calls when a `ModelTag` mismatch is detected.
 * Registration is **opt-in** — if nothing is registered, the invalidator
 * fans out to zero callbacks and the slice is byte-identical to the
 * pre-ADR baseline (HELL-MT-14).
 *
 * The registry deliberately uses a small list (not a Map / Set) because:
 *   - the count is small (units, not hundreds)
 *   - registration order is preserved (callbacks run top-down so the
 *     OPS warn output stays deterministic)
 *   - de-registration is rare (test cleanup + occasional reload)
 *
 * `clearInvalidationCallbacks()` is exported for test cleanup; it MUST
 * NOT be called from production code (would defeat the whole point).
 */

import type { InvalidationCallback } from "./port"

let registry: InvalidationCallback[] = []

/**
 * Register a named invalidation callback. Returns an `unregister`
 * function the caller can use to remove its specific callback (the
 * same callback object identity is required).
 *
 * Re-registering the same callback (by identity) is a no-op — the
 * registry uses identity-based dedupe so callers don't accidentally
 * get invalidated twice.
 */
export const registerInvalidationCallback = (cb: InvalidationCallback): (() => void) => {
  if (!registry.includes(cb)) registry.push(cb)
  return () => {
    registry = registry.filter((x) => x !== cb)
  }
}

/**
 * Read the currently registered callbacks. Returns a frozen snapshot
 * (registry mutations during iteration are not observed by an
 * in-flight `invalidateAll`).
 */
export const listInvalidationCallbacks = (): ReadonlyArray<InvalidationCallback> => [...registry]

/**
 * Test-only — reset the registry. Production code MUST NOT call this.
 */
export const clearInvalidationCallbacks = (): void => {
  registry = []
}
