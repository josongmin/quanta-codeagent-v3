import type { SessionEvent, TurnRunCommand } from "@/protocol/session"
import type {
  KernelDispatchContext,
  SessionHostTurnEvent,
  SessionHostTurnResult,
} from "./ports"
import { reduceSessionCommand } from "./reducer"
import {
  appendEvents,
  appendTerminalEvents,
  notifyCommitted,
  recordStreamAppendFailure,
} from "./scheduler-append-isolation"
import {
  classifyTerminal,
  type KernelDispatchResult,
  onApprovalRequested,
  onTurnAborted,
  onTurnCompleted,
  onTurnErrored,
  onTurnFailed,
} from "./scheduler-turn-terminals"
import { projectSessionHostTurnEvent } from "./session-host-turn-event-projection"
import { type KernelSessionState, toSessionStateView } from "./state"

/**
 * `turn.run` EXECUTION — the host call and the cancellation that races it.
 *
 * ONE responsibility: run a reduced `turn.run` against the session host and
 * hand the outcome to the right terminal. That means owning the three things a
 * live turn needs and nothing else owns: the per-session turn-cancel registry
 * (`activeTurnControllers`, the seam `dispatchSessionCommand`'s lease-free
 * cancel fast-path aborts), the composed turn signal that fuses the caller's
 * external abort with the turn-owned one, and the ordered stream fan-out that
 * projects each host event, persists it, and notifies observers.
 *
 * It DECIDES which terminal applies (via the terminals module's
 * `classifyTerminal` SSOT) but never defines one — `scheduler-turn-terminals.ts`
 * owns what each terminal commits. `settlePreAbortedTurnRun` lives here because
 * it is the same `turn.run` execution path taken when the signal is already dead
 * at the dispatch boundary, i.e. the zero-host-work variant of running a turn.
 *
 * Split out of `scheduler.ts` (god-module ratchet) — pure move, no logic change.
 */
/**
 * T03 — turn-owned cancel state. The reducer OWNS the cancel decision (it emits
 * a `cancel_turn` hostAction); this registry is the scheduler's EXECUTION seam.
 *
 * It is keyed by `sessionId` and holds the AbortController of the turn currently
 * in flight for that session. `turn.run` registers its controller before handing
 * the composed signal to the host and clears it on settle; `turn.cancel` aborts
 * the registered controller. This is the ONLY place an active turn's signal is
 * torn down — there is no second controller for the same turn (audit L5 C-1/H-8).
 *
 * The registry must be mutated by `turn.cancel` WITHOUT contending on the
 * session single-writer lease, because the in-flight `turn.run` holds that lease
 * for its whole duration. The abort is a synchronous side-effect on the shared
 * controller object the running turn already observes through its composed
 * signal, so cancellation propagates immediately.
 */
export const activeTurnControllers = new Map<string, AbortController>()

/** Compose the caller's external `ctx.signal` with a fresh turn-owned controller
 *  so a `turn.cancel` (which aborts the turn-owned one) AND an external abort
 *  (the caller's own signal) both tear the SAME effective signal the host reads.
 *  Listeners are removed when the turn-owned controller settles so a long-lived
 *  external signal does not accumulate listeners across turns. */
const composeTurnSignal = (
  turnController: AbortController,
  external: AbortSignal | undefined,
): { signal: AbortSignal; dispose: () => void } => {
  if (external === undefined) {
    return { signal: turnController.signal, dispose: () => undefined }
  }
  if (external.aborted) turnController.abort(external.reason)
  const onExternalAbort = (): void => turnController.abort(external.reason)
  external.addEventListener("abort", onExternalAbort, { once: true })
  return {
    signal: turnController.signal,
    dispose: () => external.removeEventListener("abort", onExternalAbort),
  }
}

const emitTurnStreamEvent = async (args: {
  readonly state: KernelSessionState
  readonly command: TurnRunCommand
  readonly ctx: KernelDispatchContext
  readonly event: SessionHostTurnEvent
}): Promise<{
  readonly state: KernelSessionState
  readonly emitted: SessionEvent
}> => {
  const projected = projectSessionHostTurnEvent({
    state: args.state,
    commandId: args.command.commandId,
    emittedAt: args.ctx.clock.now().toISOString(),
    event: args.event,
  })
  await appendEvents(args.ctx.eventLog, [projected.emitted])
  await notifyCommitted(args.ctx, { state: projected.state, events: [projected.emitted] })
  return projected
}

