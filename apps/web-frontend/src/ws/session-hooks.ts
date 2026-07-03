/**
 * React hooks layer over `SessionClient`.
 *
 * These hooks own the React-y plumbing — `useEffect`-based subscription
 * lifetimes, state mirroring, and the small reducer that turns a stream of
 * `SessionEvent`s into a `UiMessage[]` chat transcript.
 *
 * The hooks do NOT own the SessionClient itself — the App constructs a
 * single client and passes it in. That keeps the client testable in
 * isolation and avoids React-tree-scoped reconnect loops.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import type {
  ConnectionState,
  ImageBlock,
  SessionCommand,
  SessionEvent,
  SessionEventType,
  SessionRejectedFrame,
  SessionSnapshotLite,
  SessionStateView,
  UiMessage,
} from "../types/protocol"
import type { SessionClient } from "./client"

/**
 * `useConnectionState` — mirrors the client's connection state into React
 * state. The client replays its current state on subscribe so the first
 * render is consistent with the live socket.
 */
export const useConnectionState = (client: SessionClient): ConnectionState => {
  const [state, setState] = useState<ConnectionState>(() => client.state)
  useEffect(() => {
    const unsub = client.onConnectionChange(setState)
    return unsub
  }, [client])
  return state
}

/* ------------------------------------------------------------------ */
/* Transcript reducer                                                  */
/* ------------------------------------------------------------------ */

type TranscriptAction =
  | { type: "session_event"; event: SessionEvent }
  | { type: "snapshot"; snapshot: SessionSnapshotLite; receivedAt: string }
  | { type: "rejected"; frame: SessionRejectedFrame; timestamp: string }
  | { type: "reset" }
  | {
      type: "client_message"
      role: "system" | "error"
      text: string
      timestamp: string
    }

interface PendingCompletion {
  readonly eventId: string
  readonly outcomeReason: string
  readonly assistantText?: string
  readonly timestamp: string
}

interface StreamingAssistant {
  readonly id: string
  readonly text: string
  readonly timestamp: string
}

/** Cumulative token counter — sums `turn.completed.tokenUsage` across the
 *  life of this transcript so the header can render running totals. */
export interface CumulativeTokenUsage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
  readonly costMicroUsd: number
  readonly turns: number
}

export interface TranscriptState {
  readonly messages: readonly UiMessage[]
  readonly lastAssistantSignature: string | null
  readonly streamingAssistant: StreamingAssistant | null
  readonly pendingCompletion: PendingCompletion | null
  readonly fallbackCompletion: PendingCompletion | null
  /** Server-reported active model slug (from `session.created.model`). */
  readonly modelSlug: string | null
  /** Cumulative token usage. Updated on every `turn.completed` carrying a
   *  `tokenUsage` payload. Adapters that don't emit usage leave this at
   *  zero / undefined turn-count. */
  readonly tokenUsage: CumulativeTokenUsage
}

const ZERO_USAGE: CumulativeTokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costMicroUsd: 0,
  turns: 0,
}

export const initialTranscript: TranscriptState = {
  messages: [],
  lastAssistantSignature: null,
  streamingAssistant: null,
  pendingCompletion: null,
  fallbackCompletion: null,
  modelSlug: null,
  tokenUsage: ZERO_USAGE,
}

const appendTranscriptMessage = (state: TranscriptState, message: UiMessage): TranscriptState => ({
  ...state,
  messages: [...state.messages, message],
})

const assistantSignatureFromState = (state: SessionStateView): string | null => {
  if (typeof state.lastAssistantText !== "string" || state.lastAssistantText.length === 0) {
    return null
  }
  return `${String(state.messageCount)}:${state.lastAssistantText}`
}

