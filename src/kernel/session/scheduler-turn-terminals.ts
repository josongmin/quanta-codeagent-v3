import type { Message } from "@/llm"
import type { ArtifactRef, SessionEvent, TurnRunCommand } from "@/protocol/session"
import { SessionProtocolValidationError } from "@/protocol/session"
import { isAbort } from "@/shared/abortable"
import type { KernelDispatchContext, SessionHostTurnResult } from "./ports"
import { appendEvents, appendTerminalEvents } from "./scheduler-append-isolation"
import {
  type KernelSessionState,
  type KernelTranscriptState,
  summarizeTranscript,
  toSessionStateView,
} from "./state"

/**
 * Turn TERMINAL settlement — the four ways a `turn.run` ends.
 *
 * ONE responsibility: turn a host outcome (approval-requested / completed /
 * aborted / failed / errored) into the committed next {@link KernelSessionState}
 * plus the exact terminal event pair the subscriber sees. Every handler here has
 * the same shape — derive next state, build events, persist through the
 * isolation layer, RETURN a {@link KernelDispatchResult} — and
 * {@link classifyTerminal} is the SSOT both the success arm and the throw arm of
 * the executor consult, so a cancel settles identically whether the host threw
 * or returned.
 *
 * The executor (`scheduler-turn-execution.ts`) decides WHICH terminal; this
 * module owns WHAT each terminal commits. `KernelDispatchResult` is defined here
 * because it is that settlement contract, and is re-exported unchanged from
 * `scheduler.ts`.
 *
 * Split out of `scheduler.ts` (god-module ratchet) — pure move, no logic change.
 */
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

