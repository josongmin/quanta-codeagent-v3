import { assembleFromEvents, type Message, type StreamEvent } from "@/llm"

/**
 * Streaming tool-execution engine (SOTA++ latency centerpiece).
 *
 * Replaces the loop's sequential "consume the whole model stream, THEN dispatch
 * the turn's tool calls" with an INTERLEAVED schedule: the instant a `tool_use`
 * block has finished streaming we may begin its dispatch (in flight, not
 * awaited) so it overlaps the remaining model output. This is a pure perf
 * optimization — the observable result (`message`, `stopReason`,
 * `resultBlocks`) is byte-identical to the current path; only the wall-clock
 * timing changes.
 *
 * It is written as a pure function with injected collaborators (no `loop.ts` /
 * `dispatch.ts` import, no registry import) so it is loop-agnostic and fully
 * unit-testable with mock async generators.
 *
 * Ordering / barrier algorithm (mirrors CC `StreamingToolExecutor`):
 *
 *  1. Stream events; mirror text deltas via `onTextDelta`; accumulate the raw
 *     event list and hand it verbatim to {@link assembleFromEvents} (reused, so
 *     the assembled `message`/`stopReason` are exactly the current shape).
 *  2. When a `tool_use_end` is seen, resolve its `{id,name,input}` against the
 *     just-assembled block; if it is concurrency-safe AND no
 *     concurrency-unsafe call has appeared yet this turn, start its
 *     `dispatch()` immediately (kept in flight, NOT awaited) so it overlaps the
 *     rest of the stream.
 *  3. The first non-concurrency-safe `tool_use` is a HEAD-OF-LINE barrier: it
 *     and every call after it (safe or not) are deferred — never started while
 *     the stream is open, and never overlapped with side-effecting work.
 *  4. On `stream_reset` (FallbackLLM tombstone) all in-flight dispatches are
 *     abandoned and accumulation is reset, so only the post-reset turn is
 *     produced (the dead partial — and any speculative work it triggered — is
 *     discarded).
 *  5. After stream end: await every in-flight dispatch, then run the deferred
 *     (barrier + post-barrier) calls strictly serially in model-call order;
 *     `resultBlocks` is finally emitted in the ORIGINAL model call order — the
 *     exact ordering invariant the current `dispatchTurnTools` guarantees.
 *
 * Degradation: with zero tool calls, or when every call is
 * concurrency-unsafe, nothing is ever started early — behaviour reduces to
 * "consume whole stream, then dispatch serially in order", i.e. byte-identical
 * to the pre-existing path.
 */

type AssembledMessage = ReturnType<typeof assembleFromEvents>["message"]
type ResultBlocks = AssembledMessage["content"]

/** A single tool call resolved off the assembled stream. */
export interface StreamingCall {
  id: string
  name: string
  input: unknown
}

/** The injected single-tool pipeline (== the loop binding `dispatchTool`). */
export type StreamingDispatch = (call: StreamingCall) => Promise<DispatchOutcome>

export interface DispatchOutcome {
  block: ResultBlocks[number]
  ok: boolean
  preview: string
}

export interface StreamingTurnArgs {
  /** The (already retry/fallback-wrapped) model stream. */
  events: AsyncIterable<StreamEvent>
  /** == `registry.isConcurrencySafe`, bound by the loop. */
  isConcurrencySafe: (name: string, input: unknown) => boolean
  /** == `dispatchTool` bound by the loop (gates + execute + hooks). */
  dispatch: StreamingDispatch
  /** Mirror of text deltas (the loop emits `assistant_text`). */
  onTextDelta?: (delta: string) => void
  /** Fired once per call the instant it is scheduled (in model-call order for
   *  early-started safe calls; at drain time for deferred calls). */
  onToolStart?: (call: StreamingCall) => void
  /** Cooperative cancellation: an abort between/within phases ⇒ `aborted`. */
  signal?: AbortSignal
}

export type StreamingTurnResult =
  | {
      kind: "assembled"
      message: AssembledMessage
      stopReason: string
      resultBlocks: ResultBlocks
    }
  | { kind: "aborted" }

/** One scheduled call slot. `order` is the model-call index and is the SOLE
 *  key the final `resultBlocks` is sorted by, so the ordering invariant holds
 *  regardless of completion timing. */
