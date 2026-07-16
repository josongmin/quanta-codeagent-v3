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

/** How the server restored this client's view on a resume (re)connect —
 *  LIVE since ticket 05 (R2 F5 channel). Derived from wire OBSERVATION, not a
 *  protocol change: `planSessionReplay` sends a `snapshot` frame ONLY on its
 *  fallback paths, so after a resumeFromSeq-carrying `connect()` the first
 *  snapshot/event frame is the truth — `"snapshot_fallback"` when the server
 *  had to reset the view with a full snapshot, `"replayed"` when the
 *  disconnect window arrived as an incremental event replay. */
export type SessionTransportConnectionResume = "replayed" | "snapshot_fallback"

export interface SessionTransportConnectionConnected {
  readonly status: "connected"
  /** Ticket 05 — resume outcome. UNSET on the submission emission (outcome
   *  unknowable at send time — the wire has no connect ack) and on every
   *  connect that carried no resumeFromSeq. A resume connect emits a SECOND
   *  `connected` state carrying this field as soon as the first replay frame
   *  reveals the outcome — always AFTER the submission emission, so silent
   *  demotion to a snapshot reset is impossible to miss. When a resume replay
   *  is EMPTY (cursor already at the tip) no frame ever arrives and the next
   *  live event resolves the watch as `"replayed"` — nothing was lost, and
   *  there is no degradation to surface before that. */
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
   *
   * Ticket 05: a resumeFromSeq-carrying connect additionally emits a SECOND
   * `connected` state — `resume: "replayed" | "snapshot_fallback"` — once the
   * first replay frame reveals how the server restored the view (see
   * `SessionTransportConnectionConnected.resume`). Always in submission →
   * enrichment order; never emitted for a connect without a resume cursor.
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

/** Ticket 05 — per-connect resume-outcome watch. Armed BEFORE the connect
 *  frame is sent (a synchronous in-proc transport delivers the server's whole
 *  replay answer inside the `send` await); the first snapshot/event frame
 *  derives the outcome. `submissionEmitted` sequences the two `connected`
 *  emissions: an outcome derived EARLY (during the send await) is held and
 *  flushed right after the submission state, so subscribers always observe
 *  submission → enrichment in that order, on every transport. */
interface ResumeOutcomeWatch {
  armed: boolean
  derived: SessionTransportConnectionResume | undefined
  submissionEmitted: boolean
}

/** Ticket 05 — the watch's state machine, factored out of the client closure.
 *  Wire OBSERVATION only (no protocol change): the bridge's replay planner
 *  sends a `snapshot` frame ONLY on its fallback paths, so after a resume
 *  connect the first snapshot/event frame is authoritative — snapshot ⇒
 *  "snapshot_fallback", event ⇒ "replayed". A `rejected` frame targeting the
 *  CONNECT disarms without an outcome (the refusal is surfaced via
 *  `onRejected`/`onMessage`) so a later unrelated frame cannot mint a stale
 *  verdict; heartbeats pass through untouched. One watch slot — the latest
 *  connect wins it. */
const createResumeOutcomeWatcher = (
  emitOutcome: (resume: SessionTransportConnectionResume) => void,
) => {
  let current: ResumeOutcomeWatch | undefined
  return {
    /** connect() entry: arm for a resume cursor, clear for a plain connect. */
    arm(hasResumeCursor: boolean): ResumeOutcomeWatch | undefined {
      current =
        hasResumeCursor === true
          ? { armed: true, derived: undefined, submissionEmitted: false }
          : undefined
      return current
    },
    /** connect() send-failure: the frame never left — a watch for it must not
     *  linger (a later frame would mint a bogus outcome). Guarded by identity
     *  so a newer connect's watch survives an older connect's failure. */
    dropIfCurrent(watch: ResumeOutcomeWatch | undefined): void {
      if (watch !== undefined && current === watch) current = undefined
    },
    /** After the submission `connected` emission: release a HELD early-derived
     *  outcome so the order is submission → enrichment on every transport. */
    flushAfterSubmission(watch: ResumeOutcomeWatch | undefined): void {
      if (watch === undefined) return
      watch.submissionEmitted = true
      if (watch.derived !== undefined) emitOutcome(watch.derived)
    },
    /** Inbound-frame derivation (see the contract in the factory docblock). */
    observe(message: SessionTransportMessage): void {
      if (current === undefined || !current.armed) return
      if (message.kind === "snapshot" || message.kind === "event") {
        current.armed = false
        current.derived = message.kind === "snapshot" ? "snapshot_fallback" : "replayed"
        if (current.submissionEmitted) emitOutcome(current.derived)
      } else if (message.kind === "rejected" && message.target === "connect") {
        current.armed = false
        current = undefined
      }
    },
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

  // Ticket 05 — resume-outcome surfacing (see createResumeOutcomeWatcher).
  const resumeWatcher = createResumeOutcomeWatcher((resume) => {
    if (terminalState === undefined) {
      emitState({ status: "connected", resume })
    }
  })

  const unsubscribe = opts.transport.onMessage((message) => {
    resumeFromSeq = nextResumeFromSeq(resumeFromSeq, message)
    resumeWatcher.observe(message)
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
      // Ticket 05 — arm the resume-outcome watch BEFORE the send: a
      // synchronous transport delivers the server's replay answer inside this
      // await, and the FIRST frame is the outcome carrier.
      const watch = resumeWatcher.arm(next !== undefined)
      try {
        await opts.transport.send({
          kind: "connect",
          sessionId: opts.sessionId,
          ...(next !== undefined ? { resumeFromSeq: next } : {}),
        })
      } catch (error) {
        resumeWatcher.dropIfCurrent(watch)
        throw error
      }
      // Post-mortem connect() must not lie: once the terminal `closed` state
      // was delivered, a (silently dropped) connect frame is NOT a connection.
      if (terminalState === undefined) {
        emitState({ status: "connected" })
        // Early-derived outcome (the reply landed during the send await) is
        // flushed strictly AFTER the submission state, on every transport.
        resumeWatcher.flushAfterSubmission(watch)
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
