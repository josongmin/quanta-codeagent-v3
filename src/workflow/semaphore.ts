/**
 * §25.1 — Async counting semaphore for the workflow concurrency cap. Pure: no
 * clock, no randomness. A released slot is handed DIRECTLY to the next waiter
 * (never bounced through the available-count) so a synchronous `acquire`
 * arriving between a release and a waiter's wake-up can NEVER over-subscribe.
 */
export class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(max: number) {
    // At least one slot — a zero/negative cap would deadlock every acquire.
    this.available = Math.max(1, Math.floor(max))
  }

  /** Acquire a slot, resolving once one is free. Returns a release function
   *  that is idempotent (calling it twice frees only one slot). */
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1
      return this.makeRelease()
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    // Granted by a release that handed its slot straight to us — the slot was
    // never returned to `available`, so we do NOT decrement again here.
    return this.makeRelease()
  }

  private makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next !== undefined) {
        // Hand the slot directly to the next waiter (no available++/-- race).
        next()
      } else {
        this.available += 1
      }
    }
  }
}
