import { assembleFromEvents, type Message, type StreamEvent } from "@/llm"

/**
 * Streaming tool-execution engine (streaming latency optimization).
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

/** Mutable accumulation state for one (possibly tombstone-reset) turn. Held in
 *  one object so the per-event handler can reset it in place on `stream_reset`
 *  exactly as the inline version did (reassign `rawEvents`, truncate `slots`). */
interface TurnState {
  /** Raw event log handed verbatim to `assembleFromEvents` — message shape is
   *  therefore identical to the non-streaming path. `stream_reset` truncates it
   *  (the tombstone) so only the post-reset turn is assembled. */
  rawEvents: StreamEvent[]
  /** Scheduled slots in model-call order. Index === model call order. */
  slots: Slot[]
  /** True once a concurrency-unsafe call has been seen this turn: it is a
   *  head-of-line barrier, so nothing AFTER it may start early either. */
  barrierEngaged: boolean
}

/** Abandon every in-flight dispatch + reset accumulation (stream_reset). The
 *  promises are intentionally left unawaited (fire-and-forget tombstone): their
 *  results are discarded because their slots are dropped. */
const resetForTombstone = (state: TurnState): void => {
  state.rawEvents = []
  state.slots.length = 0
  state.barrierEngaged = false
}

/** Resolve a finished `tool_use` block off the partially-assembled message so
 *  the call object is exactly what the loop would have dispatched. */
const resolveToolCall = (rawEvents: StreamEvent[], id: string): StreamingCall | undefined => {
  const partial = assembleFromEvents(rawEvents).message
  const block = partial.content.find((b) => b.type === "tool_use" && b.id === id)
  if (!block || block.type !== "tool_use") return undefined
  return { id: block.id, name: block.name, input: block.input }
}

/** Append a freshly-resolved call as the next model-order slot and, when it is
 *  concurrency-safe and no head-of-line barrier is engaged, start its dispatch
 *  in flight (NOT awaited) so it overlaps the remaining stream. The first
 *  unsafe call engages the barrier; thereafter every call (safe or not) is
 *  deferred to the post-stream serial phase. */
const scheduleResolvedCall = (
  state: TurnState,
  call: StreamingCall,
  isConcurrencySafe: StreamingTurnArgs["isConcurrencySafe"],
  dispatch: StreamingDispatch,
  onToolStart: StreamingTurnArgs["onToolStart"],
): void => {
  const slot: Slot = { order: state.slots.length, call }
  state.slots.push(slot)

  const safe = isConcurrencySafe(call.name, call.input)
  if (!safe) {
    // First unsafe call ⇒ engage the head-of-line barrier. It (and every
    // later call) is deferred to the post-stream serial phase.
    state.barrierEngaged = true
    return
  }
  if (state.barrierEngaged) {
    // Safe, but it sits behind an already-engaged barrier: must NOT start
    // (would overlap the pending side-effecting call). Defer it.
    return
  }

  // Concurrency-safe AND no barrier yet ⇒ start it now, in flight, so it
  // overlaps the remaining stream. NOT awaited here.
  onToolStart?.(call)
  slot.promise = dispatch(call)
}

/** Process one stream event, mutating `state` in place. A tombstone resets
 *  accumulation; a text delta is mirrored out; a finished `tool_use` is
 *  resolved and scheduled. Each branch is the exact body of the original
 *  inline `continue`-guarded blocks, in the same order. */
const handleStreamEvent = (state: TurnState, ev: StreamEvent, args: StreamingTurnArgs): void => {
  if (ev.type === "stream_reset") {
    // Tombstone: discard the dead partial AND any speculative work it
    // started, then re-accumulate from the replacement stream only.
    resetForTombstone(state)
    state.rawEvents.push(ev)
    return
  }

  state.rawEvents.push(ev)

  if (ev.type === "text_delta") {
    args.onTextDelta?.(ev.delta)
    return
  }

  if (ev.type === "tool_use_end") {
    const call = resolveToolCall(state.rawEvents, ev.id)
    if (call === undefined) return
    scheduleResolvedCall(state, call, args.isConcurrencySafe, args.dispatch, args.onToolStart)
  }
}

/** Phase 3: run the deferred slots (the barrier call + everything after it,
 *  plus any safe calls stuck behind the barrier) STRICTLY SERIALLY in
 *  model-call order — never overlapping side-effecting work. Returns false iff
 *  cancelled mid-drain. */
const drainDeferredSlots = async (
  slots: Slot[],
  dispatch: StreamingDispatch,
  onToolStart: StreamingTurnArgs["onToolStart"],
  signal: AbortSignal | undefined,
): Promise<boolean> => {
  for (const slot of slots) {
    if (slot.promise) continue
    if (isAborted(signal)) return false
    onToolStart?.(slot.call)
    slot.promise = dispatch(slot.call)
    await slot.promise
  }
  return true
}

/** Phase 4: collect results STRICTLY in original model call order. `slots` is
 *  already model-call ordered; awaiting settled promises is just unwrapping. */
const collectResultBlocks = async (slots: Slot[]): Promise<ResultBlocks> => {
  const resultBlocks: ResultBlocks = []
  for (const slot of slots) {
    const outcome = await (slot.promise as Promise<DispatchOutcome>)
    resultBlocks.push(outcome.block)
  }
  return resultBlocks
}

/**
 * Drive one logical model turn with interleaved tool execution. See the file
 * header for the full ordering/barrier contract.
 */
export const streamingTurn = async (args: StreamingTurnArgs): Promise<StreamingTurnResult> => {
  const { events, dispatch, onToolStart, signal } = args

  const state: TurnState = { rawEvents: [], slots: [], barrierEngaged: false }

  for await (const ev of events) {
    if (isAborted(signal)) return { kind: "aborted" }
    handleStreamEvent(state, ev, args)
  }

  if (isAborted(signal)) return { kind: "aborted" }

  const { message, stopReason } = assembleFromEvents(state.rawEvents)

  // Phase 2: settle every early-started (in-flight) dispatch. These were the
  // concurrency-safe overlap calls; awaiting them now is the join point.
  await Promise.all(state.slots.filter((s) => s.promise).map((s) => s.promise as Promise<unknown>))

  if (isAborted(signal)) return { kind: "aborted" }

  if (!(await drainDeferredSlots(state.slots, dispatch, onToolStart, signal))) {
    return { kind: "aborted" }
  }

  if (isAborted(signal)) return { kind: "aborted" }

  const resultBlocks = await collectResultBlocks(state.slots)

  return { kind: "assembled", message: message as Message, stopReason, resultBlocks }
}