const reconcileStreamingAssistant = (
  state: TranscriptState,
  text: string,
  timestamp: string,
  id: string,
): TranscriptState => {
  const nextStreaming = { id, text, timestamp }
  const lastMessage = state.messages.at(-1)
  if (
    lastMessage?.role === "assistant" &&
    state.streamingAssistant !== null &&
    lastMessage.id === state.streamingAssistant.id
  ) {
    return {
      ...state,
      streamingAssistant: nextStreaming,
      messages: [
        ...state.messages.slice(0, -1),
        {
          ...lastMessage,
          id,
          text,
          timestamp: state.streamingAssistant.timestamp,
        },
      ],
    }
  }
  return {
    ...state,
    streamingAssistant: nextStreaming,
    messages: [
      ...state.messages,
      {
        id,
        role: "assistant",
        text,
        timestamp,
      },
    ],
  }
}

const pendingCompletionMessage = (pending: PendingCompletion): UiMessage => ({
  id: pending.eventId,
  role: "assistant",
  text: fallbackTextOf(pending),
  timestamp: pending.timestamp,
})

const fallbackTextOf = (pending: PendingCompletion): string =>
  pending.assistantText !== undefined && pending.assistantText.length > 0
    ? pending.assistantText
    : pending.outcomeReason.length > 0
      ? pending.outcomeReason
      : "(turn completed)"

const clearCompletionTracking = (
  state: TranscriptState,
  lastAssistantSignature: string | null = state.lastAssistantSignature,
): TranscriptState => ({
  ...state,
  lastAssistantSignature,
  streamingAssistant: null,
  pendingCompletion: null,
  fallbackCompletion: null,
})

const appendFinalAssistantMessage = (args: {
  readonly state: TranscriptState
  readonly text: string
  readonly timestamp: string
  readonly eventId?: string
  readonly fallback: PendingCompletion | null
  readonly signature: string
}): TranscriptState =>
  appendTranscriptMessage(clearCompletionTracking(args.state, args.signature), {
    id: args.fallback?.eventId ?? args.eventId ?? `assistant-${args.timestamp}`,
    role: "assistant",
    text: args.text,
    timestamp: args.fallback?.timestamp ?? args.timestamp,
  })

const repairTrailingAssistantMessage = (args: {
  readonly state: TranscriptState
  readonly lastMessage: UiMessage
  readonly text: string
  readonly timestamp: string
  readonly signature: string
}): TranscriptState => ({
  ...clearCompletionTracking(args.state, args.signature),
  messages: [
    ...args.state.messages.slice(0, -1),
    {
      ...args.lastMessage,
      text: args.text,
      timestamp: args.timestamp,
    },
  ],
})

const applyStreamingSessionStateToTranscript = (
  state: TranscriptState,
  sessionState: SessionStateView,
  timestamp: string,
  eventId?: string,
): TranscriptState | null => {
  if (
    sessionState.status !== "running" ||
    typeof sessionState.streamingAssistantText !== "string" ||
    sessionState.streamingAssistantText.length === 0
  ) {
    return null
  }
  const streamingId =
    state.streamingAssistant?.id ??
    (eventId === undefined ? `assistant-stream-${timestamp}` : `assistant-stream-${eventId}`)
  return reconcileStreamingAssistant(
    state,
    sessionState.streamingAssistantText,
    state.streamingAssistant?.timestamp ?? timestamp,
    streamingId,
  )
}

const applyAssistantSignatureToTranscript = (args: {
  readonly state: TranscriptState
  readonly sessionState: SessionStateView
  readonly timestamp: string
  readonly eventId?: string
}): TranscriptState | null => {
  const signature = assistantSignatureFromState(args.sessionState)
  if (signature === null || signature === args.state.lastAssistantSignature) {
    return null
  }
  const text = args.sessionState.lastAssistantText ?? "(turn completed)"
  const lastMessage = args.state.messages.at(-1)
  if (
    args.state.streamingAssistant !== null &&
    lastMessage?.role === "assistant" &&
    lastMessage.id === args.state.streamingAssistant.id
  ) {
    return repairTrailingAssistantMessage({
      state: args.state,
      lastMessage,
      text,
      timestamp: args.state.streamingAssistant.timestamp,
      signature,
    })
  }
  const fallback = args.state.pendingCompletion ?? args.state.fallbackCompletion
  const fallbackText = fallback === null ? null : fallbackTextOf(fallback)
  const canRepairFallback =
    fallback !== null &&
    lastMessage?.role === "assistant" &&
    lastMessage.id === fallback.eventId &&
    lastMessage.text === fallbackText
  if (canRepairFallback && lastMessage !== undefined) {
    return repairTrailingAssistantMessage({
      state: args.state,
      lastMessage,
      text,
      timestamp: fallback.timestamp,
      signature,
    })
  }
  return appendFinalAssistantMessage({
    state: args.state,
    text,
    timestamp: args.timestamp,
    ...(args.eventId !== undefined ? { eventId: args.eventId } : {}),
    fallback,
    signature,
  })
}