interface Slot {
  order: number
  call: StreamingCall
  /** Set once the slot's dispatch has been started (early or at drain). */
  promise?: Promise<DispatchOutcome>
}

const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted ?? false

/**
 * Drive one logical model turn with interleaved tool execution. See the file
 * header for the full ordering/barrier contract.
 */
export const streamingTurn = async (args: StreamingTurnArgs): Promise<StreamingTurnResult> => {
  const { events, isConcurrencySafe, dispatch, onTextDelta, onToolStart, signal } = args

  // Raw event log handed verbatim to `assembleFromEvents` — the message shape
  // is therefore identical to the non-streaming path. `stream_reset` truncates
  // it (the tombstone) so only the post-reset turn is assembled.
  let rawEvents: StreamEvent[] = []

  // Scheduled slots in model-call order. Index === model call order.
  const slots: Slot[] = []
  // True once a concurrency-unsafe call has been seen this turn: it is a
  // head-of-line barrier, so nothing AFTER it may start early either.
  let barrierEngaged = false

  /** Abandon every in-flight dispatch + reset accumulation (stream_reset). The
   *  promises are intentionally left unawaited (fire-and-forget tombstone):
   *  their results are discarded because their slots are dropped. */
  const resetForTombstone = (): void => {
    rawEvents = []
    slots.length = 0
    barrierEngaged = false
  }

  for await (const ev of events) {
    if (isAborted(signal)) return { kind: "aborted" }

    if (ev.type === "stream_reset") {
      // Tombstone: discard the dead partial AND any speculative work it
      // started, then re-accumulate from the replacement stream only.
      resetForTombstone()
      rawEvents.push(ev)
      continue
    }

    rawEvents.push(ev)

    if (ev.type === "text_delta") {
      onTextDelta?.(ev.delta)
      continue
    }

    if (ev.type === "tool_use_end") {
      // Resolve {id,name,input} off the partially-assembled message so the
      // call object is exactly what the loop would have dispatched.
      const partial = assembleFromEvents(rawEvents).message
      const block = partial.content.find((b) => b.type === "tool_use" && b.id === ev.id)
      if (!block || block.type !== "tool_use") continue

      const call: StreamingCall = { id: block.id, name: block.name, input: block.input }
      const order = slots.length
      const slot: Slot = { order, call }
      slots.push(slot)

      const safe = isConcurrencySafe(call.name, call.input)
      if (!safe) {
        // First unsafe call ⇒ engage the head-of-line barrier. It (and every
        // later call) is deferred to the post-stream serial phase.
        barrierEngaged = true
        continue
      }
      if (barrierEngaged) {
        // Safe, but it sits behind an already-engaged barrier: must NOT start
        // (would overlap the pending side-effecting call). Defer it.
        continue
      }

      // Concurrency-safe AND no barrier yet ⇒ start it now, in flight, so it
      // overlaps the remaining stream. NOT awaited here.
      onToolStart?.(call)
      slot.promise = dispatch(call)
    }
  }

  if (isAborted(signal)) return { kind: "aborted" }

  const { message, stopReason } = assembleFromEvents(rawEvents)

  // Phase 2: settle every early-started (in-flight) dispatch. These were the
  // concurrency-safe overlap calls; awaiting them now is the join point.
  await Promise.all(slots.filter((s) => s.promise).map((s) => s.promise as Promise<unknown>))

  if (isAborted(signal)) return { kind: "aborted" }

  // Phase 3: run the deferred slots (the barrier call + everything after it,
  // plus any safe calls that were stuck behind the barrier) STRICTLY SERIALLY
  // in model-call order — never overlapping side-effecting work.
  for (const slot of slots) {
    if (slot.promise) continue
    if (isAborted(signal)) return { kind: "aborted" }
    onToolStart?.(slot.call)
    slot.promise = dispatch(slot.call)
    await slot.promise
  }

  if (isAborted(signal)) return { kind: "aborted" }

  // Phase 4: collect results STRICTLY in original model call order. `slots` is
  // already model-call ordered; awaiting settled promises is just unwrapping.
  const resultBlocks: ResultBlocks = []
  for (const slot of slots) {
    const outcome = await (slot.promise as Promise<DispatchOutcome>)
    resultBlocks.push(outcome.block)
  }

  return { kind: "assembled", message: message as Message, stopReason, resultBlocks }
}
