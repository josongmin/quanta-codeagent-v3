import type { Message } from "@/llm"
import type { ArtifactRef, SessionCommand, SessionEvent } from "@/protocol/session"
import type { KernelDispatchContext } from "./ports"
import { reduceSessionCommand } from "./reducer"
import { type KernelSessionState, toSessionStateView } from "./state"

const appendEvents = async (
  eventLog: KernelDispatchContext["eventLog"],
  events: readonly SessionEvent[],
): Promise<void> => {
  for (const event of events) await eventLog.append(event)
}

const lastTextBlock = (message: Message | undefined): string | undefined => {
  if (message === undefined) return undefined
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
}

const extractTranscript = (messages: readonly Message[]) => {
  const lastUser = [...messages].reverse().find((message) => message.role === "user")
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant")
  const lastUserText = lastTextBlock(lastUser)
  const lastAssistantText = lastTextBlock(lastAssistant)
  return {
    messageCount: messages.length,
    ...(lastUserText !== undefined ? { lastUserText } : {}),
    ...(lastAssistantText !== undefined ? { lastAssistantText } : {}),
  }
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
}

export const dispatchSessionCommand = async (
  state: KernelSessionState,
  command: SessionCommand,
  ctx: KernelDispatchContext,
): Promise<KernelDispatchResult> => {
  const emittedAt = ctx.clock.now().toISOString()
  const reduced = reduceSessionCommand(state, command, emittedAt)
  const immediateEvents = [...reduced.events]
  let nextState: KernelSessionState = {
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
    case "turn.run": {
      try {
        const result = await ctx.host.runTurn({
          prompt: reduced.hostAction.kind === "run_turn" ? reduced.hostAction.prompt : "",
          ...(reduced.hostAction.kind === "run_turn" ? { images: reduced.hostAction.images } : {}),
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        })
        if (result.approvalRequest !== undefined) {
          nextState = {
            ...nextState,
            revision: nextState.revision + 1,
            seq: nextState.seq + 2,
            status: "awaiting_approval",
            pendingApproval: result.approvalRequest,
          }
          const approvalEvents: SessionEvent[] = [
            {
              eventId: crypto.randomUUID(),
              seq: nextState.seq - 1,
              revision: nextState.revision,
              emittedAt: ctx.clock.now().toISOString(),
              causedByCommandId: command.commandId,
              type: "approval.requested",
              approval: result.approvalRequest,
            },
            {
              eventId: crypto.randomUUID(),
              seq: nextState.seq,
              revision: nextState.revision,
              emittedAt: ctx.clock.now().toISOString(),
              causedByCommandId: command.commandId,
              type: "session.state.updated",
              state: toSessionStateView(nextState),
            },
          ]
          await appendEvents(ctx.eventLog, approvalEvents)
          return { state: nextState, events: [...immediateEvents, ...approvalEvents] }
        }
        const artifacts = [...(result.artifacts ?? [])]
        nextState = {
          ...nextState,
          revision: nextState.revision + 1,
          status: "idle",
          draftInput: "",
          draftImages: [],
          pendingApproval: null,
          transcript: extractTranscript(result.messages),
          artifacts: [...nextState.artifacts, ...artifacts],
          lastOutcomeReason: result.outcome.reason,
        }
        const emitted = ctx.clock.now().toISOString()
        const artifactEvents = readyEvents({
          state: nextState,
          commandId: command.commandId,
          emittedAt: emitted,
          artifacts,
        })
        const completionSeq = nextState.seq + artifactEvents.length + 1
        const completionEvents: SessionEvent[] = [
          ...artifactEvents,
          {
            eventId: crypto.randomUUID(),
            seq: completionSeq,
            revision: nextState.revision,
            emittedAt: emitted,
            causedByCommandId: command.commandId,
            type: "turn.completed",
            outcomeReason: result.outcome.reason,
          },
          {
            eventId: crypto.randomUUID(),
            seq: completionSeq + 1,
            revision: nextState.revision,
            emittedAt: emitted,
            causedByCommandId: command.commandId,
            type: "session.state.updated",
            state: toSessionStateView(nextState),
          },
        ]
        nextState = {
          ...nextState,
          seq: completionSeq + 1,
        }
        await appendEvents(ctx.eventLog, completionEvents)
        return { state: nextState, events: [...immediateEvents, ...completionEvents] }
      } catch (error) {
        nextState = {
          ...nextState,
          revision: nextState.revision + 1,
          seq: nextState.seq + 2,
          status: "failed",
          lastOutcomeReason: "error",
        }
        const failedEvents: SessionEvent[] = [
          {
            eventId: crypto.randomUUID(),
            seq: nextState.seq - 1,
            revision: nextState.revision,
            emittedAt: ctx.clock.now().toISOString(),
            causedByCommandId: command.commandId,
            type: "turn.failed",
            message: error instanceof Error ? error.message : String(error),
          },
          {
            eventId: crypto.randomUUID(),
            seq: nextState.seq,
            revision: nextState.revision,
            emittedAt: ctx.clock.now().toISOString(),
            causedByCommandId: command.commandId,
            type: "session.state.updated",
            state: toSessionStateView(nextState),
          },
        ]
        await appendEvents(ctx.eventLog, failedEvents)
        return { state: nextState, events: [...immediateEvents, ...failedEvents] }
      }
    }
    default:
      return { state: nextState, events: immediateEvents }
  }
}
