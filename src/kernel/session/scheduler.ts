import type { Message } from "@/llm"
import type { ArtifactRef, SessionCommand, SessionEvent, TurnRunCommand } from "@/protocol/session"
import { SessionProtocolValidationError } from "@/protocol/session"
import { isAbort } from "@/shared/abortable"
import { writeStderr } from "@/shared/terminal-io"
import type {
  KernelCommittedEvents,
  KernelDispatchContext,
  SessionHostTurnEvent,
  SessionHostTurnResult,
} from "./ports"
import { reduceSessionCommand } from "./reducer"
import { projectSessionHostTurnEvent } from "./session-host-turn-event-projection"
import {
  type KernelSessionState,
  type KernelTranscriptState,
  summarizeTranscript,
  toSessionStateView,
} from "./state"

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
const activeTurnControllers = new Map<string, AbortController>()

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

/**
 * T03 (audit L5 M-5) — observer no-throw sink. `onCommitted` is a persistence /
 * subscriber notification; a throw from it is DIAGNOSTIC and must NEVER be
 * mistaken for a turn failure. We isolate the call so its rejection cannot
 * bubble into the turn try/catch that classifies terminal outcome. There is no
 * silent swallow: the error is surfaced via the kernel-global observer-error
 * sink (defaulting to the ADR-0303 injected `writeStderr` terminal sink) so it
 * stays visible without redefining turn success/failure.
 */
let observerErrorSink: (error: unknown) => void = (error) => {
  // Documented diagnostic surface — routed through the ADR-0303 injected terminal
  // sink (default NOOP) so this kernel module owns no raw terminal; overridable
  // via `setKernelObserverErrorSink` to route into structured telemetry.
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  writeStderr(
    `[kernel.session] onCommitted observer threw (diagnostic, not a turn failure): ${detail}\n`,
  )
}

/** Override the observer-error sink (e.g. to route into structured telemetry).
 *  Returns the previous sink so callers can restore it. */
export const setKernelObserverErrorSink = (
  sink: (error: unknown) => void,
): ((error: unknown) => void) => {
  const previous = observerErrorSink
  observerErrorSink = sink
  return previous
}

const notifyCommitted = async (
  ctx: KernelDispatchContext,
  args: KernelCommittedEvents,
): Promise<void> => {
  if (ctx.onCommitted === undefined) return
  try {
    await ctx.onCommitted(args)
  } catch (error) {
    observerErrorSink(error)
  }
}

const appendEvents = async (
  eventLog: KernelDispatchContext["eventLog"],
  events: readonly SessionEvent[],
): Promise<void> => {
  for (const event of events) await eventLog.append(event)
}

const readyEvents = (args: {
  readonly state: KernelSessionState
  readonly commandId: string
  readonly emittedAt: string
  readonly artifacts: readonly ArtifactRef[]
}): SessionEvent[] =>
  args.artifacts.map((artifact, index) => ({
    eventId: crypto.randomUUID(),
    seq: args.state.seq + index + 1,
    revision: args.state.revision,
    emittedAt: args.emittedAt,
    causedByCommandId: args.commandId,
    type: "artifact.ready",
    artifact,
  }))

const clearStreamingAssistantText = (transcript: KernelTranscriptState): KernelTranscriptState => {
  const { streamingAssistantText: _streamingAssistantText, ...rest } = transcript
  return rest
}

export interface KernelDispatchResult {
  readonly state: KernelSessionState
  readonly events: readonly SessionEvent[]
  readonly transcriptMessages?: readonly Message[]
  readonly turnResult?: SessionHostTurnResult
}