const settlePendingCompletionOnIdle = (
  state: TranscriptState,
  sessionState: SessionStateView,
): TranscriptState | null => {
  if (state.pendingCompletion === null || sessionState.status !== "idle") {
    return null
  }
  const fallback = state.pendingCompletion
  const lastMessage = state.messages.at(-1)
  if (
    state.streamingAssistant !== null &&
    lastMessage?.role === "assistant" &&
    lastMessage.id === state.streamingAssistant.id
  ) {
    return {
      ...clearCompletionTracking(state),
      messages: [
        ...state.messages.slice(0, -1),
        {
          ...lastMessage,
          text:
            fallback.assistantText ??
            (lastMessage.text.length > 0 ? lastMessage.text : fallbackTextOf(fallback)),
        },
      ],
    }
  }
  return appendTranscriptMessage(
    {
      ...state,
      streamingAssistant: null,
      pendingCompletion: null,
      fallbackCompletion: fallback,
    },
    pendingCompletionMessage(fallback),
  )
}

const applySessionStateToTranscript = (
  state: TranscriptState,
  sessionState: SessionStateView,
  timestamp: string,
  eventId?: string,
): TranscriptState =>
  applyStreamingSessionStateToTranscript(state, sessionState, timestamp, eventId) ??
  applyAssistantSignatureToTranscript({
    state,
    sessionState,
    timestamp,
    ...(eventId !== undefined ? { eventId } : {}),
  }) ??
  settlePendingCompletionOnIdle(state, sessionState) ??
  state

const cloneImages = (images: readonly ImageBlock[]): readonly ImageBlock[] =>
  images.map((image) => ({ ...image }))

type TranscriptEventHandler<K extends SessionEventType> = (
  state: TranscriptState,
  event: Extract<SessionEvent, { type: K }>,
) => TranscriptState

type TranscriptEventHandlerRegistry = {
  [K in SessionEventType]?: TranscriptEventHandler<K>
}

export const TRANSCRIPT_MUTATING_SESSION_EVENT_TYPES = [
  "approval.requested",
  "session.closed",
  "session.created",
  "session.state.updated",
  "skill.scope.decision",
  "tool.completed",
  "tool.invoked",
  "turn.completed",
  "turn.failed",
  "turn.output.delta",
  "turn.started",
] as const satisfies readonly SessionEventType[]

export const TRANSCRIPT_NOOP_SESSION_EVENT_TYPES = [
  "approval.resolved",
  "artifact.ready",
  "turn.llm.continuation",
  "turn.llm.request",
  // T01 — `item.*` fine-grained stream rides the SEPARATE agent-state item
  // channel, not the transcript reducer; transcript-noop is the forward-compat
  // posture (never corrupt the message list). A dedicated item renderer is a
  // follow-up — the wire contract + decode gate already accept them.
  "item.started",
  "item.delta",
  "item.completed",
] as const satisfies readonly SessionEventType[]

const TRANSCRIPT_NOOP_SESSION_EVENT_TYPE_SET = new Set<string>(TRANSCRIPT_NOOP_SESSION_EVENT_TYPES)

