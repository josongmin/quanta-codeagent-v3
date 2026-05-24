/**
 * ADR-0177 — Cancellation-aware wrap around an `AsyncIterable<StreamEvent>`.
 *
 * Consumes events from an upstream LLM stream and:
 *   1. Salvages whatever was assembled when a cancel fires (text deltas
 *      joined, COMPLETE tool_use blocks promoted, last `usage` event
 *      captured) — so the caller can recover partial work.
 *   2. Exits the iterator cleanly on cancel — mirrors SDK semantics
 *      (`client.messages.stream(...)` iterator simply RETURNS on abort
 *      rather than throwing).
 *
 * Plane-clean: imports `@/llm` for `StreamEvent` (a public type) plus
 * local `./types`. No `@/agent/loop` / dispatch dependencies.
 */
import type { StreamEvent } from "@/llm"

import type {
  CancellationController,
  CancellationOutcome,
  PartialResult,
} from "./types"

export interface CancellableStreamOpts {
  /** Upstream LLM stream — already cancelled-aware at the SDK level via
   *  `toAbortSignal(controller.signal)` passed into `StreamInput.signal`. */
  readonly source: AsyncIterable<StreamEvent>
  /** Owns the cancel decision. The wrap calls `finalize()` once the cancel
   *  is observed so the outcome reflects the salvaged partial. */
  readonly controller: CancellationController
}

/** Returned by {@link cancellableStream}. The underlying iteration surface is
 *  a regular `AsyncIterable<StreamEvent>`; the two extra getters expose the
 *  salvage / outcome state without forcing a closure-based wiring. */
export interface CancellableStream extends AsyncIterable<StreamEvent> {
  /** Snapshot of what has been salvaged so far. Safe to call mid-stream or
   *  post-cancel; structurally pure (no allocation surprises). */
  partial(): PartialResult
  /** Resolves to the outcome ONCE the controller has been cancelled and
   *  `finalize()` has run. Resolves to `null` if the stream completed
   *  without a cancel (clean termination — outcome is meaningless). */
  outcome(): Promise<CancellationOutcome | null>
}

interface AccumulatedToolUse {
  readonly id: string
  readonly name: string
}

export const cancellableStream = (opts: CancellableStreamOpts): CancellableStream => {
  const { source, controller } = opts

  // Salvage state — all mutated only by the iterator loop below. Read by
  // `partial()` snapshot getter.
  let textBuf = ""
  const completedToolUses: Array<{ id: string; name: string; input: unknown }> = []
  const openToolUses = new Map<string, AccumulatedToolUse>()
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens: number | undefined
  let cacheWriteTokens: number | undefined

  let cancelled = false
  let outcomeResolved: CancellationOutcome | null = null
  let outcomePromise: Promise<CancellationOutcome | null> | null = null

  const snapshotPartial = (): PartialResult => {
    const usage: PartialResult["usage"] = { inputTokens, outputTokens }
    if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens
    if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens
    return {
      partialText: textBuf,
      toolUses: completedToolUses.slice(),
      usage,
      hasUsableToolUses: completedToolUses.length > 0,
    }
  }

  const ingest = (ev: StreamEvent): void => {
    switch (ev.type) {
      case "stream_reset": {
        // FallbackLLM tombstone — discard everything assembled so far and
        // restart fresh. Mirrors the consumer contract on `stream_reset`.
        textBuf = ""
        completedToolUses.length = 0
        openToolUses.clear()
        // Usage carries forward intentionally: tokens already burned are
        // still real billable usage even though the partial message is
        // dead. Caller can subtract if it wants reset semantics here too.
        return
      }
      case "text_delta": {
        textBuf += ev.delta
        return
      }
      case "tool_use_start": {
        openToolUses.set(ev.id, { id: ev.id, name: ev.name })
        return
      }
      case "tool_use_delta": {
        // We do NOT accumulate the JSON delta string — `tool_use_end`
        // carries the fully-parsed `input`. Partial JSON is unactionable;
        // see types.ts comment on `PartialResult.toolUses`.
        return
      }
      case "tool_use_end": {
        const open = openToolUses.get(ev.id)
        if (open !== undefined) {
          completedToolUses.push({ id: open.id, name: open.name, input: ev.input })
          openToolUses.delete(ev.id)
        }
        return
      }
      case "usage": {
        inputTokens = ev.inputTokens
        outputTokens = ev.outputTokens
        if (ev.cacheReadTokens !== undefined) cacheReadTokens = ev.cacheReadTokens
        return
      }
      case "thinking_delta":
      case "signature_delta":
      case "response_in_progress":
      case "message_stop": {
        // Not salvage-relevant. Thinking/signature reconstruct downstream;
        // response_in_progress is non-cumulative heartbeat; message_stop is
        // a terminator handled by the iterator boundary itself.
        return
      }
    }
  }

  const finalizeOnce = async (): Promise<CancellationOutcome | null> => {
    if (!cancelled) return null
    if (outcomeResolved !== null) return outcomeResolved
    if (outcomePromise !== null) return outcomePromise
    const partial = snapshotPartial()
    // If literally NOTHING came in (no text, no tools, no usage), the
    // partial has no usable content — pass `null` to make that explicit
    // in the outcome rather than handing handlers a zero-everything record.
    const isEmpty =
      partial.partialText === "" &&
      partial.toolUses.length === 0 &&
      inputTokens === 0 &&
      outputTokens === 0
    const promise = controller.finalize(isEmpty ? null : partial).then((o) => {
      outcomeResolved = o
      return o
    })
    outcomePromise = promise
    return promise
  }

  const iterate = async function* (): AsyncGenerator<StreamEvent, void, void> {
    // Wire a one-shot listener: when the controller fires, we set the
    // local flag so the next iteration of the for-await sees it. Listener
    // fires synchronously, so even a tight loop will observe the abort
    // before it pulls the next event.
    const onAbort = (): void => {
      cancelled = true
    }
    if (controller.signal.aborted) {
      cancelled = true
    } else {
      controller.signal.addEventListener("abort", onAbort)
    }
    try {
      for await (const ev of source) {
        if (cancelled) {
          // Cancel observed mid-stream. Do NOT yield this event — the
          // contract is "iterator exits cleanly on cancel". Salvage has
          // already captured everything we've seen.
          break
        }
        ingest(ev)
        yield ev
        if (cancelled) {
          break
        }
      }
    } finally {
      controller.signal.removeEventListener("abort", onAbort)
      // Fire-and-forget finalize. The outcome() accessor awaits the same
      // promise, so the caller's await reflects the real cleanup status.
      if (cancelled) {
        void finalizeOnce()
      }
    }
  }

  return {
    [Symbol.asyncIterator]: iterate,
    partial: snapshotPartial,
    outcome: () => finalizeOnce(),
  }
}