export const onApprovalRequested = async (args: {
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

export const onTurnCompleted = async (args: {
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
  // B1 — persist-BUT-still-deliver: a durable-log throw here must not lose the
  // completed turn nor hang `awaitTurnEnd`. The events are RETURNED regardless.
  await appendTerminalEvents(args.ctx.eventLog, completionEvents)
  return {
    state: nextState,
    events: [...args.events, ...completionEvents],
    turnResult: args.result,
    transcriptMessages: [...args.result.messages],
  }
}

/**
 * ALBB-04 — terminal-classification SSOT. ONE predicate consulted by BOTH the
 * success arm (host RETURNED an outcome) and the catch arm (host THREW) so a
 * cancellation resolves to the SAME settlement regardless of throw-vs-return.
 * Patching a single branch would leave the two paths free to drift again; this
 * function is the single source of truth for "which terminal is this?".
 *
 *   - `"aborted"`   — cooperative cancel: the host RETURNED
 *                     `outcome.reason === "aborted"`, OR it THREW and the throw
 *                     is an abort (`isAbort`) / the turn controller is aborted.
 *   - `"error"`     — the host RETURNED `outcome.reason === "error"`.
 *   - `"completed"` — everything else (a normal successful return). The catch
 *                     arm never reaches this arm — a non-abort throw is a
 *                     `"failed"` classification handled by the caller directly.
 */
export const classifyTerminal = (args: {
  readonly outcome?: { readonly reason: string }
  readonly error?: unknown
  readonly aborted: boolean
}): "aborted" | "error" | "completed" => {
  if (args.error !== undefined) {
    return isAbort(args.error) || args.aborted ? "aborted" : "completed"
  }
  // ALBB-04 P2 (narrowed): on the SUCCESS arm (host RETURNED an outcome) a turn
  // is a cancel ONLY when the host itself reported `outcome.reason === "aborted"`.
  // Previously a NORMAL completion that merely RACED with `signal.aborted` (e.g.
  // an external abort landing after the host already produced its result) was
  // misclassified `"aborted"`, routing a successful turn's messages through the
  // cancel terminal. The throw arm above still honors `aborted` because a raced
  // abort there means the host work did NOT complete.
  if (args.outcome?.reason === "aborted") return "aborted"
  if (args.outcome?.reason === "error") return "error"
  return "completed"
}

/** T03 / ALBB-04 — a turn whose host work was cancelled (the host either THREW
 *  because its controller was aborted, or cooperatively RETURNED
 *  `outcome.reason === "aborted"`) is a CANCELLATION, not a success and not a
 *  failure. Both entry points converge HERE via {@link classifyTerminal}. We
 *  settle status `idle` with `lastOutcomeReason: "aborted"` and emit the
 *  DEDICATED `turn.aborted` terminal wire event (ALBB-04) — distinct from both
 *  `turn.completed` and `turn.failed` — so no downstream consumer conflates a
 *  cancel with success or error. `error` carries the throw reason for the
 *  throw path; `message` falls back to a stable "turn aborted" label. */
export const onTurnAborted = async (args: {
  readonly state: KernelSessionState
  readonly command: TurnRunCommand
  readonly error?: unknown
  /** ALBB-04 P2 — present ONLY on the cooperative RETURN-abort path (host
   *  RETURNED `outcome.reason === "aborted"` WITH accumulated messages, e.g. a
   *  budget/deadline abort that still surfaces output). When present its
   *  `messages` MUST be committed into kernel state (mirroring
   *  `onTurnCompleted`) — otherwise the accumulated transcript is silently
   *  discarded back to the pre-turn set. Absent on the throw-abort and
   *  pre-host-start paths (no messages exist to lose). */
  readonly result?: SessionHostTurnResult
  readonly ctx: KernelDispatchContext
  readonly events: readonly SessionEvent[]
}): Promise<KernelDispatchResult> => {
  // ALBB-04 P2 — SETTLE the accumulated state exactly like `onTurnCompleted`
  // when the host cooperatively RETURNED messages: commit `result.messages`,
  // clear the turn-seeding draft, re-summarize the transcript from the surfaced
  // messages, and carry any token usage. When there is NO result (throw-abort /
  // pre-host-start) the pre-turn state is preserved verbatim — there are no
  // messages to lose. We STILL emit the dedicated `turn.aborted` terminal in
  // both cases (do not revert ALBB-04's wire-shape fix).
  const settled = args.result
  const nextState: KernelSessionState = {
    ...args.state,
    revision: args.state.revision + 1,
    seq: args.state.seq + 2,
    status: "idle",
    pendingApproval: null,
    ...(settled !== undefined
      ? {
          messages: [...settled.messages],
          draftInput: "",
          draftImages: [],
          transcript: clearStreamingAssistantText(summarizeTranscript(settled.messages)),
          ...(settled.tokenUsage !== undefined ? { lastTokenUsage: settled.tokenUsage } : {}),
        }
      : {
          transcript: clearStreamingAssistantText(args.state.transcript),
        }),
    lastOutcomeReason: "aborted",
  }
  const abortedEvents: SessionEvent[] = [
    {
      eventId: crypto.randomUUID(),
      seq: nextState.seq - 1,
      revision: nextState.revision,
      emittedAt: args.ctx.clock.now().toISOString(),
      causedByCommandId: args.command.commandId,
      type: "turn.aborted",
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
  // B1 — terminal delivery is decoupled from persistence (see appendTerminalEvents).
  await appendTerminalEvents(args.ctx.eventLog, abortedEvents)
  return {
    state: nextState,
    events: [...args.events, ...abortedEvents],
    ...(settled !== undefined
      ? { turnResult: settled, transcriptMessages: [...settled.messages] }
      : {}),
  }
}

export const onTurnFailed = async (args: {
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
  // B1 — terminal delivery is decoupled from persistence (see appendTerminalEvents).
  await appendTerminalEvents(args.ctx.eventLog, failedEvents)
  return { state: nextState, events: [...args.events, ...failedEvents] }
}

export const onTurnErrored = async (args: {
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
  // B1 — terminal delivery is decoupled from persistence (see appendTerminalEvents).
  await appendTerminalEvents(args.ctx.eventLog, failedEvents)
  return {
    state: nextState,
    events: [...args.events, ...failedEvents],
    turnResult: args.result,
    transcriptMessages: [...args.result.messages],
  }
}
