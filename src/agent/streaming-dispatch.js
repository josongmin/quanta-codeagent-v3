import { assembleFromEvents } from "@/llm";
import { errMessage } from "@/shared";
/** Swallow-on-throw helper for the {@link ToolInputStreamSeam} — keeps the
 *  three branches in `handleStreamEvent` to a single line each, and bounds
 *  the surrounding function's cognitive complexity (biome
 *  `noExcessiveCognitiveComplexity` was tripping at 32 before the extract). */
const fireToolInput = (seam, kind, ev) => {
    if (seam === undefined)
        return;
    try {
        if (kind === "start" && ev.type === "tool_use_start")
            seam.start(ev.id, ev.name);
        else if (kind === "delta" && ev.type === "tool_use_delta")
            seam.delta(ev.id, ev.delta);
        else if (kind === "available" && ev.type === "tool_use_end")
            seam.available(ev.id, ev.input);
    }
    catch {
        // Intentional: a consumer error must not poison the stream-processing
        // invariants (rawEvents accumulation, scheduling order, etc.).
    }
};
const isAborted = (signal) => signal?.aborted ?? false;
/** Abandon every in-flight dispatch + reset accumulation (stream_reset). The
 *  promises are intentionally left unawaited (fire-and-forget tombstone): their
 *  results are discarded because their slots are dropped. We attach a noop
 *  `.catch` so a late rejection on an abandoned promise does NOT surface as an
 *  `unhandledRejection` warning under Bun/Node (R-Phase2 P1-2). */
const resetForTombstone = (state) => {
    for (const slot of state.slots) {
        if (slot.promise)
            slot.promise.catch(() => undefined);
    }
    state.rawEvents = [];
    state.slots.length = 0;
    state.barrierEngaged = false;
    // ADR-0077: a tombstone abandons the dead partial; the FIRST chunk of the
    // REPLACEMENT stream is the true TTFT signal.
    state.firstChunkSeen = false;
};
/** Synthesize a structurally-valid `tool_result` block for the very rare case
 *  where an injected `dispatch(call)` rejects instead of resolving with an
 *  error outcome (its documented contract: dispatch wraps every error into an
 *  ok:false tool_result block and NEVER throws). Treating a rejection as a
 *  surfaced error block keeps the ordering invariant whole (Phase 4 always
 *  produces one block per scheduled call) and the loop can `decideOnAssembled`
 *  against it the same way as any other error result. R-Phase1 P0-1. */
const dispatchFailedBlock = (call, msg) => ({
    type: "tool_result",
    tool_use_id: call.id,
    content: `Tool "${call.name}" dispatch threw unexpectedly: ${msg}. ` +
        "This is an internal contract violation (dispatch is supposed to return " +
        "an ok:false block, not throw); surface to the user and continue.",
    is_error: true,
});
/** Resolve a finished `tool_use` block off the partially-assembled message so
 *  the call object is exactly what the loop would have dispatched. */
const resolveToolCall = (rawEvents, id) => {
    const partial = assembleFromEvents(rawEvents).message;
    const block = partial.content.find((b) => b.type === "tool_use" && b.id === id);
    if (!block || block.type !== "tool_use")
        return undefined;
    return { id: block.id, name: block.name, input: block.input };
};
/** Append a freshly-resolved call as the next model-order slot and, when it is
 *  concurrency-safe and no head-of-line barrier is engaged, start its dispatch
 *  in flight (NOT awaited) so it overlaps the remaining stream. The first
 *  unsafe call engages the barrier; thereafter every call (safe or not) is
 *  deferred to the post-stream serial phase. */
const scheduleResolvedCall = (state, call, isConcurrencySafe, dispatch, onToolStart) => {
    const slot = { order: state.slots.length, call };
    state.slots.push(slot);
    // AUDIT-FIX (classification throw surface): `isConcurrencySafe` is the loop's
    // `registry.isConcurrencySafe`, which invokes the tool-DECLARED
    // `isConcurrencySafe(input)` (third-party code). A throw there would escape
    // the un-try/catch'd `for await` in `streamingTurn` and crash the whole turn.
    // Treat a throwing classifier as UNSAFE (serialize) — the safe direction:
    // the call is deferred and runs in the Phase 3 serial drain like any other
    // unsafe call, never overlapping side-effecting work.
    let safe;
    try {
        safe = isConcurrencySafe(call.name, call.input);
    }
    catch {
        safe = false;
    }
    if (!safe) {
        // First unsafe call ⇒ engage the head-of-line barrier. It (and every
        // later call) is deferred to the post-stream serial phase.
        state.barrierEngaged = true;
        return;
    }
    if (state.barrierEngaged) {
        // Safe, but it sits behind an already-engaged barrier: must NOT start
        // (would overlap the pending side-effecting call). Defer it.
        return;
    }
    // Concurrency-safe AND no barrier yet ⇒ start it now, in flight, so it
    // overlaps the remaining stream. NOT awaited here.
    onToolStart?.(call);
    slot.promise = dispatch(call);
};
/** Process one stream event, mutating `state` in place. A tombstone resets
 *  accumulation; a text delta is mirrored out; a finished `tool_use` is
 *  resolved and scheduled. Each branch is the exact body of the original
 *  inline `continue`-guarded blocks, in the same order. */
