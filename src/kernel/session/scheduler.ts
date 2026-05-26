import type { Message } from "@/llm"
import type { ArtifactRef, SessionCommand, SessionEvent, TurnRunCommand } from "@/protocol/session"
import { SessionProtocolValidationError } from "@/protocol/session"
import type { KernelDispatchContext, SessionHostTurnResult } from "./ports"
import { reduceSessionCommand } from "./reducer"
import { type KernelSessionState, summarizeTranscript, toSessionStateView } from "./state"

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
    transcript: summarizeTranscript(args.result.messages),
    lastOutcomeReason: args.result.outcome.reason,
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
    transcript: summarizeTranscript(args.result.messages),
    artifacts: [...args.state.artifacts, ...artifacts],
    lastOutcomeReason: args.result.outcome.reason,
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

const runTurn = async (args: {
  readonly state: KernelSessionState
  readonly command: TurnRunCommand
  readonly ctx: KernelDispatchContext
  readonly reduced: ReturnType<typeof reduceSessionCommand>
  readonly events: readonly SessionEvent[]
}): Promise<KernelDispatchResult> => {
  const hostAction = args.reduced.hostAction
  try {
    const result = await args.ctx.host.runTurn({
      history: hostAction.kind === "run_turn" ? hostAction.history : args.state.messages,
      prompt: hostAction.kind === "run_turn" ? hostAction.prompt : "",
      ...(hostAction.kind === "run_turn" ? { images: hostAction.images } : {}),
      ...(args.ctx.signal !== undefined ? { signal: args.ctx.signal } : {}),
    })
    return result.approvalRequest !== undefined
      ? await onApprovalRequested({
          state: args.state,
          command: args.command,
          result,
          ctx: args.ctx,
          events: args.events,
        })
      : await onTurnCompleted({
          state: args.state,
          command: args.command,
          result,
          ctx: args.ctx,
          events: args.events,
        })
  } catch (error) {
    return await onTurnFailed({
      state: args.state,
      command: args.command,
      error,
      ctx: args.ctx,
      events: args.events,
    })
  }
}

export const dispatchSessionCommand = async (
  state: KernelSessionState,
  command: SessionCommand,
  ctx: KernelDispatchContext,
): Promise<KernelDispatchResult> => {
  const emittedAt = ctx.clock.now().toISOString()
  const reduced = reduceSessionCommand(state, command, emittedAt)
  const immediateEvents = [...reduced.events]
  const nextState: KernelSessionState = {
    ...reduced.state,
    seq: state.seq + immediateEvents.length,
  }
  await appendEvents(ctx.eventLog, immediateEvents)

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
}