const TRANSCRIPT_EVENT_HANDLERS = {
  "turn.started": (state, event) => ({
    ...appendTranscriptMessage(state, {
      id: event.eventId,
      role: "user",
      text: event.prompt,
      timestamp: event.emittedAt,
      ...(event.images !== undefined && event.images.length > 0
        ? { images: cloneImages(event.images) }
        : {}),
    }),
    streamingAssistant: null,
  }),
  "turn.output.delta": (state, event) => {
    const streamingId =
      state.streamingAssistant?.id ??
      (event.causedByCommandId === undefined
        ? `assistant-stream-${event.eventId}`
        : `assistant-stream-${event.causedByCommandId}`)
    const nextText =
      state.streamingAssistant !== null
        ? `${state.streamingAssistant.text}${event.delta}`
        : event.delta
    return reconcileStreamingAssistant(
      state,
      nextText,
      state.streamingAssistant?.timestamp ?? event.emittedAt,
      streamingId,
    )
  },
  "turn.completed": (state, event) => {
    const nextUsage =
      event.tokenUsage !== undefined
        ? {
            promptTokens: state.tokenUsage.promptTokens + (event.tokenUsage.promptTokens ?? 0),
            completionTokens:
              state.tokenUsage.completionTokens + (event.tokenUsage.completionTokens ?? 0),
            totalTokens: state.tokenUsage.totalTokens + (event.tokenUsage.totalTokens ?? 0),
            costMicroUsd: state.tokenUsage.costMicroUsd + (event.tokenUsage.costMicroUsd ?? 0),
            turns: state.tokenUsage.turns + 1,
          }
        : state.tokenUsage
    const nextModel =
      event.modelSlug !== undefined && event.modelSlug.length > 0
        ? event.modelSlug
        : state.modelSlug
    return {
      ...state,
      tokenUsage: nextUsage,
      modelSlug: nextModel,
      pendingCompletion: {
        eventId: event.eventId,
        outcomeReason: event.outcomeReason,
        ...(event.assistantText !== undefined ? { assistantText: event.assistantText } : {}),
        timestamp: event.emittedAt,
      },
      fallbackCompletion: null,
    }
  },
  "turn.failed": (state, event) =>
    appendTranscriptMessage(
      {
        ...state,
        streamingAssistant: null,
        pendingCompletion: null,
        fallbackCompletion: null,
      },
      {
        id: event.eventId,
        role: "error",
        text: event.message,
        timestamp: event.emittedAt,
      },
    ),
  "session.created": (state, event) =>
    appendTranscriptMessage(
      event.model !== undefined && event.model.length > 0
        ? { ...state, modelSlug: event.model }
        : state,
      {
        id: event.eventId,
        role: "system",
        text:
          event.model !== undefined && event.model.length > 0
            ? `session created · model=${event.model} · transport=${event.capabilityManifest.transport}`
            : `session created (transport=${event.capabilityManifest.transport})`,
        timestamp: event.emittedAt,
      },
    ),
  "session.state.updated": (state, event) =>
    applySessionStateToTranscript(state, event.state, event.emittedAt, event.eventId),
  "session.closed": (state, event) =>
    appendTranscriptMessage(state, {
      id: event.eventId,
      role: "system",
      text: "session closed",
      timestamp: event.emittedAt,
    }),
  "approval.requested": (state, event) =>
    appendTranscriptMessage(state, {
      id: event.eventId,
      role: "system",
      text: `approval requested: ${event.approval.reason}`,
      timestamp: event.emittedAt,
    }),
  "tool.invoked": (state, event) =>
    appendTranscriptMessage(state, {
      id: event.eventId,
      role: "system",
      text: renderToolInvoked(event.toolName, event.argsPreview),
      timestamp: event.emittedAt,
    }),
  "tool.completed": (state, event) =>
    appendTranscriptMessage(state, {
      id: event.eventId,
      role: event.outcome === "error" || event.outcome === "denied" ? "error" : "system",
      text: renderToolCompleted(
        event.toolName,
        event.outcome,
        event.resultPreview,
        event.durationMs,
      ),
      timestamp: event.emittedAt,
    }),
  "skill.scope.decision": (state, event) =>
    appendTranscriptMessage(state, {
      id: event.eventId,
      role: "system",
      text: renderSkillScopeDecision(event.tool, event.activeSkill, event.decision),
      timestamp: event.emittedAt,
    }),
} as const satisfies TranscriptEventHandlerRegistry

