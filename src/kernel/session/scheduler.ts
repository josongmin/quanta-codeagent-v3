import type { Message } from "@/llm"
import type { ArtifactRef, SessionCommand, SessionEvent, TurnRunCommand } from "@/protocol/session"
import { SessionProtocolValidationError } from "@/protocol/session"
import type { KernelDispatchContext, SessionHostTurnEvent, SessionHostTurnResult } from "./ports"
import { reduceSessionCommand } from "./reducer"
import {
  type KernelSessionState,
  type KernelTranscriptState,
  summarizeTranscript,
  toSessionStateView,
} from "./state"

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

const clearStreamingAssistantText = (
  transcript: KernelTranscriptState,
): KernelTranscriptState => {
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
      ...(args.state.modelSlug !== undefined
        ? { modelSlug: args.state.modelSlug }
        : {}),
      ...(args.state.lastTokenUsage !== undefined
        ? { tokenUsage: args.state.lastTokenUsage }
        : {}),
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
    ...(args.result.tokenUsage !== undefined
      ? { lastTokenUsage: args.result.tokenUsage }
      : {}),
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
  switch (args.event.type) {
    case "llm.request": {
      const nextState: KernelSessionState = {
        ...args.state,
        revision: args.state.revision + 1,
        seq: args.state.seq + 1,
        lastLlmRequest: {
          model: args.event.model,
          ...(args.event.provider !== undefined ? { provider: args.event.provider } : {}),
          ...(args.event.surfaceId !== undefined ? { surfaceId: args.event.surfaceId } : {}),
          ...(args.event.transportId !== undefined ? { transportId: args.event.transportId } : {}),
          ...(args.event.authMode !== undefined ? { authMode: args.event.authMode } : {}),
          ...(args.event.policy !== undefined ? { policy: args.event.policy } : {}),
        },
      }
      const sessionEvent: SessionEvent = {
        eventId: crypto.randomUUID(),
        seq: nextState.seq,
        revision: nextState.revision,
        emittedAt: args.ctx.clock.now().toISOString(),
        causedByCommandId: args.command.commandId,
        type: "turn.llm.request",
        model: args.event.model,
        ...(args.event.provider !== undefined ? { provider: args.event.provider } : {}),
        ...(args.event.surfaceId !== undefined ? { surfaceId: args.event.surfaceId } : {}),
        ...(args.event.transportId !== undefined ? { transportId: args.event.transportId } : {}),
        ...(args.event.authMode !== undefined ? { authMode: args.event.authMode } : {}),
        ...(args.event.policy !== undefined ? { policy: args.event.policy } : {}),
      }
      await appendEvents(args.ctx.eventLog, [sessionEvent])
      await args.ctx.onCommitted?.({ state: nextState, events: [sessionEvent] })
      return { state: nextState, emitted: sessionEvent }
    }
    case "llm.continuation": {
      const nextState: KernelSessionState = {
        ...args.state,
        revision: args.state.revision + 1,
        seq: args.state.seq + 1,
        lastLlmContinuation: {
          ...(args.event.provider !== undefined ? { provider: args.event.provider } : {}),
          surfaceId: args.event.surfaceId,
          transportId: args.event.transportId,
          phase: args.event.phase,
          mode: args.event.mode,
          reason: args.event.reason,
          ...(args.event.statusCode !== undefined ? { statusCode: args.event.statusCode } : {}),
        },
      }
      const sessionEvent: SessionEvent = {
        eventId: crypto.randomUUID(),
        seq: nextState.seq,
        revision: nextState.revision,
        emittedAt: args.ctx.clock.now().toISOString(),
        causedByCommandId: args.command.commandId,
        type: "turn.llm.continuation",
        ...(args.event.provider !== undefined ? { provider: args.event.provider } : {}),
        surfaceId: args.event.surfaceId,
        transportId: args.event.transportId,
        phase: args.event.phase,
        mode: args.event.mode,
        reason: args.event.reason,
        ...(args.event.statusCode !== undefined ? { statusCode: args.event.statusCode } : {}),
      }
      await appendEvents(args.ctx.eventLog, [sessionEvent])
      await args.ctx.onCommitted?.({ state: nextState, events: [sessionEvent] })
      return { state: nextState, emitted: sessionEvent }
    }
    case "assistant_text.delta": {
      const nextText = `${args.state.transcript.streamingAssistantText ?? ""}${args.event.delta}`
      const nextState: KernelSessionState = {
        ...args.state,
        revision: args.state.revision + 1,
        seq: args.state.seq + 1,
        transcript: {
          ...args.state.transcript,
          streamingAssistantText: nextText,
        },
      }
      const sessionEvent: SessionEvent = {
        eventId: crypto.randomUUID(),
        seq: nextState.seq,
        revision: nextState.revision,
        emittedAt: args.ctx.clock.now().toISOString(),
        causedByCommandId: args.command.commandId,
        type: "turn.output.delta",
        delta: args.event.delta,
      }
      await appendEvents(args.ctx.eventLog, [sessionEvent])
      await args.ctx.onCommitted?.({ state: nextState, events: [sessionEvent] })
      return { state: nextState, emitted: sessionEvent }
    }
    case "tool.invoked": {
      const nextState: KernelSessionState = {
        ...args.state,
        revision: args.state.revision + 1,
        seq: args.state.seq + 1,
      }
      const sessionEvent: SessionEvent = {
        eventId: crypto.randomUUID(),
        seq: nextState.seq,
        revision: nextState.revision,
        emittedAt: args.ctx.clock.now().toISOString(),
        causedByCommandId: args.command.commandId,
        type: "tool.invoked",
        toolCallId: args.event.toolCallId,
        toolName: args.event.toolName,
        ...(args.event.argsPreview !== undefined
          ? { argsPreview: args.event.argsPreview }
          : {}),
      }
      await appendEvents(args.ctx.eventLog, [sessionEvent])
      await args.ctx.onCommitted?.({ state: nextState, events: [sessionEvent] })
      return { state: nextState, emitted: sessionEvent }
    }
    case "tool.completed": {
      const nextState: KernelSessionState = {
        ...args.state,
        revision: args.state.revision + 1,
        seq: args.state.seq + 1,
      }
      const sessionEvent: SessionEvent = {
        eventId: crypto.randomUUID(),
        seq: nextState.seq,
        revision: nextState.revision,
        emittedAt: args.ctx.clock.now().toISOString(),
        causedByCommandId: args.command.commandId,
        type: "tool.completed",
        toolCallId: args.event.toolCallId,
        toolName: args.event.toolName,
        outcome: args.event.outcome,
        ...(args.event.resultPreview !== undefined
          ? { resultPreview: args.event.resultPreview }
          : {}),
        ...(args.event.durationMs !== undefined
          ? { durationMs: args.event.durationMs }
          : {}),
      }
      await appendEvents(args.ctx.eventLog, [sessionEvent])
      await args.ctx.onCommitted?.({ state: nextState, events: [sessionEvent] })
      return { state: nextState, emitted: sessionEvent }
    }
    case "usage": {
      // Token usage is NOT a wire event on its own — it accumulates into
      // `state.lastTokenUsage` and gets spread onto the next
      // `turn.completed`. We still emit a `session.state.updated` so the
      // session view stays consistent, but we keep it cheap.
      const nextState: KernelSessionState = {
        ...args.state,
        revision: args.state.revision + 1,
        seq: args.state.seq + 1,
        lastTokenUsage: {
          ...(args.event.promptTokens !== undefined
            ? { promptTokens: args.event.promptTokens }
            : {}),
          ...(args.event.completionTokens !== undefined
            ? { completionTokens: args.event.completionTokens }
            : {}),
          ...(args.event.totalTokens !== undefined
            ? { totalTokens: args.event.totalTokens }
            : {}),
          ...(args.event.costMicroUsd !== undefined
            ? { costMicroUsd: args.event.costMicroUsd }
            : {}),
        },
      }
      const sessionEvent: SessionEvent = {
        eventId: crypto.randomUUID(),
        seq: nextState.seq,
        revision: nextState.revision,
        emittedAt: args.ctx.clock.now().toISOString(),
        causedByCommandId: args.command.commandId,
        type: "session.state.updated",
        state: toSessionStateView(nextState),
      }
      await appendEvents(args.ctx.eventLog, [sessionEvent])
      await args.ctx.onCommitted?.({ state: nextState, events: [sessionEvent] })
      return { state: nextState, emitted: sessionEvent }
    }
  }
}

