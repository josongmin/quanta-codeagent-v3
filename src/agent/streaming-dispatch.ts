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

/** UI-facing "thinking…" heartbeat surfaced from a provider's
 *  `response.in_progress` event (ADR-0048). The seam is additive: when the
 *  caller does NOT register an {@link InProgressHandler}, nothing changes
 *  about stream consumption (the event is just skipped during assembly, the
 *  same as a no-op). When the caller DOES register one, each
 *  `response_in_progress` {@link StreamEvent} fires the handler exactly once
 *  with the carried metadata plus a `timestamp` filled in at observation time
 *  (so the handler sees a stable receive-side clock even when the provider
 *  omits `createdAt`). */
export interface InProgressIndicator {
  kind: "in-progress"
  /** Optional human-readable status the provider attached to the heartbeat. */
  message?: string
  /** Optional ratio in [0..1]. May be absent. */
  progress?: number
  /** Receive-side millisecond timestamp (always populated; defaults to
   *  `Date.now()` at observation if the provider didn't supply one). */
  timestamp: number
}

/** Handler signature for the in-progress seam. The handler is called inline
 *  from the stream consumer; it MUST NOT block or throw (callers should wrap
 *  user code with their own try/catch). */
export type InProgressHandler = (indicator: InProgressIndicator) => void

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
  /** Optional heartbeat seam (ADR-0048). Invoked whenever the upstream stream
   *  yields a `response_in_progress` event so a UI can paint a "thinking…"
   *  indicator without us having to invent one. Behaviour is additive — when
   *  this is `undefined` the engine's observable result is unchanged. */
  onInProgress?: InProgressHandler
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
 *  results are discarded because their slots are dropped. We attach a noop
 *  `.catch` so a late rejection on an abandoned promise does NOT surface as an
 *  `unhandledRejection` warning under Bun/Node (R-Phase2 P1-2). */
const resetForTombstone = (state: TurnState): void => {
  for (const slot of state.slots) {
    if (slot.promise) slot.promise.catch(() => undefined)
  }
  state.rawEvents = []
  state.slots.length = 0
  state.barrierEngaged = false
}

/** Synthesize a structurally-valid `tool_result` block for the very rare case
 *  where an injected `dispatch(call)` rejects instead of resolving with an
 *  error outcome (its documented contract: dispatch wraps every error into an
 *  ok:false tool_result block and NEVER throws). Treating a rejection as a
 *  surfaced error block keeps the ordering invariant whole (Phase 4 always
 *  produces one block per scheduled call) and the loop can `decideOnAssembled`
 *  against it the same way as any other error result. R-Phase1 P0-1. */
const dispatchFailedBlock = (call: StreamingCall, msg: string): ResultBlocks[number] => ({
  type: "tool_result",
  tool_use_id: call.id,
  content:
    `Tool "${call.name}" dispatch threw unexpectedly: ${msg}. ` +
    "This is an internal contract violation (dispatch is supposed to return " +
    "an ok:false block, not throw); surface to the user and continue.",
  is_error: true,
})

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

  if (ev.type === "response_in_progress") {
    // ADR-0048: fire the heartbeat seam if registered. We FILL IN `timestamp`
    // here (receive side) so the handler always sees a stable monotonic-ish
    // clock; if the provider supplied `createdAt` we forward that as the
    // authoritative value instead.
    if (args.onInProgress !== undefined) {
      const indicator: InProgressIndicator = {
        kind: "in-progress",
        timestamp: ev.createdAt ?? Date.now(),
        ...(ev.message !== undefined ? { message: ev.message } : {}),
        ...(ev.progress !== undefined ? { progress: ev.progress } : {}),
      }
      args.onInProgress(indicator)
    }
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
 *  cancelled mid-drain.
 *
 *  R-Phase1 P0-1: a rejection on a single slot's dispatch MUST NOT short-circuit
 *  the loop — that would leave LATER deferred calls un-dispatched (their slots
 *  have no `promise` set), Phase 4 would then `await undefined as Promise`, and
 *  the ordering invariant ("one result block per scheduled call, in model-call
 *  order") would silently break. We swallow rejections HERE; Phase 4 detects
 *  rejected promises via `Promise.allSettled` and emits a synthetic dispatch-
 *  failed block in the slot's position. */
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
    try {
      await slot.promise
    } catch {
      // Defensive: dispatch is contractually no-throw (every error path inside
      // it MUST resolve to an ok:false tool_result block). If a future refactor
      // breaks that, we keep marching so the remaining deferred slots still
      // dispatch and Phase 4 still produces one block per call.
    }
  }
  return true
}

/** Phase 4: collect results STRICTLY in original model call order. `slots` is
 *  already model-call ordered; awaiting settled promises is just unwrapping.
 *
 *  R-Phase1 P0-1: uses `Promise.allSettled` so a rejected slot promise becomes
 *  a synthesized `dispatchFailedBlock` rather than a thrown exception — keeps
 *  the ordering invariant whole even under contract violations in `dispatch`. */
const collectResultBlocks = async (slots: Slot[]): Promise<ResultBlocks> => {
  const settled = await Promise.allSettled(slots.map((s) => s.promise as Promise<DispatchOutcome>))
  const resultBlocks: ResultBlocks = []
  settled.forEach((res, i) => {
    if (res.status === "fulfilled") {
      resultBlocks.push(res.value.block)
      return
    }
    const slot = slots[i]
    if (slot === undefined) return
    const msg = res.reason instanceof Error ? res.reason.message : String(res.reason)
    resultBlocks.push(dispatchFailedBlock(slot.call, msg))
  })
  return resultBlocks
}

/**
 * Drive one logical model turn with interleaved tool execution. See the file
 * header for the full ordering/barrier contract.
 *
 * AbortSignal contract (R-Phase2 P1-4): the `signal` parameter gates BETWEEN
 * phases — `streamingTurn` checks `isAborted(signal)` at every phase boundary
 * but does NOT pass `signal` into the injected `dispatch(call)`. The caller
 * (the agent loop's `dispatch` binding, see `loop.ts streamConsume`) is
 * responsible for threading `config.signal` into `ctx.signal` and individual
 * tools that may run long (`bash` / `test_runner`) listen on it themselves.
 * The implication: an abort that arrives WHILE a tool is executing reaches
 * that tool directly via its `ctx.signal`; one that arrives between phases
 * short-circuits this engine without starting any further dispatches.
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
  //
  // R-Phase1 P0-1: `Promise.allSettled` (was `Promise.all`) — a single rejected
  // early dispatch must NOT short-circuit Phase 3 + Phase 4. The rejection is
  // re-observed by `collectResultBlocks` and surfaced as a `dispatchFailedBlock`
  // so the ordering invariant (one block per scheduled call) is preserved.
  await Promise.allSettled(
    state.slots.filter((s) => s.promise).map((s) => s.promise as Promise<unknown>),
  )

  if (isAborted(signal)) return { kind: "aborted" }

  if (!(await drainDeferredSlots(state.slots, dispatch, onToolStart, signal))) {
    return { kind: "aborted" }
  }

  if (isAborted(signal)) return { kind: "aborted" }

  const resultBlocks = await collectResultBlocks(state.slots)

  return { kind: "assembled", message: message as Message, stopReason, resultBlocks }
}
