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
  /** T03 — the reducer OWNS the cancel decision; the scheduler is the sole
   *  executor that aborts the live turn-owned controller. The reducer never
   *  reaches into a controller itself (it stays pure) — it only declares that
   *  the active turn (if any) must be torn down. */
  | { readonly kind: "cancel_turn" }

export interface ReducerResult {
  readonly state: KernelSessionState
  readonly events: readonly SessionEvent[]
  readonly hostAction: HostAction
}

const withRevision = (state: KernelSessionState): KernelSessionState => ({
  ...state,
  revision: state.revision + 1,
})

const clearStreamingAssistantText = (
  transcript: KernelSessionState["transcript"],
): KernelSessionState["transcript"] => {
  const { streamingAssistantText: _streamingAssistantText, ...rest } = transcript
  return rest
}

const appendDraft = (draft: string, next: string): string =>
  draft === "" ? next : `${draft}\n${next}`

const hasDraftTurnInput = (state: KernelSessionState): boolean =>
  state.draftInput.trim().length > 0 || state.draftImages.length > 0

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
    ...(command.decision === "deny"
      ? {
          draftInput: "",
          draftImages: [],
        }
      : {}),
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
      const {
        lastOutcomeReason: _lastOutcomeReason,
        lastLlmRequest: _lastLlmRequest,
        lastLlmContinuation: _lastLlmContinuation,
        ...stateWithoutOutcome
      } = state
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
    case "turn.cancel": {
      // T03 (audit L5 C-1): the handler is no longer inert. When a turn is in
      // flight (running / awaiting an approval) cancel transitions session
      // status back to `idle`, clears any pending approval + streaming draft,
      // and emits a state echo so subscribers observe the cancellation. The
      // `cancel_turn` hostAction tells the scheduler to abort the SAME
      // turn-owned controller the active host work is observing. When the
      // session is already idle/failed there is nothing to tear down — we still
      // surface a `cancel_turn` so the scheduler can no-op the (absent) live
      // controller deterministically, but we leave state untouched.
      const hasActiveTurn = state.status === "running" || state.status === "awaiting_approval"
      if (!hasActiveTurn) {
        return { state, hostAction: { kind: "cancel_turn" }, events: [] }
      }
      const nextState = withRevision({
        ...state,
        status: "idle",
        pendingApproval: null,
        transcript: clearStreamingAssistantText(state.transcript),
        lastOutcomeReason: "aborted",
      })
      return {
        state: nextState,
        hostAction: { kind: "cancel_turn" },
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
    case "turn.run": {
      if (!hasDraftTurnInput(state)) {
        throw new SessionProtocolValidationError("empty_turn_input")
      }
      const nextState = withRevision({
        ...state,
        status: "running",
        transcript: clearStreamingAssistantText(state.transcript),
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
            ...(state.draftImages.length > 0 ? { images: state.draftImages } : {}),
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
