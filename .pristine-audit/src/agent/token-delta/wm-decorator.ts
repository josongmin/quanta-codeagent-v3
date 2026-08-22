/**
 * Delta-token WorkingMemory decorator (RFC jun-6-delta-token-accounting — host
 * wiring). Wraps a `WorkingMemory<Message>` so that the running delta-token
 * estimate is maintained at the SINGLE mutation chokepoint (the wm itself),
 * exposing it via the optional {@link DeltaTokenWorkingMemory.tokenTotal} method.
 * The loop's compaction-threshold gates can then read `tokenTotal()` in O(1)
 * instead of re-scanning the whole transcript through `estimateTokens`.
 *
 * BYTE-IDENTITY (the load-bearing invariant): the counter tracks the PRE-CEIL
 * char total and `total()` applies the same single `Math.ceil(chars/4)` as
 * `estimateTokens`, so `tokenTotal()` is PROVABLY equal to
 * `estimateTokens(snapshot())` at every step (it is a memoization of a pure
 * function, not a behavior change). The decorator is constructed ONLY when the
 * knob is ON, at the composition root (`session-bootstrap.ts`); when OFF the loop
 * uses the RAW `createWorkingMemory` result — no decorator, no `tokenTotal`
 * method — and every read site falls back to a direct `estimateTokens` call,
 * byte-identical.
 *
 * RESEED CORRECTNESS: the only NON-append events are `replace` (compaction's
 * prefix→summary swap, fork) and `clear` — these re-anchor the counter to the
 * post-event snapshot so it cannot drift. `tokenReseed()` re-anchors after an
 * out-of-band buffer mutation (e.g. a `user_prompt_submit` hook rewriting a
 * message in place via `wm.messages[i] = …`, which does not flow through
 * `append`/`replace`).
 */

import type { Message } from "@/llm"
import type { WorkingMemory } from "@/memory"
import { createTokenDeltaCounter } from "./counter"

/**
 * A `WorkingMemory<Message>` augmented with O(1) delta-token accessors. The
 * accessors are OPTIONAL on the type so OFF-path callers (which receive the raw
 * wm) compile unchanged and `wm.tokenTotal?.()` falls back to `estimateTokens`.
 */
export type DeltaTokenWorkingMemory = WorkingMemory<Message> & {
  /** O(1) running estimate, byte-identical to `estimateTokens(snapshot())`. */
  tokenTotal(): number
  /** Re-anchor the counter to the live snapshot after an out-of-band mutation. */
  tokenReseed(): void
}

/**
 * Wrap `inner` with a delta-counter-maintaining decorator. Forwards EVERY
 * `WorkingMemory` member unchanged (a faithful structural superset) and feeds
 * the counter at the mutation chokepoints. Does NOT modify `inner`.
 */
export const decorateWithDeltaCounter = (
  inner: WorkingMemory<Message>,
): DeltaTokenWorkingMemory => {
  const counter = createTokenDeltaCounter(inner.snapshot())
  return {
    // `messages` is the live backing buffer (callers like the user-prompt-submit
    // hook read/rewrite it in place). Forward the same reference so reads/writes
    // hit the real buffer; out-of-band writes are reconciled via `tokenReseed`.
    get messages(): Message[] {
      return inner.messages
    },
    set messages(next: Message[]) {
      inner.messages = next
      counter.reseed(inner.snapshot())
    },
    append(message: Message): void {
      inner.append(message)
      counter.onAppend([message])
    },
    snapshot(): readonly Message[] {
      return inner.snapshot()
    },
    clear(): void {
      inner.clear()
      counter.reseed([])
    },
    replace(messages: Message[]): void {
      inner.replace(messages)
      counter.reseed(inner.snapshot())
    },
    tokenEstimate(): number {
      return inner.tokenEstimate()
    },
    tokenTotal(): number {
      return counter.total()
    },
    tokenReseed(): void {
      counter.reseed(inner.snapshot())
    },
  }
}
