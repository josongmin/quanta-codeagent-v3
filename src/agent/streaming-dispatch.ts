import { assembleFromEvents, type Message, type StreamEvent } from "@/llm"
import { errMessage } from "@/shared"

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
  /** ADR-0078 — redaction hits attached on the tool_result side of the
   *  dispatch seam. Forwarded verbatim to the loop's aggregator. Absent ⇒
   *  no hits (default-OFF or no matches). */
  redactionHits?: ReadonlyArray<import("@/security").RedactionHit>
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
  /** Optional streaming-input seam (absorb #1, ADR-0060). When wired, each
   *  `tool_use_start`/`tool_use_delta`/`tool_use_end` upstream event fires the
   *  corresponding handler so the caller can drive the per-tool
   *  `onInputStart`/`onInputDelta`/`onInputAvailable` callbacks (use
   *  `@/agent/tool-input-streaming#buildToolInputSeam` for the registry-bound
   *  default). Default-OFF: when `undefined`, observable behaviour is
   *  unchanged. Handler errors are swallowed in place so a faulty consumer
   *  cannot poison the surrounding stream-processing invariants. */
  onToolInput?: ToolInputStreamSeam
  /** ADR-0077 TTFT seam — invoked exactly once on the FIRST of
   *  (`text_delta` | `thinking_delta` | `tool_use_start`) observed off the
   *  upstream events. Idempotent on the caller's side is expected (the loop
   *  wires a `TurnTimingCapture.markFirstToken` which is itself idempotent),
   *  but the engine still fires only on the first qualifying event so the
   *  observable seam is byte-identical for callers that wire it OFF and
   *  predictable for callers that wire it ON. Absent ⇒ no-op. */
  onFirstChunk?: () => void
  /** Cooperative cancellation: an abort between/within phases ⇒ `aborted`. */
  signal?: AbortSignal
  /** Injection seam for tests: clock used to stamp `InProgressIndicator.timestamp`
   *  when the upstream event omits `createdAt`. Default `Date.now`. Never
   *  affects routing — the heartbeat is a UI-only signal. */
  now?: () => number
}

/** Three-callback seam mirroring `tool_use_start`/`_delta`/`_end` upstream
 *  events. See `StreamingTurnArgs.onToolInput`. */
export interface ToolInputStreamSeam {
  start(id: string, name: string): void
  delta(id: string, delta: string): void
  available(id: string, input: unknown): void
}

/** Swallow-on-throw helper for the {@link ToolInputStreamSeam} — keeps the
 *  three branches in `handleStreamEvent` to a single line each, and bounds
 *  the surrounding function's cognitive complexity (biome
 *  `noExcessiveCognitiveComplexity` was tripping at 32 before the extract). */
const fireToolInput = (
  seam: ToolInputStreamSeam | undefined,
  kind: "start" | "delta" | "available",
  ev: Extract<StreamEvent, { type: `tool_use_${"start" | "delta" | "end"}` }>,
): void => {
  if (seam === undefined) return
  try {
    if (kind === "start" && ev.type === "tool_use_start") seam.start(ev.id, ev.name)
    else if (kind === "delta" && ev.type === "tool_use_delta") seam.delta(ev.id, ev.delta)
    else if (kind === "available" && ev.type === "tool_use_end") seam.available(ev.id, ev.input)
  } catch {
    // Intentional: a consumer error must not poison the stream-processing
    // invariants (rawEvents accumulation, scheduling order, etc.).
  }
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
  /** ADR-0077: TTFT one-shot latch — true once the first qualifying chunk
   *  has fired `onFirstChunk`. Independent of `stream_reset`: a tombstone
   *  abandons the dead partial, so the FIRST chunk of the REPLACEMENT stream
   *  is what we measure (latch reset on stream_reset). */
  firstChunkSeen: boolean
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
  // ADR-0077: a tombstone abandons the dead partial; the FIRST chunk of the
  // REPLACEMENT stream is the true TTFT signal.
  state.firstChunkSeen = false
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

  // AUDIT-FIX (classification throw surface): `isConcurrencySafe` is the loop's
  // `registry.isConcurrencySafe`, which invokes the tool-DECLARED
  // `isConcurrencySafe(input)` (third-party code). A throw there would escape
  // the un-try/catch'd `for await` in `streamingTurn` and crash the whole turn.
  // Treat a throwing classifier as UNSAFE (serialize) — the safe direction:
  // the call is deferred and runs in the Phase 3 serial drain like any other
  // unsafe call, never overlapping side-effecting work.
  let safe: boolean
  try {
    safe = isConcurrencySafe(call.name, call.input)
  } catch {
    safe = false
  }
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

  // ADR-0077 TTFT: fire `onFirstChunk` exactly once, on the FIRST of
  // (text_delta | thinking_delta | tool_use_start). The latch is reset by
  // `resetForTombstone`, so a post-reset replacement stream re-measures.
  if (
    !state.firstChunkSeen &&
    (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "tool_use_start")
  ) {
    state.firstChunkSeen = true
    args.onFirstChunk?.()
  }

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
        timestamp: ev.createdAt ?? (args.now ?? Date.now)(),
        ...(ev.message !== undefined ? { message: ev.message } : {}),
        ...(ev.progress !== undefined ? { progress: ev.progress } : {}),
      }
      args.onInProgress(indicator)
    }
    return
  }

  // The 3 `tool_use_*` events share an extraction (absorb #1, ADR-0060):
  // fire the optional `onToolInput` seam, and additionally schedule the
  // resolved call on `_end`. Single branch here keeps this dispatcher's
  // cognitive complexity bounded — biome would otherwise flag the per-event
  // branches added by the wire.
  handleToolUseEvent(state, ev, args)
}

