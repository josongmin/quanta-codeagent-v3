/**
 * ADR-0177 loop adapter.
 *
 * Keeps the cancellation primitive independent of the loop while giving the
 * actual sampling path one opt-in consumer. The absent-slot path deliberately
 * returns `undefined`; callers then retain the original source and signal
 * references (not merely equivalent wrappers).
 */
import type { StreamEvent } from "@/llm"
import {
  type CancellationController,
  cancellableStream,
  toAbortSignal,
} from "../streaming-cancellation"

export interface StreamCancellationWire {
  /** Combined session + typed cancellation signal for the provider and
   * streaming dispatcher. */
  readonly signal: AbortSignal
  /** Wrap the provider stream so a typed cancel salvages its partial result and
   * settles registered cleanup before the loop moves on. */
  wrap(source: AsyncIterable<StreamEvent>): AsyncIterable<StreamEvent>
  /** Release the session-signal relay if stream construction fails before the
   * returned iterable begins consumption. */
  dispose(): void
}

const combineSignals = (session: AbortSignal, typed: AbortSignal): AbortSignal =>
  AbortSignal.any([session, typed])

/**
 * Build the optional live bridge. A session abort is not silently discarded:
 * it is represented as the controller's deliberately conservative `external`
 * cause, allowing the same cleanup/salvage contract as a typed caller abort.
 */
export const createStreamCancellationWire = (args: {
  readonly sessionSignal: AbortSignal
  readonly controller: CancellationController | undefined
}): StreamCancellationWire | undefined => {
  const { sessionSignal, controller } = args
  if (controller === undefined) return undefined

  const onSessionAbort = (): void => controller.cancel("external")
  if (sessionSignal.aborted) onSessionAbort()
  else sessionSignal.addEventListener("abort", onSessionAbort, { once: true })

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    sessionSignal.removeEventListener("abort", onSessionAbort)
  }

  return {
    signal: combineSignals(sessionSignal, toAbortSignal(controller.signal)),
    wrap(source): AsyncIterable<StreamEvent> {
      const wrapped = cancellableStream({ source, controller })
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent, void, void> {
          try {
            yield* wrapped
          } finally {
            // `outcome()` is null on a normal completion, but awaits all
            // cleanup handlers on cancel. Do not let a cancelled LLM stream
            // leave a resource teardown racing the next turn.
            await wrapped.outcome()
            dispose()
          }
        },
      }
    },
    dispose,
  }
}