/**
 * Route a host turn that RETURNED to its terminal — aborted, errored, or completed.
 *
 * A unit because the three-way choice is ONE classification: {@link classifyTerminal}
 * over the host's outcome plus the turn controller's abort state, with every arm handed
 * the same accumulated state and events. Keeping the routing next to the classification
 * is the point — when they were apart, a cooperative `"aborted"` outcome fell through to
 * `turn.completed` on the return path while an abort THROW settled as `turn.aborted`,
 * so one cancel had two terminals depending on how the host chose to report it.
 */
const settleReturnedTurn = async (args: {
  readonly state: KernelSessionState
  readonly command: TurnRunCommand
  readonly ctx: KernelDispatchContext
  readonly result: SessionHostTurnResult
  readonly events: readonly SessionEvent[]
  readonly turnController: AbortController
}): Promise<KernelDispatchResult> => {
  const terminal = classifyTerminal({
    outcome: args.result.outcome,
    aborted: args.turnController.signal.aborted,
  })
  const settled = {
    state: args.state,
    command: args.command,
    result: args.result,
    ctx: args.ctx,
    events: args.events,
  }
  if (terminal === "aborted") {
    // ALBB-04 P2 — the cooperative RETURN-abort path: hand the host result
    // through so its accumulated `messages` are COMMITTED (and the draft
    // cleared), not silently discarded back to the pre-turn message set.
    return await onTurnAborted({
      ...settled,
      ...(args.turnController.signal.reason !== undefined
        ? { error: args.turnController.signal.reason }
        : {}),
    })
  }
  if (terminal === "error") return await onTurnErrored(settled)
  return await onTurnCompleted(settled)
}

export const runTurn = async (args: {
  readonly state: KernelSessionState
  readonly command: TurnRunCommand
  readonly ctx: KernelDispatchContext
  readonly reduced: ReturnType<typeof reduceSessionCommand>
  readonly events: readonly SessionEvent[]
  /** Audit R2 H1: pre-created + pre-registered by the dispatch arm BEFORE the
   *  awaited event-log write, so a window turn.cancel can reach it. When absent,
   *  runTurn creates + registers its own. */
  readonly turnController?: AbortController
}): Promise<KernelDispatchResult> => {
  const hostAction = args.reduced.hostAction
  let streamState = args.state
  const streamedEvents: SessionEvent[] = []
  let pendingStream = Promise.resolve()
  // T03 — turn-owned cancel controller. Registered under the session id so a
  // concurrent `turn.cancel` (which cannot acquire the held lease) can abort the
  // SAME signal this host turn observes. Composed with the caller's external
  // signal so both cancellation owners tear one effective signal.
  const sessionId = args.state.sessionId
  const turnController = args.turnController ?? new AbortController()
  // When the dispatch arm pre-registered the controller (audit R2 H1) do NOT
  // re-register; otherwise install it now. The `finally` teardown is identical.
  if (args.turnController === undefined) {
    activeTurnControllers.set(sessionId, turnController)
  }
  const composed = composeTurnSignal(turnController, args.ctx.signal)
  try {
    // Audit R2 H1: a turn.cancel during the pre-host event-log-write window
    // aborts THIS controller via the cancel fast-path. Never start host work on
    // an already-cancelled turn — settle it aborted immediately (the `finally`
    // still clears the controller + disposes the composed signal).
    if (turnController.signal.aborted) {
      await pendingStream
      return await onTurnAborted({
        state: streamState,
        command: args.command,
        error: turnController.signal.reason ?? new Error("turn cancelled before host start"),
        ctx: args.ctx,
        events: [...args.events, ...streamedEvents],
      })
    }
    const result = await args.ctx.host.runTurn({
      history: hostAction.kind === "run_turn" ? hostAction.history : args.state.messages,
      prompt: hostAction.kind === "run_turn" ? hostAction.prompt : "",
      ...(hostAction.kind === "run_turn" ? { images: hostAction.images } : {}),
      signal: composed.signal,
      onEvent: (event) => {
        pendingStream = pendingStream.then(async () => {
          // ALBB-04 — per-event isolation. An `eventLog.append` rejection for
          // THIS stream event is routed to the no-throw diagnostic sink and the
          // chain CONTINUES, so (a) a later stream event still attempts its
          // append (no silent drop of subsequent events) and (b) the rejection
          // never propagates to `await pendingStream` where it would flip a
          // host-successful turn into `turn.failed`. Symmetric with
          // `notifyCommitted`'s observer-throw isolation.
          try {
            const streamed = await emitTurnStreamEvent({
              state: streamState,
              command: args.command,
              ctx: args.ctx,
              event,
            })
            streamState = streamed.state
            streamedEvents.push(streamed.emitted)
          } catch (error) {
            // ALBB-04 — count + surface through the isolation layer that owns the
            // counter and the sink (verbatim move of the two statements).
            recordStreamAppendFailure(error)
          }
        })
      },
    })
    await pendingStream
    if (result.approvalRequest !== undefined) {
      return await onApprovalRequested({
        state: streamState,
        command: args.command,
        result,
        ctx: args.ctx,
        events: [...args.events, ...streamedEvents],
      })
    }
    // ALBB-04 single-classifier. The success arm (host RETURNED an outcome)
    // consults the SAME `classifyTerminal` SSOT the catch arm uses, so a
    // cooperative cancel (`outcome.reason === "aborted"`) settles through
    // `onTurnAborted` — the dedicated `turn.aborted` terminal — EXACTLY like a
    // mid-flight abort that threw. Previously only `"error"` was special-cased
    // and `"aborted"` fell to `onTurnCompleted`, surfacing an identical cancel
    // as `turn.completed` on the return path and `turn.failed` on the throw path.
    return await settleReturnedTurn({
      state: streamState,
      command: args.command,
      ctx: args.ctx,
      result,
      events: [...args.events, ...streamedEvents],
      turnController,
    })
  } catch (error) {
    await pendingStream
    // ALBB-04 single-classifier. The catch arm (host THREW) consults the SAME
    // `classifyTerminal` SSOT: an abort throw settles as `onTurnAborted`
    // (dedicated `turn.aborted`), any other throw as `onTurnFailed`.
    return classifyTerminal({ error, aborted: turnController.signal.aborted }) === "aborted"
      ? await onTurnAborted({
          state: streamState,
          command: args.command,
          error,
          ctx: args.ctx,
          events: [...args.events, ...streamedEvents],
        })
      : await onTurnFailed({
          state: streamState,
          command: args.command,
          error,
          ctx: args.ctx,
          events: [...args.events, ...streamedEvents],
        })
  } finally {
    // Clear the turn-owned controller for THIS turn only — a later turn for the
    // same session installs its own. Drop the external-signal listener so a
    // long-lived caller signal does not accumulate one per turn.
    if (activeTurnControllers.get(sessionId) === turnController) {
      activeTurnControllers.delete(sessionId)
    }
    composed.dispose()
  }
}

