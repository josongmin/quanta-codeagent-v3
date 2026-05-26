import type { CliPromptInput } from "./prompt-types"

type QueueWaiter = {
  readonly resolve: (value: CliPromptInput | null) => void
  readonly abort: () => void
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
      waiter.abort()
      waiter.resolve(prompt)
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
      const onAbort = (): void => {
        this.#waiters = this.#waiters.filter((entry) => entry !== waiter)
        resolve(null)
      }
      const waiter: QueueWaiter = {
        resolve,
        abort: () => signal?.removeEventListener("abort", onAbort),
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.#waiters.push(waiter)
    })
  }
}
