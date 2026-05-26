import type { ImageBlock, Message } from "@/llm"
import type { ApprovalRespondCommand, SessionCommand, SessionEvent } from "@/protocol/session"
import { SessionProtocolValidationError, SessionRevisionConflictError } from "@/protocol/session"
import { type KernelSessionState, summarizeTranscript, toSessionStateView } from "./state"

type HostAction =
  | { readonly kind: "none" }
  | {
      readonly kind: "run_turn"
      readonly history: readonly Message[]
      readonly prompt: string
      readonly images: readonly ImageBlock[]
    }

export interface ReducerResult {
  readonly state: KernelSessionState
  readonly events: readonly SessionEvent[]
  readonly hostAction: HostAction
}

const withRevision = (state: KernelSessionState): KernelSessionState => ({
  ...state,
  revision: state.revision + 1,
})

const appendDraft = (draft: string, next: string): string =>
  draft === "" ? next : `${draft}\n${next}`

const resolveApproval = (
  state: KernelSessionState,
  command: ApprovalRespondCommand,
): KernelSessionState => {
  if (state.pendingApproval === null || state.pendingApproval.approvalId !== command.approvalId) {
    throw new SessionProtocolValidationError("unknown_approval")
  }
  return withRevision({
    ...state,
    pendingApproval: null,
    status: "idle",
  })
}

export const reduceSessionCommand = (
  state: KernelSessionState,
  command: SessionCommand,
  emittedAt: string,
): ReducerResult => {
  if (state.status === "closed") {
    throw new SessionProtocolValidationError("session_closed")
  }
  if (command.expectedRevision !== undefined && command.expectedRevision !== state.revision) {
    throw new SessionRevisionConflictError(command.expectedRevision, state.revision)
  }

  switch (command.type) {
    case "input.append": {
      const nextState = withRevision({
        ...state,
        draftInput: appendDraft(state.draftInput, command.text),
        draftImages: [...state.draftImages, ...(command.images ?? [])],
      })
      return {
        state: nextState,
        hostAction: { kind: "none" },
        events: [
          {
            eventId: crypto.randomUUID(),
            seq: state.seq + 1,
            revision: nextState.revision,
            emittedAt,
            causedByCommandId: command.commandId,
            type: "session.state.updated",
            state: toSessionStateView(nextState),
          },
        ],
      }
    }
    case "session.identity.set": {
      const nextState = withRevision({
        ...state,
        identityMode: command.mode,
      })
      return {
        state: nextState,
        hostAction: { kind: "none" },
        events: [
          {
            eventId: crypto.randomUUID(),
            seq: state.seq + 1,
            revision: nextState.revision,
            emittedAt,
            causedByCommandId: command.commandId,
            type: "session.state.updated",
            state: toSessionStateView(nextState),
          },
        ],
      }
    }
    case "session.tool_profile.set": {
      const nextState = withRevision({
        ...state,
        toolProfile: command.profile,
      })
      return {
        state: nextState,
        hostAction: { kind: "none" },
        events: [
          {
            eventId: crypto.randomUUID(),
            seq: state.seq + 1,
            revision: nextState.revision,
            emittedAt,
            causedByCommandId: command.commandId,
            type: "session.state.updated",
            state: toSessionStateView(nextState),
          },
        ],
      }
    }
    case "session.transcript.replace": {
      if (state.status === "running" || state.pendingApproval !== null) {
        throw new SessionProtocolValidationError("transcript_replace_unavailable")
      }
      const nextMessages = [...command.messages]
      const { lastOutcomeReason: _lastOutcomeReason, ...stateWithoutOutcome } = state
      const nextState = withRevision({
        ...stateWithoutOutcome,
        status: "idle",
        messages: nextMessages,
        transcript: summarizeTranscript(nextMessages),
      })
      return {
        state: nextState,
        hostAction: { kind: "none" },
        events: [
          {
            eventId: crypto.randomUUID(),
            seq: state.seq + 1,
            revision: nextState.revision,
            emittedAt,
            causedByCommandId: command.commandId,
            type: "session.state.updated",
            state: toSessionStateView(nextState),
          },
        ],
      }
    }
    case "approval.respond": {
      const nextState = resolveApproval(state, command)
      return {
        state: nextState,
        hostAction: { kind: "none" },
        events: [
          {
            eventId: crypto.randomUUID(),
            seq: state.seq + 1,
            revision: nextState.revision,
            emittedAt,
            causedByCommandId: command.commandId,
            type: "approval.resolved",
            approvalId: command.approvalId,
            decision: command.decision,
          },
          {
            eventId: crypto.randomUUID(),
            seq: state.seq + 2,
            revision: nextState.revision,
            emittedAt,
            causedByCommandId: command.commandId,
            type: "session.state.updated",
            state: toSessionStateView(nextState),
          },
        ],
      }
    }
    case "turn.cancel":
      return { state, hostAction: { kind: "none" }, events: [] }
    case "turn.run": {
      if (state.draftInput.trim() === "") {
        throw new SessionProtocolValidationError("empty_turn_input")
      }
      const nextState = withRevision({
        ...state,
        status: "running",
      })
      return {
        state: nextState,
        hostAction: {
          kind: "run_turn",
          history: [...state.messages],
          prompt: state.draftInput,
          images: state.draftImages,
        },
        events: [
          {
            eventId: crypto.randomUUID(),
            seq: state.seq + 1,
            revision: nextState.revision,
            emittedAt,
            causedByCommandId: command.commandId,
            type: "turn.started",
            prompt: state.draftInput,
          },
          {
            eventId: crypto.randomUUID(),
            seq: state.seq + 2,
            revision: nextState.revision,
            emittedAt,
            causedByCommandId: command.commandId,
            type: "session.state.updated",
            state: toSessionStateView(nextState),
          },
        ],
      }
    }
  }
}