const approvalEventsForTurn = (args: {
  readonly state: KernelSessionState
  readonly command: TurnRunCommand
  readonly approval: NonNullable<SessionHostTurnResult["approvalRequest"]>
  readonly ctx: KernelDispatchContext
}): readonly SessionEvent[] => [
  {
    eventId: crypto.randomUUID(),
    seq: args.state.seq - 1,
    revision: args.state.revision,
    emittedAt: args.ctx.clock.now().toISOString(),
    causedByCommandId: args.command.commandId,
    type: "approval.requested",
    approval: args.approval,
  },
  {
    eventId: crypto.randomUUID(),
    seq: args.state.seq,
    revision: args.state.revision,
    emittedAt: args.ctx.clock.now().toISOString(),
    causedByCommandId: args.command.commandId,
    type: "session.state.updated",
    state: toSessionStateView(args.state),
  },
]

const onApprovalRequested = async (args: {
  readonly state: KernelSessionState
  readonly command: TurnRunCommand
  readonly result: SessionHostTurnResult
  readonly ctx: KernelDispatchContext
  readonly events: readonly SessionEvent[]
}): Promise<KernelDispatchResult> => {
  const approval = args.result.approvalRequest
  if (approval === undefined) {
    throw new SessionProtocolValidationError("missing_approval_request")
  }
  const nextState: KernelSessionState = {
    ...args.state,
    revision: args.state.revision + 1,
    seq: args.state.seq + 2,
    status: "awaiting_approval",
    pendingApproval: approval,
    messages: [...args.result.messages],
    transcript: clearStreamingAssistantText(summarizeTranscript(args.result.messages)),
  }
  const approvalEvents = approvalEventsForTurn({
    state: nextState,
    command: args.command,
    approval,
    ctx: args.ctx,
  })
  await appendEvents(args.ctx.eventLog, approvalEvents)
  return {
    state: nextState,
    events: [...args.events, ...approvalEvents],
    turnResult: args.result,
  }
}

const completionEventsForTurn = (args: {
  readonly state: KernelSessionState
  readonly command: TurnRunCommand
  readonly artifacts: readonly ArtifactRef[]
  readonly ctx: KernelDispatchContext
}): readonly SessionEvent[] => {
  const emittedAt = args.ctx.clock.now().toISOString()
  const artifactEvents = readyEvents({
    state: args.state,
    commandId: args.command.commandId,
    emittedAt,
    artifacts: args.artifacts,
  })
  const completionSeq = args.state.seq + artifactEvents.length + 1
  return [
    ...artifactEvents,
    {
      eventId: crypto.randomUUID(),
      seq: completionSeq,
      revision: args.state.revision,
      emittedAt,
      causedByCommandId: args.command.commandId,
      type: "turn.completed",
      outcomeReason: args.state.lastOutcomeReason ?? "completed",
      ...(args.state.transcript.lastAssistantText !== undefined
        ? { assistantText: args.state.transcript.lastAssistantText }
        : {}),
      ...(args.state.modelSlug !== undefined ? { modelSlug: args.state.modelSlug } : {}),
      ...(args.state.lastTokenUsage !== undefined ? { tokenUsage: args.state.lastTokenUsage } : {}),
    },
    {
      eventId: crypto.randomUUID(),
      seq: completionSeq + 1,
      revision: args.state.revision,
      emittedAt,
      causedByCommandId: args.command.commandId,
      type: "session.state.updated",
      state: toSessionStateView(args.state),
    },
  ]
}

const onTurnCompleted = async (args: {
  readonly state: KernelSessionState
  readonly command: TurnRunCommand
  readonly result: SessionHostTurnResult
  readonly ctx: KernelDispatchContext
  readonly events: readonly SessionEvent[]
}): Promise<KernelDispatchResult> => {
  const artifacts = [...(args.result.artifacts ?? [])]
  const completedState: KernelSessionState = {
    ...args.state,
    revision: args.state.revision + 1,
    status: "idle",
    messages: [...args.result.messages],
    draftInput: "",
    draftImages: [],
    pendingApproval: null,
    transcript: clearStreamingAssistantText(summarizeTranscript(args.result.messages)),
    artifacts: [...args.state.artifacts, ...artifacts],
    lastOutcomeReason: args.result.outcome.reason,
    ...(args.result.tokenUsage !== undefined ? { lastTokenUsage: args.result.tokenUsage } : {}),
  }
  const completionEvents = completionEventsForTurn({
    state: completedState,
    command: args.command,
    artifacts,
    ctx: args.ctx,
  })
  const seq = completionEvents.at(-1)?.seq ?? completedState.seq
  const nextState: KernelSessionState = {
    ...completedState,
    seq,
  }
  await appendEvents(args.ctx.eventLog, completionEvents)
  return {
    state: nextState,
    events: [...args.events, ...completionEvents],
    turnResult: args.result,
    transcriptMessages: [...args.result.messages],
  }
}

