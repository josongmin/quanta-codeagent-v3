import {
  type SessionCommand,
  type SessionProtocolError,
  SessionProtocolValidationError,
} from "@/protocol/session"
import { typedErrorFromRejectedMessage } from "./errors"
import type {
  SessionTransport,
  SessionTransportHandler,
  SessionTransportMessage,
  SessionTransportRejectedMessage,
} from "./types"

/** S5 (jul-16 ticket 01) — a server `rejected` frame paired with its typed
 *  error (`typedErrorFromRejectedMessage` mapping; a version-skew reject
 *  surfaces as `SessionProtocolVersionError`). */
export interface SessionTransportClientRejection {
  readonly message: SessionTransportRejectedMessage
  readonly error: SessionProtocolError
}

export interface CreateSessionTransportClientOpts {
  readonly transport: SessionTransport
  readonly sessionId: string
  readonly resumeFromSeq?: number
  /** S5 — typed surfacing of EVERY inbound `rejected` frame. Additive: absent
   *  ⇒ byte-identical behavior (rejected frames still flow to `onMessage`
   *  subscribers as before; this is the typed side-channel, not a filter). */
  readonly onRejected?: (rejection: SessionTransportClientRejection) => void
}

/** How the server restored this client's view on (re)connect. RESERVED (S4,
 *  R2 F5): the raw client never stamps it today — observing replay vs
 *  snapshot-fallback requires the durable-resume machinery of ticket 05,
 *  which will set it. Reserving the field now keeps the payload shape stable
 *  for early SDK consumers. */
export type SessionTransportConnectionResume = "replayed" | "snapshot_fallback"

export interface SessionTransportConnectionConnected {
  readonly status: "connected"
  /** Reserved — never set by `createSessionTransportClient` today (05 owns it). */
  readonly resume?: SessionTransportConnectionResume
}

export interface SessionTransportConnectionClosed {
  readonly status: "closed"
  /** Diagnostic slug from the transport's `onClose` (see
   *  `SessionTransportCloseInfo.reason`), or `local_close` when the client
   *  itself was closed over a transport without a liveness channel. */
  readonly reason: string
}

/**
 * Connection-liveness states of a raw session transport client (S4).
 *  - `connected` — a `connect()` frame was SUBMITTED to the transport
 *    (transport-level success, NOT a server ack — the wire has no connect ack;
 *    the server's answer arrives as snapshot/rejected frames on `onMessage`).
 *  - `closed` — terminal, delivered at most once. A handler subscribed after
 *    the terminal state is invoked with it immediately.
 */
export type SessionTransportConnectionState =
  | SessionTransportConnectionConnected
  | SessionTransportConnectionClosed

export interface SessionTransportClient {
  readonly sessionId: string
  readonly transport: SessionTransport
  connect(opts?: { readonly resumeFromSeq?: number }): Promise<void>
  sendCommand(command: SessionCommand): Promise<void>
  onMessage(handler: SessionTransportHandler): () => void
  /**
   * S4 liveness (additive): observe connection-state transitions. Propagates
   * the transport's `onClose` as `closed` (with its reason) and reports each
   * successful `connect()` submission as `connected`. For transports without
   * an `onClose` channel the client still emits `closed` when it is closed
   * locally — external consumers always get a death notice for every exit
   * path the abstraction can observe.
   */
  onConnectionState(handler: (state: SessionTransportConnectionState) => void): () => void
  currentResumeFromSeq(): number | undefined
  close(): Promise<void>
}

const nextResumeFromSeq = (
  prior: number | undefined,
  message: SessionTransportMessage,
): number | undefined => {
  switch (message.kind) {
    case "snapshot":
      return prior === undefined ? message.snapshot.seq : Math.max(prior, message.snapshot.seq)
    case "event":
      return prior === undefined ? message.event.seq : Math.max(prior, message.event.seq)
    default:
      return prior
  }
}

export const createSessionTransportClient = (
  opts: CreateSessionTransportClientOpts,
): SessionTransportClient => {
  const handlers = new Set<SessionTransportHandler>()
  const stateHandlers = new Set<(state: SessionTransportConnectionState) => void>()
  let closed = false
  let resumeFromSeq = opts.resumeFromSeq
  let terminalState: SessionTransportConnectionClosed | undefined

  const emitState = (state: SessionTransportConnectionState): void => {
    for (const handler of [...stateHandlers]) {
      try {
        handler(state)
      } catch {
        // Swallow per-handler errors to avoid poisoning sibling subscribers.
      }
    }
  }

  // Terminal once-latch: `closed` is delivered at most once, whichever exit
  // path fires first (transport onClose, local close fallback).
  const notifyClosed = (reason: string): void => {
    if (terminalState !== undefined) return
    terminalState = { status: "closed", reason }
    emitState(terminalState)
    stateHandlers.clear()
  }

  const unsubscribe = opts.transport.onMessage((message) => {
    resumeFromSeq = nextResumeFromSeq(resumeFromSeq, message)
    if (message.kind === "rejected" && opts.onRejected !== undefined) {
      try {
        opts.onRejected({ message, error: typedErrorFromRejectedMessage(message) })
      } catch {
        // A throwing rejection observer must not poison message fan-out.
      }
    }
    for (const handler of [...handlers]) {
      try {
        const result = handler(message)
        if (result instanceof Promise) {
          void result.catch(() => undefined)
        }
      } catch {
        // Swallow per-handler errors to avoid poisoning sibling subscribers.
      }
    }
  })

  // S4: transports that expose the liveness channel drive the terminal state
  // directly (peer death, writer error, wedge-guard …). Optional-chained so a
  // legacy transport without `onClose` still composes — its only observable
  // exit path is the local-close fallback in `close()` below.
  const unsubscribeClose = opts.transport.onClose?.((info) => {
    notifyClosed(info.reason)
  })

  return {
    sessionId: opts.sessionId,
    transport: opts.transport,
    async connect(override) {
      if (closed) return
      const next = override?.resumeFromSeq ?? resumeFromSeq
      await opts.transport.send({
        kind: "connect",
        sessionId: opts.sessionId,
        ...(next !== undefined ? { resumeFromSeq: next } : {}),
      })
      // Post-mortem connect() must not lie: once the terminal `closed` state
      // was delivered, a (silently dropped) connect frame is NOT a connection.
      if (terminalState === undefined) {
        emitState({ status: "connected" })
      }
    },
    async sendCommand(command) {
      if (closed) return
      if (command.sessionId !== opts.sessionId) {
        throw new SessionProtocolValidationError("session_id_mismatch")
      }
      await opts.transport.send({ kind: "command", command })
    },
    onMessage(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    onConnectionState(handler) {
      if (terminalState !== undefined) {
        const state = terminalState
        try {
          handler(state)
        } catch {
          // Swallow — per-handler errors must not escape the subscribe call.
        }
        return () => {
          // Nothing to detach — the handler was invoked immediately, once.
        }
      }
      stateHandlers.add(handler)
      return () => {
        stateHandlers.delete(handler)
      }
    },
    currentResumeFromSeq() {
      return resumeFromSeq
    },
    async close() {
      if (closed) return
      closed = true
      handlers.clear()
      unsubscribe()
      await opts.transport.close()
      unsubscribeClose?.()
      // Fallback for transports WITHOUT an onClose channel; a no-op (latched)
      // when the transport already reported its own terminal reason above.
      notifyClosed("local_close")
    },
  }
}