export const applyUnsupportedSessionEventToTranscript = (
  state: TranscriptState,
  _event: SessionEvent,
): TranscriptState => state

const isExplicitTranscriptNoopSessionEventType = (
  type: SessionEventType,
): type is (typeof TRANSCRIPT_NOOP_SESSION_EVENT_TYPES)[number] =>
  TRANSCRIPT_NOOP_SESSION_EVENT_TYPE_SET.has(type)

export const applySessionEventToTranscript = (
  state: TranscriptState,
  event: SessionEvent,
): TranscriptState => {
  const handler = (TRANSCRIPT_EVENT_HANDLERS as TranscriptEventHandlerRegistry)[event.type] as
    | ((state: TranscriptState, event: SessionEvent) => TranscriptState)
    | undefined
  if (handler !== undefined) {
    return handler(state, event)
  }
  if (isExplicitTranscriptNoopSessionEventType(event.type)) {
    return state
  }
  // Forward-compat: an unknown / newly-added SessionEvent type must be a
  // NO-OP, never corrupt the transcript. Falling through once returned
  // `undefined` here, which poisoned reducer state → the next
  // `turn.output.delta` crashed on `state.streamingAssistant`.
  return applyUnsupportedSessionEventToTranscript(state, event)
}

const renderToolInvoked = (toolName: string, argsPreview: string | undefined): string => {
  if (argsPreview === undefined || argsPreview.length === 0) {
    return `🔧 ${toolName}`
  }
  return `🔧 ${toolName}  ${argsPreview}`
}

const renderToolCompleted = (
  toolName: string,
  outcome: "ok" | "error" | "denied" | "timeout",
  resultPreview: string | undefined,
  durationMs: number | undefined,
): string => {
  const icon =
    outcome === "ok" ? "✓" : outcome === "denied" ? "🚫" : outcome === "timeout" ? "⏱" : "✗"
  const time = durationMs !== undefined ? ` · ${durationMs}ms` : ""
  const body = resultPreview !== undefined && resultPreview.length > 0 ? `  ${resultPreview}` : ""
  return `${icon} ${toolName}${time}${body}`
}

/** ADR-0512 — one-line gray note for a skill-scope decision SUMMARY. Mirrors the
 *  CLI `stdout.ts` line (`⊘ <tool> — outside skill "<skill>" (<decision>)`). A
 *  `blocked` decision is the gray HARD-LOCK; the others are the resolved verb. */
const renderSkillScopeDecision = (
  tool: string,
  activeSkill: string,
  decision: "allowed" | "declined" | "steered" | "blocked",
): string => `⊘ ${tool} — outside skill "${activeSkill}" (${decision})`

export const applyRejectedFrameToTranscript = (
  state: TranscriptState,
  frame: SessionRejectedFrame,
  timestamp: string,
): TranscriptState => {
  if (frame.target !== "command") return state
  return appendTranscriptMessage(state, {
    id: frame.commandId ?? `reject-${timestamp}`,
    role: "error",
    text: renderRejectedFrame(frame),
    timestamp,
  })
}

