/**
 * Pure single-flight dedupe helper (ADR-0264) — no I/O, no timers.
 *
 * Semantics: at most one in-flight `Promise<T>` per `key`. New `run(k)`
 * calls during the flight subscribe to the same promise. The map slot
 * is **deleted on settle** (success or fail) so the next call starts a
 * fresh flight — no stale-value retention, no cross-flight cache.
 */

export interface SingleFlight<T> {
  /** Run `factory` if no flight for `key` is in progress; otherwise
   *  subscribe to the in-flight promise. */
  run(key: string, factory: () => Promise<T>): Promise<T>
  /** Current in-flight key count — observability / hellgate. */
  size(): number
}

export const createSingleFlight = <T>(): SingleFlight<T> => {
  const inFlight = new Map<string, Promise<T>>()

  const run = (key: string, factory: () => Promise<T>): Promise<T> => {
    const existing = inFlight.get(key)
    if (existing !== undefined) return existing
    const p = (async () => {
      try {
        return await factory()
      } finally {
        // Always clear, even on throw — next call starts a fresh flight.
        inFlight.delete(key)
      }
    })()
    inFlight.set(key, p)
    return p
  }

  return {
    run,
    size: () => inFlight.size,
  }
}