/** T03 — a turn whose host work threw because its controller was aborted is a
 *  CANCELLATION, not a failure. We classify it via the shared `isAbort`
 *  primitive (never by string-matching the message) and settle status `idle`
 *  with `lastOutcomeReason: "aborted"` so a cancelled runaway turn is not
 *  mislabelled `turn.failed`. We still emit a `turn.failed` wire event (the
 *  protocol has no dedicated cancelled-turn event in this slice's touch set) but
 *  with an explicit "aborted" message so the classification is unambiguous. */
const onTurnAborted = async (args: {
  readonly state: KernelSessionState
  readonly command: TurnRunCommand
  readonly error: unknown
  readonly ctx: KernelDispatchContext
  readonly events: readonly SessionEvent[]
}): Promise<KernelDispatchResult> => {
  const nextState: KernelSessionState = {
    ...args.state,
    revision: args.state.revision + 1,
    seq: args.state.seq + 2,
    status: "idle",
    pendingApproval: null,
    transcript: clearStreamingAssistantText(args.state.transcript),
    lastOutcomeReason: "aborted",
  }
  const abortedEvents: SessionEvent[] = [
    {
      eventId: crypto.randomUUID(),
      seq: nextState.seq - 1,
      revision: nextState.revision,
      emittedAt: args.ctx.clock.now().toISOString(),
      causedByCommandId: args.command.commandId,
      type: "turn.failed",
      message: args.error instanceof Error ? args.error.message : "turn aborted",
    },
    {
      eventId: crypto.randomUUID(),
      seq: nextState.seq,
      revision: nextState.revision,
      emittedAt: args.ctx.clock.now().toISOString(),
      causedByCommandId: args.command.commandId,
      type: "session.state.updated",
      state: toSessionStateView(nextState),
    },
  ]
  await appendEvents(args.ctx.eventLog, abortedEvents)
  return { state: nextState, events: [...args.events, ...abortedEvents] }
}

const onTurnFailed = async (args: {
  readonly state: KernelSessionState
  readonly command: TurnRunCommand
  readonly error: unknown
  readonly ctx: KernelDispatchContext
  readonly events: readonly SessionEvent[]
}): Promise<KernelDispatchResult> => {
  const nextState: KernelSessionState = {
    ...args.state,
    revision: args.state.revision + 1,
    seq: args.state.seq + 2,
    status: "failed",
    transcript: clearStreamingAssistantText(args.state.transcript),
    lastOutcomeReason: "error",
  }
  const failedEvents: SessionEvent[] = [
    {
      eventId: crypto.randomUUID(),
      seq: nextState.seq - 1,
      revision: nextState.revision,
      emittedAt: args.ctx.clock.now().toISOString(),
      causedByCommandId: args.command.commandId,
      type: "turn.failed",
      message: args.error instanceof Error ? args.error.message : String(args.error),
    },
    {
      eventId: crypto.randomUUID(),
      seq: nextState.seq,
      revision: nextState.revision,
      emittedAt: args.ctx.clock.now().toISOString(),
      causedByCommandId: args.command.commandId,
      type: "session.state.updated",
      state: toSessionStateView(nextState),
    },
  ]
  await appendEvents(args.ctx.eventLog, failedEvents)
  return { state: nextState, events: [...args.events, ...failedEvents] }
}

