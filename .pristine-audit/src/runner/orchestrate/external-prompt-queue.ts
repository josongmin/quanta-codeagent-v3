/**
 * Out-of-band prompt ingress — a generic, surface-agnostic async FIFO.
 *
 * ADR-0303 thin-surface relocation: this mechanism (single-consumer /
 * multi-producer queue with abort-aware waiters) was previously owned by the
 * CLI surface (`apps/cli/repl/external-prompt-queue.ts`), but it is pure
 * reusable runtime semantics with ZERO terminal coupling — any interactive
 * surface (CLI stdin, Web/Tauri IPC) that needs a second ingress path for
 * reactor/scheduler/queue-`sendNow` wakes re-implements the exact same waiter
 * race logic otherwise. It now lives below `src/apps/**`, parameterized over the
 * prompt element type `T`; the CLI keeps only a one-line alias
 * (`ExternalPromptQueue<CliPromptInput>`).
 *
 * Why a second ingress exists: an interactive surface's input reader blocks
 * while the user is idle. A reactor/scheduler wake must resolve the prompt loop
 * WITHOUT synthetic input writes. This queue is that seam:
 *
 *   - `push()` publishes one prompt from an out-of-band source.
 *   - `next(signal)` awaits the next published prompt or resolves `null` when
 *     the caller aborts the wait.
 *
 * Single consumer by construction (the loop calls `next` serially). Multiple
 * producers are fine; prompts stay FIFO.
 */
type QueueWaiter<T> = {
  /** Settle this waiter EXACTLY ONCE. Both `push()` (resolve with a prompt)
   *  and the abort listener (resolve with `null`) call this; whichever wins
   *  the race settles, the loser is a no-op. Also removes the waiter from the
   *  pending list and detaches the abort listener so neither can fire twice. */
  settle: (value: T | null) => void
}

export class ExternalPromptQueue<T> {
  #items: T[] = []
  #waiters: QueueWaiter<T>[] = []

  push(prompt: T): void {
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

  next(signal?: AbortSignal): Promise<T | null> {
    const queued = this.#items.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (signal?.aborted === true) return Promise.resolve(null)
    return new Promise<T | null>((resolve) => {
      let settled = false
      const onAbort = (): void => waiter.settle(null)
      const waiter: QueueWaiter<T> = {
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
