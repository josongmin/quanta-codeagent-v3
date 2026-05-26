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

import { useCallback, useEffect, useReducer, useState } from "react"
import type { SessionClient } from "./client"
import type {
  ConnectionState,
  SessionCommand,
  SessionEvent,
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
  | { type: "user"; text: string; id: string; timestamp: string }
  | { type: "assistant"; text: string; id: string; timestamp: string }
  | { type: "system"; text: string; id: string; timestamp: string }
  | { type: "error"; text: string; id: string; timestamp: string }
  | { type: "reset" }

interface TranscriptState {
  readonly messages: readonly UiMessage[]
}

const initialTranscript: TranscriptState = { messages: [] }

const transcriptReducer = (
  state: TranscriptState,
  action: TranscriptAction,
): TranscriptState => {
  switch (action.type) {
    case "reset":
      return initialTranscript
    case "user":
    case "assistant":
    case "system":
    case "error":
      return {
        messages: [
          ...state.messages,
          {
            id: action.id,
            role: action.type,
            text: action.text,
            timestamp: action.timestamp,
          },
        ],
      }
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
  sessionState: SessionStateView | null
  resetTranscript: () => void
} => {
  const [transcript, dispatch] = useReducer(
    transcriptReducer,
    initialTranscript,
  )
  const [sessionState, setSessionState] = useState<SessionStateView | null>(
    null,
  )

  useEffect(() => {
    const unsub = client.onAny((event: SessionEvent) => {
      const ts = event.emittedAt
      switch (event.type) {
        case "turn.started":
          dispatch({
            type: "user",
            text: event.prompt,
            id: event.eventId,
            timestamp: ts,
          })
          break
        case "turn.completed":
          dispatch({
            type: "assistant",
            text: event.outcomeReason || "(turn completed)",
            id: event.eventId,
            timestamp: ts,
          })
          break
        case "turn.failed":
          dispatch({
            type: "error",
            text: event.message,
            id: event.eventId,
            timestamp: ts,
          })
          break
        case "session.created":
          dispatch({
            type: "system",
            text: `session created (transport=${event.capabilityManifest.transport})`,
            id: event.eventId,
            timestamp: ts,
          })
          break
        case "session.state.updated":
          setSessionState(event.state)
          break
        case "session.closed":
          dispatch({
            type: "system",
            text: "session closed",
            id: event.eventId,
            timestamp: ts,
          })
          break
        case "approval.requested":
          dispatch({
            type: "system",
            text: `approval requested: ${event.approval.reason}`,
            id: event.eventId,
            timestamp: ts,
          })
          break
        case "approval.resolved":
        case "artifact.ready":
          // No chat-row surface for these in v1 — future iterations may
          // add a sidebar / inline preview.
          break
      }
    })
    return unsub
  }, [client])

  const resetTranscript = useCallback(() => {
    dispatch({ type: "reset" })
  }, [])

  return {
    messages: transcript.messages,
    sessionState,
    resetTranscript,
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
  sessionId: string,
): ((text: string) => void) => {
  return useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (trimmed.length === 0) return
      const now = new Date().toISOString()
      const append: SessionCommand = {
        sessionId,
        commandId: makeCommandId(),
        issuedAt: now,
        type: "input.append",
        text: trimmed,
      }
      const run: SessionCommand = {
        sessionId,
        commandId: makeCommandId(),
        issuedAt: now,
        type: "turn.run",
      }
      client.send(append)
      client.send(run)
    },
    [client, sessionId],
  )
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