const runTurn = async (args: {
  readonly state: KernelSessionState
  readonly command: TurnRunCommand
  readonly ctx: KernelDispatchContext
  readonly reduced: ReturnType<typeof reduceSessionCommand>
  readonly events: readonly SessionEvent[]
}): Promise<KernelDispatchResult> => {
  const hostAction = args.reduced.hostAction
  let streamState = args.state
  const streamedEvents: SessionEvent[] = []
  let pendingStream = Promise.resolve()
  try {
    const result = await args.ctx.host.runTurn({
      history: hostAction.kind === "run_turn" ? hostAction.history : args.state.messages,
      prompt: hostAction.kind === "run_turn" ? hostAction.prompt : "",
      ...(hostAction.kind === "run_turn" ? { images: hostAction.images } : {}),
      ...(args.ctx.signal !== undefined ? { signal: args.ctx.signal } : {}),
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
    return await onTurnFailed({
      state: streamState,
      command: args.command,
      error,
      ctx: args.ctx,
      events: [...args.events, ...streamedEvents],
    })
  }
}

export const dispatchSessionCommand = async (
  state: KernelSessionState,
  command: SessionCommand,
  ctx: KernelDispatchContext,
): Promise<KernelDispatchResult> =>
  await state.lease.runWith(command.commandId, async () => {
    const emittedAt = ctx.clock.now().toISOString()
    const reduced = reduceSessionCommand(state, command, emittedAt)
    const immediateEvents = [...reduced.events]
    const nextState: KernelSessionState = {
      ...reduced.state,
      seq: state.seq + immediateEvents.length,
    }
    await appendEvents(ctx.eventLog, immediateEvents)
    await ctx.onCommitted?.({ state: nextState, events: immediateEvents })

    switch (command.type) {
      case "session.identity.set":
        await ctx.host.setIdentityMode?.(command.mode)
        return { state: nextState, events: immediateEvents }
      case "session.tool_profile.set":
        await ctx.host.setToolProfile?.(command.profile)
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
        })
        return { state: nextState, events: immediateEvents }
      case "turn.run":
        return await runTurn({
          state: nextState,
          command,
          ctx,
          reduced,
          events: immediateEvents,
        })
      default:
        return { state: nextState, events: immediateEvents }
    }
  })
