import type { CliPromptInput } from "./prompt-types"

type QueueWaiter = {
  /** Settle this waiter EXACTLY ONCE. Both `push()` (resolve with a prompt)
   *  and the abort listener (resolve with `null`) call this; whichever wins
   *  the race settles, the loser is a no-op. Also removes the waiter from the
   *  pending list and detaches the abort listener so neither can fire twice
   *  (L5 M-14). */
  settle: (value: CliPromptInput | null) => void
}

/**
 * External prompt ingress for the interactive CLI surface.
 *
 * The local raw-line reader blocks inside `readLine()` while the user is idle.
 * A reactor/scheduler wake needs a second ingress path that can resolve the
 * prompt loop without synthetic stdin writes. This queue is that seam:
 *
 *   - `push()` publishes one prompt from an out-of-band source.
 *   - `next(signal)` awaits the next published prompt or resolves `null` when
 *     the caller aborts the wait.
 *
 * Single consumer by construction (`runInteractive` calls `PromptSource.next`
 * serially). Multiple producers are fine; prompts stay FIFO.
 */
export class ExternalPromptQueue {
  #items: CliPromptInput[] = []
  #waiters: QueueWaiter[] = []

  push(prompt: CliPromptInput): void {
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) {
      // `settle` is idempotent and self-removes the listener — no separate
      // abort()/resolve() two-step that could interleave with an abort event.
      waiter.settle(prompt)
      return
    }
    this.#items.push(prompt)
  }

  size(): number {
    return this.#items.length
  }

  next(signal?: AbortSignal): Promise<CliPromptInput | null> {
    const queued = this.#items.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (signal?.aborted === true) return Promise.resolve(null)
    return new Promise<CliPromptInput | null>((resolve) => {
      let settled = false
      const onAbort = (): void => waiter.settle(null)
      const waiter: QueueWaiter = {
        settle: (value) => {
          if (settled) return
          settled = true
          // Detach BEFORE removing from the list so a concurrent abort event
          // cannot re-enter, and drop this waiter from the pending set so a
          // later `push()` never hands a prompt to an already-settled waiter.
          signal?.removeEventListener("abort", onAbort)
          this.#waiters = this.#waiters.filter((entry) => entry !== waiter)
          resolve(value)
        },
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.#waiters.push(waiter)
    })
  }
}
