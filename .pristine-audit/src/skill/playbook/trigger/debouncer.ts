/**
 * Pure per-key debouncer (ADR-0250).
 *
 * Coalesces rapid-fire `schedule(key, action)` calls — the LAST scheduled
 * action wins. After `ms` quiet time on `key`, the pending action fires.
 *
 * This sub-slice's watcher uses one debouncer instance per `watch()`
 * call; the key is the absolute file path. The hellgate pins:
 *
 *   - HELL-IT-07  two schedules for same key within window ⇒ 1 fire.
 *   - HELL-IT-15  cancelAll() clears all pending timers (no leak).
 *
 * Pure-ish: uses `setTimeout`/`clearTimeout` via the global timer
 * primitives but does NOT touch `Date.now()` or any other ambient
 * state — the test rig can inject a fake clock by stubbing
 * `setTimeout` if needed, but the hellgate exercises the real timer.
 *
 * The 0-ms case is treated as "fire immediately on next tick" rather
 * than synchronously — that's the standard `setTimeout(_, 0)` semantic
 * and keeps the contract callsite-agnostic (the caller never needs to
 * special-case the "skip debounce" path).
 */

/** A pending debounced action. */
interface Pending {
  readonly handle: ReturnType<typeof setTimeout>
  readonly action: () => void
}

export interface Debouncer {
  /**
   * Schedule `action` for `key`. If a prior action is pending on `key`,
   * it is dropped (NOT executed) and replaced. The new action fires
   * after `ms` quiet time.
   */
  readonly schedule: (key: string, action: () => void) => void
  /**
   * Cancel all pending actions and clear their underlying timers.
   * Safe to call repeatedly. Required for resource hygiene on
   * `Subscription.unsubscribe`.
   */
  readonly cancelAll: () => void
  /** Number of pending actions (for test introspection / leak checks). */
  readonly pendingCount: () => number
}

export const createDebouncer = (ms: number): Debouncer => {
  const pending = new Map<string, Pending>()
  return {
    schedule: (key, action) => {
      const prior = pending.get(key)
      if (prior !== undefined) clearTimeout(prior.handle)
      const handle = setTimeout(
        () => {
          pending.delete(key)
          action()
        },
        Math.max(0, ms),
      )
      pending.set(key, { handle, action })
    },
    cancelAll: () => {
      for (const p of pending.values()) clearTimeout(p.handle)
      pending.clear()
    },
    pendingCount: () => pending.size,
  }
}