/** T03 (audit L5 H-8 / R1 H1) — settle a `turn.run` whose external signal is
 *  ALREADY aborted at the dispatch boundary. We reuse the reducer's
 *  `turn.cancel` transition rather than throwing past the reducer. When that
 *  transition emits NOTHING (pre-aborted run against an already-idle session)
 *  we synthesize an explicit `session.state.updated` (+ bump revision/seq) so
 *  the event log never diverges from the returned state. */
export const settlePreAbortedTurnRun = async (args: {
  readonly state: KernelSessionState
  readonly command: TurnRunCommand
  readonly ctx: KernelDispatchContext
  readonly emittedAt: string
}): Promise<KernelDispatchResult> => {
  const { state, command, ctx, emittedAt } = args
  const cancelReduced = reduceSessionCommand(state, { ...command, type: "turn.cancel" }, emittedAt)
  let cancelEvents = [...cancelReduced.events]
  let cancelledState: KernelSessionState = {
    ...cancelReduced.state,
    status: "idle",
    lastOutcomeReason: "aborted",
    seq: state.seq + cancelEvents.length,
  }
  if (cancelEvents.length === 0) {
    cancelledState = {
      ...cancelledState,
      revision: state.revision + 1,
      seq: state.seq + 1,
    }
    cancelEvents = [
      {
        eventId: crypto.randomUUID(),
        seq: cancelledState.seq,
        revision: cancelledState.revision,
        emittedAt,
        causedByCommandId: command.commandId,
        type: "session.state.updated",
        state: toSessionStateView(cancelledState),
      },
    ]
  }
  // B1 — this settles a `turn.run` (aborted at the dispatch boundary). A durable
  // append throw must NOT swallow the state echo: persist through the no-throw
  // terminal sink so `notifyCommitted` still publishes and the events still
  // return, keeping the subscriber/bridge in sync with the returned state.
  await appendTerminalEvents(ctx.eventLog, cancelEvents)
  await notifyCommitted(ctx, { state: cancelledState, events: cancelEvents })
  return { state: cancelledState, events: cancelEvents }
}