export const transcriptReducer = (
  state: TranscriptState,
  action: TranscriptAction,
): TranscriptState => {
  switch (action.type) {
    case "reset":
      return initialTranscript
    case "session_event":
      return applySessionEventToTranscript(state, action.event)
    case "snapshot":
      return applySessionStateToTranscript(state, action.snapshot.state, action.receivedAt)
    case "rejected":
      return applyRejectedFrameToTranscript(state, action.frame, action.timestamp)
    case "client_message":
      return appendTranscriptMessage(state, {
        id: `client-${action.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
        role: action.role,
        text: action.text,
        timestamp: action.timestamp,
      })
    default:
      // Defensive: an unknown action type must never return undefined (which
      // would poison the next reducer call). Keep current state.
      return state
  }
}

/**
 * Bound on the dedup set. The set only needs to cover the hydration-replay ↔
 * live-WS OVERLAP window (the most-recent persisted events that can arrive
 * twice), NOT all history — so we cap it and FIFO-evict the oldest ids. An
 * hour-long agent session emits tens of thousands of `turn.output.delta`
 * events (each a unique eventId); an unbounded set would grow that memory for
 * the whole session. 4096 is far larger than any realistic replay overlap, so
 * eviction never resurfaces an id that could actually be replayed.
 */
export const EVENT_DEDUP_CAP = 4096

/**
 * Dedup gate over a `Set<eventId>`: returns `true` (and records the id) the
 * FIRST time an eventId is seen, `false` on every repeat. This is the exact
 * guard `useSessionEvents` applies before dispatching — extracted so the
 * "replayed + live overlap never double-renders" invariant is testable without
 * a React renderer (the test env is `node`, no DOM). Mutates `seen`.
 *
 * Bounded (FIFO): once `seen.size` exceeds `cap`, the oldest inserted id is
 * evicted. `Set` preserves insertion order, so the first value is the oldest.
 */
export const markEventSeen = (
  seen: Set<string>,
  eventId: string,
  cap: number = EVENT_DEDUP_CAP,
): boolean => {
  if (seen.has(eventId)) return false
  seen.add(eventId)
  if (seen.size > cap) {
    for (const oldest of seen) {
      seen.delete(oldest)
      break
    }
  }
  return true
}

/**
 * Dedup gate + transcript projection for a single inbound event. Composes
 * {@link markEventSeen} with the reducer so the overlap invariant can be
 * exercised end-to-end in a node test: feeding the SAME eventId twice yields
 * exactly one message. `applied` reports whether the reducer ran (so a caller
 * can mirror side-effects like `setSessionState` only on first sight).
 */
export const applyDedupedEvent = (
  state: TranscriptState,
  seen: Set<string>,
  event: SessionEvent,
): { state: TranscriptState; applied: boolean } => {
  if (!markEventSeen(seen, event.eventId)) return { state, applied: false }
  return { state: applySessionEventToTranscript(state, event), applied: true }
}

/**
 * `useSessionEvents` — translates a stream of `SessionEvent`s into a
 * growing `UiMessage[]` chat transcript. Also returns the latest
 * `SessionStateView` snapshot (or `null` until the first
 * `session.state.updated` event arrives).
 */
export const useSessionEvents = (
  client: SessionClient,
): {
  messages: readonly UiMessage[]
  streamingMessageId: string | null
  sessionState: SessionStateView | null
  resetTranscript: () => void
  appendClientMessage: (role: "system" | "error", text: string) => void
  modelSlug: string | null
  tokenUsage: CumulativeTokenUsage
} => {
  const [transcript, dispatch] = useReducer(transcriptReducer, initialTranscript)
  const [sessionState, setSessionState] = useState<SessionStateView | null>(null)

  // Dedup set for SessionEvent.eventId — guards against the SAME event
  // arriving twice when hydration (HTTP replay of persisted events) overlaps
  // with a live WS frame for the most-recent events. Replaced on every
  // transcript reset so the set doesn't leak across session boundaries.
  const seenEventIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    let activeSessionId: string | null = null
    const unsubEvents = client.onAny((event: SessionEvent) => {
      // Dedup against any HTTP-hydration replay that overlaps live WS frames —
      // first sight applies, repeats are ignored (see {@link markEventSeen}).
      if (!markEventSeen(seenEventIdsRef.current, event.eventId)) return
      dispatch({ type: "session_event", event })
      if (event.type === "session.state.updated") {
        setSessionState(event.state)
      }
    })
    const unsubSnapshots = client.onSnapshot((snapshot) => {
      if (activeSessionId !== null && activeSessionId !== snapshot.sessionId) {
        seenEventIdsRef.current = new Set()
        dispatch({ type: "reset" })
      }
      activeSessionId = snapshot.sessionId
      dispatch({
        type: "snapshot",
        snapshot,
        receivedAt: new Date().toISOString(),
      })
      setSessionState(snapshot.state)
    })
    const unsubRejected = client.onRejected((frame: SessionRejectedFrame) => {
      dispatch({
        type: "rejected",
        frame,
        timestamp: new Date().toISOString(),
      })
    })
    return () => {
      unsubRejected()
      unsubSnapshots()
      unsubEvents()
    }
  }, [client])

  const resetTranscript = useCallback(() => {
    seenEventIdsRef.current = new Set()
    dispatch({ type: "reset" })
  }, [])

  const appendClientMessage = useCallback((role: "system" | "error", text: string): void => {
    dispatch({
      type: "client_message",
      role,
      text,
      timestamp: new Date().toISOString(),
    })
  }, [])

  return {
    messages: transcript.messages,
    streamingMessageId: transcript.streamingAssistant?.id ?? null,
    sessionState,
    resetTranscript,
    appendClientMessage,
    modelSlug: transcript.modelSlug,
    tokenUsage: transcript.tokenUsage,
  }
}

/* ------------------------------------------------------------------ */
/* Dispatch helper — `sendTurn`                                        */
/* ------------------------------------------------------------------ */

/**
 * Closure that sends an `input.append` immediately followed by `turn.run`.
 * Both commands carry independent generated `commandId`s so the daemon
 * can dedupe at-least-once retries.
 */
export const useSendTurn = (
  client: SessionClient,
  sessionId: string | null,
): ((text: string, images?: readonly ImageBlock[] | undefined) => void) => {
  return useCallback(
    (text: string, images?: readonly ImageBlock[] | undefined) => {
      if (sessionId === null) return
      const trimmed = text.trim()
      const hasImages = images !== undefined && images.length > 0
      // Allow image-only turns (text may be empty when the user just hit
      // the hotkey + Send without typing anything).
      if (trimmed.length === 0 && !hasImages) return
      const now = new Date().toISOString()
      const append = {
        sessionId,
        commandId: makeCommandId(),
        issuedAt: now,
        type: "input.append" as const,
        text: trimmed,
        ...(hasImages ? { images: cloneImages(images as readonly ImageBlock[]) } : {}),
      }
      const run: SessionCommand = {
        sessionId,
        commandId: makeCommandId(),
        issuedAt: now,
        type: "turn.run",
      }
      client.send(append as unknown as SessionCommand)
      client.send(run)
    },
    [client, sessionId],
  )
}

/**
 * ADR-0512 P3 — whether to RE-RUN the suspended turn after resolving an
 * approval. The kernel does not auto-continue: a resolved approval mints/clears
 * a lease, and a fresh `turn.run` is what claims it and re-dispatches the pending
 * tool. So `approve` (the tool must run) and an ESCALATION `deny` (the loop emits
 * the recoverable `skill-scoped` decline) both continue; a NORMAL `deny` aborts
 * the turn — re-running would just re-ask the same approval forever.
 */
export const shouldContinueAfterApproval = (
  decision: "approve" | "deny",
  isEscalation: boolean,
): boolean => decision === "approve" || isEscalation

/**
 * ADR-0512 P3 — sends an `approval.respond` command for a pending approval
 * (the escalation card's 4 verbs collapse onto the protocol's approve/deny —
 * see `EscalationCard`). Mirrors `useSendTurn`: a fresh `commandId` per send so
 * the daemon dedupes at-least-once retries. No-op until the sessionId is known.
 */
export const useSendApprovalDecision = (
  client: SessionClient,
  sessionId: string | null,
): ((
  approvalId: string,
  decision: "approve" | "deny",
  opts?: {
    readonly scope?: "once" | "session"
    readonly steer?: string
    /** ADR-0512 P3 — after responding, send a bare `turn.run` to RE-RUN the
     *  suspended turn (the kernel does not auto-continue). See
     *  {@link shouldContinueAfterApproval}. */
    readonly continueTurn?: boolean
  },
) => void) => {
  return useCallback(
    (
      approvalId: string,
      decision: "approve" | "deny",
      opts?: {
        readonly scope?: "once" | "session"
        readonly steer?: string
        readonly continueTurn?: boolean
      },
    ) => {
      if (sessionId === null) return
      const now = new Date().toISOString()
      const respond: SessionCommand = {
        sessionId,
        commandId: makeCommandId(),
        issuedAt: now,
        type: "approval.respond",
        approvalId,
        decision,
        // ADR-0512 P3 — carry the escalation's once/session scope + corrective
        // steer so allow_once (no widen) and deny_and_steer reach the host. Both
        // omitted on a normal approval ⇒ byte-identical command.
        ...(opts?.scope !== undefined ? { scope: opts.scope } : {}),
        ...(opts?.steer !== undefined ? { steer: opts.steer } : {}),
      }
      client.send(respond)
      // ADR-0512 P3 — re-run the suspended turn so the lease is claimed and the
      // approved tool dispatches (or the escalation decline tool_result is
      // produced). A bare `turn.run` with NO `input.append` continues the turn
      // from the existing transcript — the same primitive the CLI driver loops.
      if (opts?.continueTurn === true) {
        client.send({
          sessionId,
          commandId: makeCommandId(),
          issuedAt: now,
          type: "turn.run",
        } as SessionCommand)
      }
    },
    [client, sessionId],
  )
}

/**
 * Sends `session.permission.set` — switches the live permission mode (default /
 * acceptEdits / bypass / auto). The daemon wires `permission.mode` as a live
 * getter/setter, so the next turn's gate honors the switch (real, not a
 * display-only echo). A fresh `commandId` per send; no-op until sessionId known.
 */
export const useSendPermissionMode = (
  client: SessionClient,
  sessionId: string | null,
): ((mode: string) => void) =>
  useCallback(
    (mode: string) => {
      if (sessionId === null) return
      client.send({
        sessionId,
        commandId: makeCommandId(),
        issuedAt: new Date().toISOString(),
        type: "session.permission.set",
        mode,
      } as SessionCommand)
    },
    [client, sessionId],
  )

/**
 * Sends a `turn.cancel` command for the in-flight turn. Mirrors `useSendTurn`:
 * a fresh `commandId` per send so the daemon dedupes at-least-once retries.
 * No-op until the sessionId is known. The kernel performs the abort (see
 * `src/kernel/session/__tests__/kernel-cancel.hellgate`); the UI had the wire
 * type (`TurnCancelCommand`) but no sender — this closes that gap so the web
 * user can STOP a running turn instead of being stuck until it finishes.
 */
export const useSendCancel = (client: SessionClient, sessionId: string | null): (() => void) => {
  return useCallback(() => {
    if (sessionId === null) return
    const cancel: SessionCommand = {
      sessionId,
      commandId: makeCommandId(),
      issuedAt: new Date().toISOString(),
      type: "turn.cancel",
    }
    client.send(cancel)
  }, [client, sessionId])
}

const renderRejectedFrame = (frame: SessionRejectedFrame): string => {
  switch (frame.reason) {
    case "session_id_mismatch":
      return "turn rejected: session id mismatch"
    case "revision_conflict":
      return `turn rejected: revision conflict (${String(frame.expectedRevision)} != ${String(frame.actualRevision)})`
    case "duplicate_command":
      return "turn rejected: duplicate command"
    case "protocol_validation":
      return frame.issue === undefined
        ? "turn rejected: protocol validation"
        : `turn rejected: ${frame.issue}`
  }
}

const makeCommandId = (): string => {
  // `crypto.randomUUID()` is in every browser quanta targets. We avoid the
  // `uuid` npm dep entirely.
  if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID ===
      "function"
  ) {
    return (globalThis as { crypto: { randomUUID: () => string } }).crypto.randomUUID()
  }
  // Fallback for headless / SSR / vitest-node where crypto isn't bound.
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