const onTurnErrored = async (args: {
  readonly state: KernelSessionState
  readonly command: TurnRunCommand
  readonly result: SessionHostTurnResult
  readonly ctx: KernelDispatchContext
  readonly events: readonly SessionEvent[]
}): Promise<KernelDispatchResult> => {
  const nextState: KernelSessionState = {
    ...args.state,
    revision: args.state.revision + 1,
    seq: args.state.seq + 2,
    status: "failed",
    messages: [...args.result.messages],
    draftInput: "",
    draftImages: [],
    pendingApproval: null,
    transcript: clearStreamingAssistantText(summarizeTranscript(args.result.messages)),
    lastOutcomeReason: "error",
  }
  const failedEvents: SessionEvent[] = [
    {
      eventId: crypto.randomUUID(),
      seq: nextState.seq - 1,
      revision: nextState.revision,
      emittedAt: args.ctx.clock.now().toISOString(),
      causedByCommandId: args.command.commandId,
      type: "turn.failed",
      message: args.result.errorMessage ?? "error",
    },
    {
      eventId: crypto.randomUUID(),
      seq: nextState.seq,
      revision: nextState.revision,
      emittedAt: args.ctx.clock.now().toISOString(),
      causedByCommandId: args.command.commandId,
      type: "session.state.updated",
      state: toSessionStateView(nextState),
    },
  ]
  await appendEvents(args.ctx.eventLog, failedEvents)
  return {
    state: nextState,
    events: [...args.events, ...failedEvents],
    turnResult: args.result,
    transcriptMessages: [...args.result.messages],
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

const runTurn = async (args: {
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
          const streamed = await emitTurnStreamEvent({
            state: streamState,
            command: args.command,
            ctx: args.ctx,
            event,
          })
          streamState = streamed.state
          streamedEvents.push(streamed.emitted)
        })
      },
    })
    await pendingStream
    return result.approvalRequest !== undefined
      ? await onApprovalRequested({
          state: streamState,
          command: args.command,
          result,
          ctx: args.ctx,
          events: [...args.events, ...streamedEvents],
        })
      : result.outcome.reason === "error"
        ? await onTurnErrored({
            state: streamState,
            command: args.command,
            result,
            ctx: args.ctx,
            events: [...args.events, ...streamedEvents],
          })
        : await onTurnCompleted({
            state: streamState,
            command: args.command,
            result,
            ctx: args.ctx,
            events: [...args.events, ...streamedEvents],
          })
  } catch (error) {
    await pendingStream
    // A turn torn down by a cancel/abort is classified as aborted, not failed,
    // via the shared abort primitive — never by message string-matching.
    return isAbort(error) || turnController.signal.aborted
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
const settlePreAbortedTurnRun = async (args: {
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
  await appendEvents(ctx.eventLog, cancelEvents)
  await notifyCommitted(ctx, { state: cancelledState, events: cancelEvents })
  return { state: cancelledState, events: cancelEvents }
}

export const dispatchSessionCommand = async (
  state: KernelSessionState,
  command: SessionCommand,
  ctx: KernelDispatchContext,
): Promise<KernelDispatchResult> => {
  // T03 (audit L5 C-1) — EXECUTE the cancel decision BEFORE acquiring the
  // single-writer lease. The lease is held for the entire duration of an
  // in-flight `turn.run`, so a `turn.cancel` that waited on the lease could
  // never reach the running turn. Aborting the registered turn-owned controller
  // is a synchronous side-effect on the shared controller object the running
  // turn already observes through its composed signal — cancellation propagates
  // immediately.
  //
  // When there IS a live turn we return right here, WITHOUT contending on the
  // lease: the running turn is the authoritative owner of the terminal state
  // transition and settles itself as `aborted` (see `onTurnAborted`). Acquiring
  // the lease here would deadlock/throw against the holder. When there is no
  // live turn, fall through to the lease-guarded block so an idle `turn.cancel`
  // is still a clean, deterministic no-op echo.
  if (command.type === "turn.cancel") {
    const live = activeTurnControllers.get(state.sessionId)
    if (live !== undefined) {
      live.abort()
      return { state, events: [] }
    }
  }
  return await state.lease.runWith(command.commandId, async () => {
    const emittedAt = ctx.clock.now().toISOString()
    // T03 (audit L5 H-8) — dispatch-level abort gate. `signal.aborted` is now
    // checked at the dispatch boundary, so a `turn.run` never starts host work
    // on an already-dead signal (previously the signal was merely forwarded to
    // the host with no dispatch-level guard). We classify it as an aborted turn
    // and reuse the reducer's `turn.cancel` transition rather than throwing past
    // the reducer; the running-turn catch path uses the shared `isAbort`
    // primitive for the symmetric mid-flight case.
    if (command.type === "turn.run" && ctx.signal?.aborted === true) {
      return await settlePreAbortedTurnRun({ state, command, ctx, emittedAt })
    }
    const reduced = reduceSessionCommand(state, command, emittedAt)
    const immediateEvents = [...reduced.events]
    const nextState: KernelSessionState = {
      ...reduced.state,
      seq: state.seq + immediateEvents.length,
    }
    // Audit R2 H1: register the turn-owned cancel controller BEFORE the awaited
    // event-log persistence so a turn.cancel dispatched during that window —
    // which cannot acquire the held single-writer lease — reaches a LIVE target
    // via the fast-path instead of contending on the lease (which throws
    // lease-held while the turn proceeds uncancelled).
    let preRegisteredController: AbortController | undefined
    if (command.type === "turn.run") {
      preRegisteredController = new AbortController()
      activeTurnControllers.set(state.sessionId, preRegisteredController)
    }
    try {
      await appendEvents(ctx.eventLog, immediateEvents)
      await notifyCommitted(ctx, { state: nextState, events: immediateEvents })
    } catch (e) {
      // Persistence failed before runTurn could adopt the controller — drop it
      // so the pre-registration doesn't leak a stale entry.
      if (
        preRegisteredController !== undefined &&
        activeTurnControllers.get(state.sessionId) === preRegisteredController
      ) {
        activeTurnControllers.delete(state.sessionId)
      }
      throw e
    }

    switch (command.type) {
      case "session.identity.set":
        await ctx.host.setIdentityMode?.(command.mode)
        return { state: nextState, events: immediateEvents }
      case "session.tool_profile.set":
        await ctx.host.setToolProfile?.(command.profile)
        return { state: nextState, events: immediateEvents }
      case "session.permission.set":
        await ctx.host.setPermissionMode?.(command.mode)
        return { state: nextState, events: immediateEvents }
      case "session.transcript.replace":
        return {
          state: nextState,
          events: immediateEvents,
          transcriptMessages: [...command.messages],
        }
      case "approval.respond":
        await ctx.host.resolveApproval?.({
          approvalId: command.approvalId,
          decision: command.decision,
          // ADR-0512 P3 — forward the escalation's once/session scope + steer so
          // the host lease carries the operator's rich decision. Both absent on a
          // normal approval ⇒ byte-identical grant.
          ...(command.scope !== undefined ? { scope: command.scope } : {}),
          ...(command.steer !== undefined ? { steer: command.steer } : {}),
          // T05 — forward the web/SDK operator's per-hunk choice so the host can
          // apply only the accepted subset. Absent ⇒ whole-call, byte-identical.
          ...(command.selectedHunks !== undefined ? { selectedHunks: command.selectedHunks } : {}),
        })
        return { state: nextState, events: immediateEvents }
      case "turn.run":
        return await runTurn({
          state: nextState,
          command,
          ctx,
          reduced,
          events: immediateEvents,
          ...(preRegisteredController !== undefined
            ? { turnController: preRegisteredController }
            : {}),
        })
      default:
        return { state: nextState, events: immediateEvents }
    }
  })
}
