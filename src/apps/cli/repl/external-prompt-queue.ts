/**
 * `apps/cli/repl/external-prompt-queue.ts` — surface alias.
 *
 * ADR-0303 thin-surface relocation: the generic, abort-aware out-of-band prompt
 * FIFO now lives below `src/apps/**` in `@/runner/orchestrate` (it is reusable
 * runtime semantics with zero terminal coupling — any interactive surface needs
 * the same waiter race logic). The CLI keeps the element binding plus a tiny
 * ingress notification seam; the generic waiter/race logic remains below
 * `src/apps/**`.
 */
import { ExternalPromptQueue as GenericExternalPromptQueue } from "@/runner/orchestrate"
import type { CliPromptInput } from "./prompt-types"

/** Surface-only notification for a newly accepted external prompt. It is
 * synchronous so a goal quiet wake is invalidated before the prompt-source
 * race can begin an overlapping agent body. */
export interface ExternalPromptQueueOpts {
  /** Receives the accepted input so the host can distinguish independent
   * ingress from the goal controller's own continuation. */
  readonly onPush?: (input: CliPromptInput) => void
}

export class ExternalPromptQueue extends GenericExternalPromptQueue<CliPromptInput> {
  readonly #onPush: ((input: CliPromptInput) => void) | undefined

  constructor(opts: ExternalPromptQueueOpts = {}) {
    super()
    this.#onPush = opts.onPush
  }

  override push(prompt: CliPromptInput): void {
    try {
      this.#onPush?.(prompt)
    } catch {
      // Notification is advisory only; it must never drop an external prompt.
    }
    super.push(prompt)
  }
}
