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

/** `input.append` — extracted from the reducer switch so each command owns one
 *  function. `Extract` restores the narrowing the switch used to provide. */
const handleInputAppend = (
  state: KernelSessionState,
  command: Extract<SessionCommand, { type: "input.append" }>,
  emittedAt: string,
): ReducerResult => {
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

/** `session.identity.set` — extracted from the reducer switch so each command owns one
 *  function. `Extract` restores the narrowing the switch used to provide. */
const handleSessionIdentitySet = (
  state: KernelSessionState,
  command: Extract<SessionCommand, { type: "session.identity.set" }>,
  emittedAt: string,
): ReducerResult => {
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

/** `session.tool_profile.set` — extracted from the reducer switch so each command owns one
 *  function. `Extract` restores the narrowing the switch used to provide. */
const handleSessionToolProfileSet = (
  state: KernelSessionState,
  command: Extract<SessionCommand, { type: "session.tool_profile.set" }>,
  emittedAt: string,
): ReducerResult => {
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

/** `session.permission.set` — extracted from the reducer switch so each command owns one
 *  function. `Extract` restores the narrowing the switch used to provide. */
const handleSessionPermissionSet = (
  state: KernelSessionState,
  command: Extract<SessionCommand, { type: "session.permission.set" }>,
  emittedAt: string,
): ReducerResult => {
  const nextState = withRevision({
    ...state,
    permissionMode: command.mode,
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

/** `session.posture.set` — extracted from the reducer switch so each command owns one
 *  function. `Extract` restores the narrowing the switch used to provide. */
const handleSessionPostureSet = (
  state: KernelSessionState,
  command: Extract<SessionCommand, { type: "session.posture.set" }>,
  emittedAt: string,
): ReducerResult => {
  // RFC-05 E4 — the POSTURE domain state lives in the host authority (E2/E3),
  // NOT in `KernelSessionState`; the reducer is NOT the restore authority
  // (§E4 stop rule) — it projects only. It bumps the SESSION revision and
  // emits ONE state echo so subscribers observe the command was processed;
  // the SCHEDULER applies the mutation to the host projection under CAS and
  // reconciles the resolved posture echo onto this event. A negative outcome
  // (unsupported host / stale) is thrown by the scheduler before this echo is
  // ever appended.
  const nextState = withRevision({ ...state })
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

/** `session.objective.mutate` — extracted from the reducer switch so each command owns one
 *  function. `Extract` restores the narrowing the switch used to provide. */
const handleSessionObjectiveMutate = (
  state: KernelSessionState,
  command: Extract<SessionCommand, { type: "session.objective.mutate" }>,
  emittedAt: string,
): ReducerResult => {
  // RFC-03 C3 — the objective DOMAIN state lives in the host authority, not
  // in `KernelSessionState`; the kernel owns only the session revision echo
  // (mirrors `session.permission.set`, whose live cell is also host-owned).
  // The reducer bumps the session revision + emits a state echo so
  // subscribers observe the command was processed; the SCHEDULER applies the
  // mutation to the host authority (actor `user`, CAS on the command's
  // `expectedRevision`). A stale objective CAS is the authority's concern —
  // it no-ops without corrupting kernel state.
  const nextState = withRevision({ ...state })
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

/** `session.skill.set_enabled` — extracted from the reducer switch so each command owns one
 *  function. `Extract` restores the narrowing the switch used to provide. */
const handleSessionSkillSetEnabled = (
  state: KernelSessionState,
  command: Extract<SessionCommand, { type: "session.skill.set_enabled" }>,
  emittedAt: string,
): ReducerResult => {
  // RFC-06 F5 — the SKILL disabled-set DOMAIN state lives in the F1 authority
  // (durable disabled-set + unified revision), NOT in `KernelSessionState`;
  // the kernel owns only the session revision echo (mirrors
  // `session.objective.mutate` / `session.posture.set`, whose live cells are
  // also host-owned). The reducer bumps the session revision + emits a state
  // echo so subscribers observe the command was processed; the SCHEDULER
  // applies the CAS mutation to the host authority. A negative outcome
  // (unsupported host / stale / policy / persist) is thrown by the scheduler
  // BEFORE this echo is ever appended.
  const nextState = withRevision({ ...state })
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

/** `session.transcript.replace` — extracted from the reducer switch so each command owns one
 *  function. `Extract` restores the narrowing the switch used to provide. */
const handleSessionTranscriptReplace = (
  state: KernelSessionState,
  command: Extract<SessionCommand, { type: "session.transcript.replace" }>,
  emittedAt: string,
): ReducerResult => {
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

/** `approval.respond` — extracted from the reducer switch so each command owns one
 *  function. `Extract` restores the narrowing the switch used to provide. */
const handleApprovalRespond = (
  state: KernelSessionState,
  command: Extract<SessionCommand, { type: "approval.respond" }>,
  emittedAt: string,
): ReducerResult => {
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

/** `turn.cancel` — extracted from the reducer switch so each command owns one
 *  function. `Extract` restores the narrowing the switch used to provide. */
const handleTurnCancel = (
  state: KernelSessionState,
  command: Extract<SessionCommand, { type: "turn.cancel" }>,
  emittedAt: string,
): ReducerResult => {
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

/** `turn.run` — extracted from the reducer switch so each command owns one
 *  function. `Extract` restores the narrowing the switch used to provide. */
const startTurn = (
  state: KernelSessionState,
  command: Extract<SessionCommand, { type: "turn.run" | "turn.submit" }>,
  emittedAt: string,
  prompt: string,
  images: readonly ImageBlock[],
): ReducerResult => {
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
      prompt,
      images,
    },
    events: [
      {
        eventId: crypto.randomUUID(),
        seq: state.seq + 1,
        revision: nextState.revision,
        emittedAt,
        causedByCommandId: command.commandId,
        type: "turn.started",
        prompt,
        ...(images.length > 0 ? { images } : {}),
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

const handleTurnRun = (
  state: KernelSessionState,
  command: Extract<SessionCommand, { type: "turn.run" }>,
  emittedAt: string,
): ReducerResult => {
  // GOAL P0-1 — the post-approval resume. A `turn.run` normally re-runs the
  // draft the pause preserved; a `turn.submit` leaves no draft, so before this
  // the approved goal work died here as `empty_turn_input` and the daemon
  // logged it as a benign duplicate. The kernel now re-runs exactly what it
  // paused (host-owned record; a client cannot set or forge it).
  const resumed = state.pausedTurn
  if (!hasDraftTurnInput(state)) {
    if (resumed === undefined) throw new SessionProtocolValidationError("empty_turn_input")
    return startTurn(state, command, emittedAt, resumed.prompt, resumed.images)
  }
  return startTurn(state, command, emittedAt, state.draftInput, state.draftImages)
}

const handleTurnSubmit = (
  state: KernelSessionState,
  command: Extract<SessionCommand, { type: "turn.submit" }>,
  emittedAt: string,
): ReducerResult => {
  if (command.expectedSessionRevision !== state.revision) {
    throw new SessionRevisionConflictError(command.expectedSessionRevision, state.revision)
  }
  if (state.pendingApproval !== null) {
    throw new SessionProtocolValidationError("turn_submit_approval_pending")
  }
  if (state.status !== "idle") {
    throw new SessionProtocolValidationError("turn_submit_not_idle")
  }
  if (hasDraftTurnInput(state)) {
    throw new SessionProtocolValidationError("turn_submit_draft_not_empty")
  }
  if (command.text.trim().length === 0 && (command.images?.length ?? 0) === 0) {
    throw new SessionProtocolValidationError("empty_turn_input")
  }
  return startTurn(state, command, emittedAt, command.text, command.images ?? [])
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
    case "input.append":
      return handleInputAppend(state, command, emittedAt)
    case "session.identity.set":
      return handleSessionIdentitySet(state, command, emittedAt)
    case "session.tool_profile.set":
      return handleSessionToolProfileSet(state, command, emittedAt)
    case "session.permission.set":
      return handleSessionPermissionSet(state, command, emittedAt)
    case "session.posture.set":
      return handleSessionPostureSet(state, command, emittedAt)
    case "session.objective.mutate":
      return handleSessionObjectiveMutate(state, command, emittedAt)
    case "session.skill.set_enabled":
      return handleSessionSkillSetEnabled(state, command, emittedAt)
    case "session.transcript.replace":
      return handleSessionTranscriptReplace(state, command, emittedAt)
    case "approval.respond":
      return handleApprovalRespond(state, command, emittedAt)
    case "turn.cancel":
      return handleTurnCancel(state, command, emittedAt)
    case "turn.run":
      return handleTurnRun(state, command, emittedAt)
    case "turn.submit":
      return handleTurnSubmit(state, command, emittedAt)
  }
}