const handleStreamEvent = (state, ev, args) => {
    if (ev.type === "stream_reset") {
        // Tombstone: discard the dead partial AND any speculative work it
        // started, then re-accumulate from the replacement stream only.
        resetForTombstone(state);
        state.rawEvents.push(ev);
        return;
    }
    state.rawEvents.push(ev);
    // ADR-0077 TTFT: fire `onFirstChunk` exactly once, on the FIRST of
    // (text_delta | thinking_delta | tool_use_start). The latch is reset by
    // `resetForTombstone`, so a post-reset replacement stream re-measures.
    if (!state.firstChunkSeen &&
        (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "tool_use_start")) {
        state.firstChunkSeen = true;
        args.onFirstChunk?.();
    }
    if (ev.type === "text_delta") {
        args.onTextDelta?.(ev.delta);
        return;
    }
    if (ev.type === "response_in_progress") {
        // ADR-0048: fire the heartbeat seam if registered. We FILL IN `timestamp`
        // here (receive side) so the handler always sees a stable monotonic-ish
        // clock; if the provider supplied `createdAt` we forward that as the
        // authoritative value instead.
        if (args.onInProgress !== undefined) {
            const indicator = {
                kind: "in-progress",
                timestamp: ev.createdAt ?? Date.now(),
                ...(ev.message !== undefined ? { message: ev.message } : {}),
                ...(ev.progress !== undefined ? { progress: ev.progress } : {}),
            };
            args.onInProgress(indicator);
        }
        return;
    }
    // The 3 `tool_use_*` events share an extraction (absorb #1, ADR-0060):
    // fire the optional `onToolInput` seam, and additionally schedule the
    // resolved call on `_end`. Single branch here keeps this dispatcher's
    // cognitive complexity bounded — biome would otherwise flag the per-event
    // branches added by the wire.
    handleToolUseEvent(state, ev, args);
};
/** Route the three `tool_use_*` streaming events: fire the optional input
 *  seam, and additionally schedule the resolved call when `_end` carries
 *  the finalized input. Extracted from {@link handleStreamEvent} to keep
 *  that dispatcher under the biome cognitive-complexity budget. */
const handleToolUseEvent = (state, ev, args) => {
    if (ev.type === "tool_use_start") {
        fireToolInput(args.onToolInput, "start", ev);
        return;
    }
    if (ev.type === "tool_use_delta") {
        fireToolInput(args.onToolInput, "delta", ev);
        return;
    }
    if (ev.type !== "tool_use_end")
        return;
    fireToolInput(args.onToolInput, "available", ev);
    const call = resolveToolCall(state.rawEvents, ev.id);
    if (call === undefined)
        return;
    scheduleResolvedCall(state, call, args.isConcurrencySafe, args.dispatch, args.onToolStart);
};
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
const drainDeferredSlots = async (slots, dispatch, onToolStart, signal) => {
    for (const slot of slots) {
        if (slot.promise)
            continue;
        if (isAborted(signal))
            return false;
        onToolStart?.(slot.call);
        slot.promise = dispatch(slot.call);
        try {
            await slot.promise;
        }
        catch {
            // Defensive: dispatch is contractually no-throw (every error path inside
            // it MUST resolve to an ok:false tool_result block). If a future refactor
            // breaks that, we keep marching so the remaining deferred slots still
            // dispatch and Phase 4 still produces one block per call.
        }
    }
    return true;
};
/** Phase 4: collect results STRICTLY in original model call order. `slots` is
 *  already model-call ordered; awaiting settled promises is just unwrapping.
 *
 *  R-Phase1 P0-1: uses `Promise.allSettled` so a rejected slot promise becomes
 *  a synthesized `dispatchFailedBlock` rather than a thrown exception — keeps
 *  the ordering invariant whole even under contract violations in `dispatch`. */
const collectResultBlocks = async (slots) => {
    const settled = await Promise.allSettled(slots.map((s) => s.promise));
    const resultBlocks = [];
    settled.forEach((res, i) => {
        if (res.status === "fulfilled") {
            resultBlocks.push(res.value.block);
            return;
        }
        const slot = slots[i];
        if (slot === undefined)
            return;
        const msg = errMessage(res.reason);
        resultBlocks.push(dispatchFailedBlock(slot.call, msg));
    });
    return resultBlocks;
};
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
export const streamingTurn = async (args) => {
    const { events, dispatch, onToolStart, signal } = args;
    const state = {
        rawEvents: [],
        slots: [],
        barrierEngaged: false,
        firstChunkSeen: false,
    };
    for await (const ev of events) {
        if (isAborted(signal))
            return { kind: "aborted" };
        handleStreamEvent(state, ev, args);
    }
    if (isAborted(signal))
        return { kind: "aborted" };
    const { message, stopReason } = assembleFromEvents(state.rawEvents);
    // Phase 2: settle every early-started (in-flight) dispatch. These were the
    // concurrency-safe overlap calls; awaiting them now is the join point.
    //
    // R-Phase1 P0-1: `Promise.allSettled` (was `Promise.all`) — a single rejected
    // early dispatch must NOT short-circuit Phase 3 + Phase 4. The rejection is
    // re-observed by `collectResultBlocks` and surfaced as a `dispatchFailedBlock`
    // so the ordering invariant (one block per scheduled call) is preserved.
    await Promise.allSettled(state.slots.filter((s) => s.promise).map((s) => s.promise));
    if (isAborted(signal))
        return { kind: "aborted" };
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
            return { kind: "aborted" };
        }
        if (isAborted(signal))
            return { kind: "aborted" };
    }
    // Phase 4: collect ONLY slots that actually dispatched. On the normal path
    // every slot has a promise (Phase 1 in-flight OR Phase 3 deferred-dispatched).
    // On the refusal short-circuit, deferred slots have `promise === undefined`
    // and are excluded — their tool calls never ran, so they produce no result
    // block. The orphan tool_use blocks remain in `message.content` but are
    // discarded by the loop along with the message (error return without
    // wm.append).
    const dispatched = state.slots.filter((s) => s.promise !== undefined);
    const resultBlocks = await collectResultBlocks(dispatched);
    return { kind: "assembled", message: message, stopReason, resultBlocks };
};
