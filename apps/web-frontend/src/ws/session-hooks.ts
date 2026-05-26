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
import type { SessionClient } from "./client"
import type {
  ConnectionState,
  ImageBlock,
  SessionCommand,
  SessionEvent,
  SessionRejectedFrame,
  SessionSnapshotLite,
  SessionStateView,
  UiMessage,
} from "../types/protocol"

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

const appendTranscriptMessage = (
  state: TranscriptState,
  message: UiMessage,
): TranscriptState => ({
  ...state,
  messages: [...state.messages, message],
})

const assistantSignatureFromState = (
  state: SessionStateView,
): string | null => {
  if (
    typeof state.lastAssistantText !== "string" ||
    state.lastAssistantText.length === 0
  ) {
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

const pendingCompletionMessage = (
  pending: PendingCompletion,
): UiMessage => ({
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

const applySessionStateToTranscript = (
  state: TranscriptState,
  sessionState: SessionStateView,
  timestamp: string,
  eventId?: string,
): TranscriptState => {
  if (
    sessionState.status === "running" &&
    typeof sessionState.streamingAssistantText === "string" &&
    sessionState.streamingAssistantText.length > 0
  ) {
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
  const signature = assistantSignatureFromState(sessionState)
  if (signature !== null && signature !== state.lastAssistantSignature) {
    const lastMessage = state.messages.at(-1)
    if (
      state.streamingAssistant !== null &&
      lastMessage?.role === "assistant" &&
      lastMessage.id === state.streamingAssistant.id
    ) {
      return {
        ...state,
        lastAssistantSignature: signature,
        streamingAssistant: null,
        pendingCompletion: null,
        fallbackCompletion: null,
        messages: [
          ...state.messages.slice(0, -1),
          {
            ...lastMessage,
            text: sessionState.lastAssistantText ?? "(turn completed)",
            timestamp: state.streamingAssistant.timestamp,
          },
        ],
      }
    }
    const fallback = state.pendingCompletion ?? state.fallbackCompletion
    const fallbackText =
      fallback === null ? null : fallbackTextOf(fallback)
    const canRepairFallback =
      fallback !== null &&
      lastMessage?.role === "assistant" &&
      lastMessage.id === fallback.eventId &&
      lastMessage.text === fallbackText
    if (canRepairFallback && lastMessage !== undefined) {
      return {
        ...state,
        lastAssistantSignature: signature,
        streamingAssistant: null,
        pendingCompletion: null,
        fallbackCompletion: null,
        messages: [
          ...state.messages.slice(0, -1),
          {
            ...lastMessage,
            text: sessionState.lastAssistantText ?? "(turn completed)",
            timestamp: fallback.timestamp,
          },
        ],
      }
    }
    return appendTranscriptMessage(
      {
        ...state,
        lastAssistantSignature: signature,
        streamingAssistant: null,
        pendingCompletion: null,
        fallbackCompletion: null,
      },
      {
        id: fallback?.eventId ?? eventId ?? `assistant-${timestamp}`,
        role: "assistant",
        text: sessionState.lastAssistantText ?? "(turn completed)",
        timestamp: fallback?.timestamp ?? timestamp,
      },
    )
  }
  if (state.pendingCompletion !== null && sessionState.status === "idle") {
    const fallback = state.pendingCompletion
    if (
      state.streamingAssistant !== null &&
      state.messages.at(-1)?.role === "assistant" &&
      state.messages.at(-1)?.id === state.streamingAssistant.id
    ) {
      const lastMessage = state.messages.at(-1)
      if (lastMessage !== undefined) {
        return {
          ...state,
          streamingAssistant: null,
          pendingCompletion: null,
          fallbackCompletion: null,
          messages: [
            ...state.messages.slice(0, -1),
            {
              ...lastMessage,
              text:
                fallback.assistantText ??
                (lastMessage.text.length > 0
                  ? lastMessage.text
                  : fallbackTextOf(fallback)),
            },
          ],
        }
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
  return state
}

const cloneImages = (
  images: readonly ImageBlock[],
): readonly ImageBlock[] => images.map((image) => ({ ...image }))

export const applySessionEventToTranscript = (
  state: TranscriptState,
  event: SessionEvent,
): TranscriptState => {
  const ts = event.emittedAt
  switch (event.type) {
    case "turn.started":
      return {
        ...appendTranscriptMessage(state, {
          id: event.eventId,
          role: "user",
          text: event.prompt,
          timestamp: ts,
          ...(event.images !== undefined && event.images.length > 0
            ? { images: cloneImages(event.images) }
            : {}),
        }),
        streamingAssistant: null,
      }
    case "turn.output.delta": {
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
        state.streamingAssistant?.timestamp ?? ts,
        streamingId,
      )
    }
    case "turn.completed": {
      const nextUsage =
        event.tokenUsage !== undefined
          ? {
              promptTokens:
                state.tokenUsage.promptTokens + (event.tokenUsage.promptTokens ?? 0),
              completionTokens:
                state.tokenUsage.completionTokens +
                (event.tokenUsage.completionTokens ?? 0),
              totalTokens:
                state.tokenUsage.totalTokens + (event.tokenUsage.totalTokens ?? 0),
              costMicroUsd:
                state.tokenUsage.costMicroUsd + (event.tokenUsage.costMicroUsd ?? 0),
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
          timestamp: ts,
        },
        fallbackCompletion: null,
      }
    }
    case "turn.failed":
      return appendTranscriptMessage(
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
          timestamp: ts,
        },
      )
    case "session.created":
      return appendTranscriptMessage(
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
          timestamp: ts,
        },
      )
    case "session.state.updated":
      return applySessionStateToTranscript(
        state,
        event.state,
        ts,
        event.eventId,
      )
    case "session.closed":
      return appendTranscriptMessage(state, {
        id: event.eventId,
        role: "system",
        text: "session closed",
        timestamp: ts,
      })
    case "approval.requested":
      return appendTranscriptMessage(state, {
        id: event.eventId,
        role: "system",
        text: `approval requested: ${event.approval.reason}`,
        timestamp: ts,
      })
    case "approval.resolved":
    case "artifact.ready":
      return state
    case "tool.invoked":
      return appendTranscriptMessage(state, {
        id: event.eventId,
        role: "system",
        text: renderToolInvoked(event.toolName, event.argsPreview),
        timestamp: ts,
      })
    case "tool.completed":
      return appendTranscriptMessage(state, {
        id: event.eventId,
        role: event.outcome === "error" || event.outcome === "denied" ? "error" : "system",
        text: renderToolCompleted(
          event.toolName,
          event.outcome,
          event.resultPreview,
          event.durationMs,
        ),
        timestamp: ts,
      })
  }
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
  const icon = outcome === "ok" ? "✓" : outcome === "denied" ? "🚫" : outcome === "timeout" ? "⏱" : "✗"
  const time = durationMs !== undefined ? ` · ${durationMs}ms` : ""
  const body = resultPreview !== undefined && resultPreview.length > 0 ? `  ${resultPreview}` : ""
  return `${icon} ${toolName}${time}${body}`
}

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
      return applySessionStateToTranscript(
        state,
        action.snapshot.state,
        action.receivedAt,
      )
    case "rejected":
      return applyRejectedFrameToTranscript(
        state,
        action.frame,
        action.timestamp,
      )
    case "client_message":
      return appendTranscriptMessage(state, {
        id: `client-${action.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
        role: action.role,
        text: action.text,
        timestamp: action.timestamp,
      })
  }
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
  const [transcript, dispatch] = useReducer(
    transcriptReducer,
    initialTranscript,
  )
  const [sessionState, setSessionState] = useState<SessionStateView | null>(
    null,
  )

  // Dedup set for SessionEvent.eventId — guards against the SAME event
  // arriving twice when hydration (HTTP replay of persisted events) overlaps
  // with a live WS frame for the most-recent events. Replaced on every
  // transcript reset so the set doesn't leak across session boundaries.
  const seenEventIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    let activeSessionId: string | null = null
    const unsubEvents = client.onAny((event: SessionEvent) => {
      if (seenEventIdsRef.current.has(event.eventId)) return
      seenEventIdsRef.current.add(event.eventId)
      dispatch({ type: "session_event", event })
      if (event.type === "session.state.updated") {
        setSessionState(event.state)
      }
    })
    const unsubSnapshots = client.onSnapshot((snapshot) => {
      if (
        activeSessionId !== null &&
        activeSessionId !== snapshot.sessionId
      ) {
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

  const appendClientMessage = useCallback(
    (role: "system" | "error", text: string): void => {
      dispatch({
        type: "client_message",
        role,
        text,
        timestamp: new Date().toISOString(),
      })
    },
    [],
  )

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
    typeof (
      globalThis as { crypto?: { randomUUID?: () => string } }
    ).crypto?.randomUUID === "function"
  ) {
    return (
      globalThis as { crypto: { randomUUID: () => string } }
    ).crypto.randomUUID()
  }
  // Fallback for headless / SSR / vitest-node where crypto isn't bound.
  return `cmd-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`
}