/** Route the three `tool_use_*` streaming events: fire the optional input
 *  seam, and additionally schedule the resolved call when `_end` carries
 *  the finalized input. Extracted from {@link handleStreamEvent} to keep
 *  that dispatcher under the biome cognitive-complexity budget. */
const handleToolUseEvent = (state: TurnState, ev: StreamEvent, args: StreamingTurnArgs): void => {
  if (ev.type === "tool_use_start") {
    fireToolInput(args.onToolInput, "start", ev)
    return
  }
  if (ev.type === "tool_use_delta") {
    fireToolInput(args.onToolInput, "delta", ev)
    return
  }
  if (ev.type !== "tool_use_end") return
  fireToolInput(args.onToolInput, "available", ev)
  const call = resolveToolCall(state.rawEvents, ev.id)
  if (call === undefined) return
  scheduleResolvedCall(state, call, args.isConcurrencySafe, args.dispatch, args.onToolStart)
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
    const msg = errMessage(res.reason)
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

  const state: TurnState = {
    rawEvents: [],
    slots: [],
    barrierEngaged: false,
    firstChunkSeen: false,
  }

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

  // ADR-0076 Gap-5 — refusal in-stream short-circuit. When the provider stops
  // with `stop_reason: "refusal"`, ANY tool calls that were queued mid-stream
  // are part of the refused intent and MUST NOT execute. We skip Phase 3
  // (deferred dispatch — barrier-blocked unsafe calls that haven't started
  // yet). Phase 2 already settled the concurrency-safe overlap calls that
  // pre-started — we cannot un-start those (their `dispatch(call)` was fired
  // at `scheduleResolvedCall`) so we collect their results in Phase 4.
  // The loop's `decideOnAssembled` will declare the turn terminal (error)
  // regardless, and `runStep` does NOT `wm.append` on error — so orphan
  // tool_use blocks in `message.content` never carry to the next turn.
  if (stopReason !== "refusal") {
    if (!(await drainDeferredSlots(state.slots, dispatch, onToolStart, signal))) {
      return { kind: "aborted" }
    }
    if (isAborted(signal)) return { kind: "aborted" }
  }

  // Phase 4: collect ONLY slots that actually dispatched. On the normal path
  // every slot has a promise (Phase 1 in-flight OR Phase 3 deferred-dispatched).
  // On the refusal short-circuit, deferred slots have `promise === undefined`
  // and are excluded — their tool calls never ran, so they produce no result
  // block. The orphan tool_use blocks remain in `message.content` but are
  // discarded by the loop along with the message (error return without
  // wm.append).
  const dispatched = state.slots.filter((s) => s.promise !== undefined)
  const resultBlocks = await collectResultBlocks(dispatched)

  return { kind: "assembled", message: message as Message, stopReason, resultBlocks }
}
