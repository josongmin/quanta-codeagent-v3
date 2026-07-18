/**
 * `toSessionHandle(runtimeSession)` — the IN-PROCESS adapter onto the generic
 * verb surface (S2, jul-16 transport-unified SDK ticket 01; MASTER §3.1/§3.3).
 *
 * INTERNAL / CONFORMANCE-ORACLE ONLY. This adapter is deliberately NOT on the
 * public `@/sdk` barrel (public-surface snapshot pins its ABSENCE): external
 * in-process consumption stays `createAnalysisAgent` (jul-4 door), and the
 * session factory is not public — so a public `toSessionHandle` would be a
 * door to nowhere. Its purpose is to make `RuntimeSession` drivable through
 * the SAME `SessionHandle` shape the wire door produces, so the transport
 * conformance suite can diff wire behavior against the in-process ORACLE.
 *
 * Receipt semantics note (documented asymmetry, §3.2): the in-process verbs
 * resolve AFTER the dispatch completed (RuntimeSession has no submit/complete
 * split), so a receipt here is strictly STRONGER than the wire's
 * submitted-only receipt — same shape, earlier-or-equal truth on the wire
 * side. A dispatch failure REJECTS the verb (and also feeds
 * `onCommandRejected`, mirroring the bridge's S5a rejected promotion).
 *
 * The §3.2 turn-end correlation is the SHARED `createTurnEndCorrelator` from
 * `@/ipc/session` — one semantics for both doors, by construction.
 */

import {
  createTurnEndCorrelator,
  SessionDispatchFailedError,
  type SessionHandle,
  SessionHandleClosedError,
  type SessionTransportClientRejection,
  type SessionTransportConnectionState,
  SessionTurnCorrelationLostError,
} from "@/ipc/session"
import type { CommandReceipt, SessionVerbSurface } from "@/protocol/session"
import { SessionProtocolValidationError, SessionRevisionConflictError } from "@/protocol/session"
import type { RuntimeSession, SessionDispatchResult } from "./types"

/* ------------------------------------------------------------------------- */
/* S2a compile-time pins — the S0 spike rulings, made PERMANENT in src/        */
/* (bun test does not typecheck test files, so a pin under tests/ is locally   */
/* inert; `tsconfig.typecheck.src.json` always sees this file).                */
/* ------------------------------------------------------------------------- */

/** S0 ruling 1 (positive): `RuntimeSession` SATISFIES the shared verb surface
 *  at the dispatch-result grade — the whole session value flows through a
 *  real assignment position (not a vacuous literal), so any drift in verb
 *  names / argument shapes / result grade breaks the src typecheck. */
export const _pinRuntimeSessionSatisfiesVerbSurface = (
  session: RuntimeSession,
): SessionVerbSurface<SessionDispatchResult> => session

/** S0 ruling 1 (negative control): the result-grade parameter genuinely
 *  separates the two doors — `RuntimeSession` must NEVER be assignable at the
 *  RECEIPT grade (its verbs return `SessionDispatchResult`, which lacks
 *  `commandId`/`submitted`). If this assignment ever compiles, the generic
 *  surface has collapsed and the pin's expect-error goes unused ⇒ src
 *  typecheck fails. */
export const _pinReceiptGradeStaysDistinct = (
  session: RuntimeSession,
): SessionVerbSurface<CommandReceipt> =>
  // @ts-expect-error — deliberate negative control (see docblock above).
  session

/* ------------------------------------------------------------------------- */
/* The adapter                                                                */
/* ------------------------------------------------------------------------- */

/** Mirror of the bridge's error→rejected-frame mapping (S5a): synthesize the
 *  frame an equivalent wire peer would have received, so the in-process
 *  rejected channel carries the same reason/issue vocabulary. */
const toRejectedFrame = (args: {
  readonly sessionId: string
  readonly commandId: string
  readonly error: unknown
}): SessionTransportClientRejection => {
  const { sessionId, commandId, error } = args
  if (error instanceof SessionRevisionConflictError) {
    return {
      message: {
        kind: "rejected",
        sessionId,
        target: "command",
        reason: "revision_conflict",
        commandId,
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision,
      },
      error,
    }
  }
  if (error instanceof SessionProtocolValidationError) {
    return {
      message: {
        kind: "rejected",
        sessionId,
        target: "command",
        reason:
          error.issue === "session_id_mismatch" ? "session_id_mismatch" : "protocol_validation",
        commandId,
        issue: error.issue,
      },
      error,
    }
  }
  const wrapped = new SessionDispatchFailedError({ commandId, cause: error })
  return {
    message: {
      kind: "rejected",
      sessionId,
      target: "command",
      reason: "protocol_validation",
      commandId,
      issue: wrapped.issue,
    },
    error: wrapped,
  }
}

export interface ToSessionHandleOpts {
  /** Injected wall clock for snapshot freshness stamps (testability). */
  readonly now?: () => number
  /** Fresh unique command id — defaults to `crypto.randomUUID`. */
  readonly newCommandId?: () => string
  /** B-MED-7 — LATEST-known ADR-0540 W1-B `serverAutoContinues` read. TRUE ⇒
   *  the daemon owns + STAMPS its post-approval continuation, so the correlator
   *  adopts by the PREDICTED commandId only (no foreign-turn guess). Absent ⇒
   *  legacy stamp-less behavior (byte-identical). */
  readonly serverAutoContinues?: () => boolean
}

/** The in-process verb table — hoisted from `toSessionHandle` (god-FN
 *  ratchet, jul-16 audit HIGH-3). Every verb mints/forwards a commandId and
 *  routes through the ONE `receiptOf` (dispatch → receipt, failure → rejected
 *  channel + rethrow); `turn.run` keeps its correlator-aware custom body and
 *  is passed in as a closure. */
const buildAdapterVerbSurface = (args: {
  readonly session: RuntimeSession
  readonly newCommandId: () => string
  readonly receiptOf: (
    commandId: string,
    dispatch: () => Promise<SessionDispatchResult>,
  ) => Promise<CommandReceipt>
  readonly runTurn: SessionVerbSurface<CommandReceipt>["turn"]["run"]
}): SessionVerbSurface<CommandReceipt> => {
  const { session, newCommandId, receiptOf, runTurn } = args
  return {
    input: {
      append(text, meta) {
        const commandId = meta?.commandId ?? newCommandId()
        return receiptOf(commandId, () => session.input.append(text, { ...meta, commandId }))
      },
    },
    turn: {
      run: runTurn,
      cancel(meta) {
        const commandId = meta?.commandId ?? newCommandId()
        return receiptOf(commandId, () => session.turn.cancel({ ...meta, commandId }))
      },
    },
    identity: {
      set(mode, meta) {
        const commandId = meta?.commandId ?? newCommandId()
        return receiptOf(commandId, () => session.identity.set(mode, { ...meta, commandId }))
      },
    },
    toolProfile: {
      set(profile, meta) {
        const commandId = meta?.commandId ?? newCommandId()
        return receiptOf(commandId, () => session.toolProfile.set(profile, { ...meta, commandId }))
      },
    },
    permission: {
      set(mode, meta) {
        const commandId = meta?.commandId ?? newCommandId()
        return receiptOf(commandId, () => session.permission.set(mode, { ...meta, commandId }))
      },
    },
    approval: {
      respond(approvalId, decision, meta) {
        const commandId = meta?.commandId ?? newCommandId()
        return receiptOf(commandId, () =>
          session.approval.respond(approvalId, decision, { ...meta, commandId }),
        )
      },
    },
    transcript: {
      replace(messages, meta) {
        const commandId = meta?.commandId ?? newCommandId()
        return receiptOf(commandId, () =>
          session.transcript.replace(messages, { ...meta, commandId }),
        )
      },
    },
  }
}

export const toSessionHandle = (
  session: RuntimeSession,
  opts: ToSessionHandleOpts = {},
): SessionHandle => {
  const now = opts.now ?? (() => Date.now())
  const newCommandId = opts.newCommandId ?? (() => crypto.randomUUID())
  const correlator = createTurnEndCorrelator({ serverAutoContinues: opts.serverAutoContinues })
  const rejectionListeners = new Set<(rejection: SessionTransportClientRejection) => void>()
  const stateListeners = new Set<(state: SessionTransportConnectionState) => void>()

  let closed = false
  let lastSeenSeq: number | undefined

  // ONE internal subscription feeds the correlator + the seq cursor; consumer
  // subscriptions ride the session hub directly (detached independently).
  const unsubscribe = session.subscribe((event) => {
    lastSeenSeq = lastSeenSeq === undefined ? event.seq : Math.max(lastSeenSeq, event.seq)
    correlator.onEvent(event)
  })

  const notifyRejected = (commandId: string, error: unknown): void => {
    const rejection = toRejectedFrame({ sessionId: session.sessionId, commandId, error })
    for (const listener of [...rejectionListeners]) {
      try {
        listener(rejection)
      } catch {
        // A throwing observer must not poison the fan-out.
      }
    }
  }

  const guardOpen = (): void => {
    if (closed) throw new SessionHandleClosedError(session.sessionId, "local_close")
  }

  /** Run a verb dispatch; mint the receipt on success, feed the rejected
   *  channel (and rethrow) on failure. */
  const receiptOf = async (
    commandId: string,
    dispatch: () => Promise<SessionDispatchResult>,
  ): Promise<CommandReceipt> => {
    guardOpen()
    try {
      await dispatch()
      return { commandId, submitted: true }
    } catch (error) {
      notifyRejected(commandId, error)
      throw error
    }
  }

  const runTurn: SessionVerbSurface<CommandReceipt>["turn"]["run"] = async (meta) => {
    guardOpen()
    const commandId = meta?.commandId ?? newCommandId()
    // Register BEFORE the dispatch — the in-process dispatch publishes the
    // whole turn (terminal included) before its promise resolves.
    correlator.begin(commandId)
    try {
      await session.turn.run({ ...meta, commandId })
      return { commandId, submitted: true }
    } catch (error) {
      correlator.rejectCommand(commandId, error)
      notifyRejected(commandId, error)
      throw error
    }
  }

  return {
    sessionId: session.sessionId,
    ...buildAdapterVerbSurface({ session, newCommandId, receiptOf, runTurn }),
    subscribe(listener) {
      return session.subscribe(listener)
    },
    async snapshot() {
      // In-process there IS a live read — served fresh, stamped with the same
      // freshness fields the wire cache carries (capturedAt = read time).
      const snapshot = await session.snapshot()
      return { snapshot, receivedAtMs: now(), lastSeenSeq }
    },
    awaitTurnEnd() {
      return correlator.awaitEnd()
    },
    onConnectionState(handler) {
      // In-process: born connected; `closed` only via local close().
      stateListeners.add(handler)
      if (!closed) {
        try {
          handler({ status: "connected" })
        } catch {
          // Same swallow rule as the wire fan-out.
        }
      } else {
        try {
          handler({ status: "closed", reason: "local_close" })
        } catch {
          // Same swallow rule as the wire fan-out.
        }
      }
      return () => {
        stateListeners.delete(handler)
      }
    },
    onCommandRejected(handler) {
      rejectionListeners.add(handler)
      return () => {
        rejectionListeners.delete(handler)
      }
    },
    lastSeq() {
      return lastSeenSeq
    },
    reportApprovalContinuation(approvalId, commandId) {
      correlator.succeed(approvalId, commandId)
    },
    reportApprovalContinuationFailure(approvalId, error) {
      correlator.failContinuation(approvalId, error)
    },
    async close() {
      // Detach-only: the handle is a VIEW over the session — closing it never
      // closes the (possibly shared) underlying RuntimeSession.
      if (closed) return
      closed = true
      unsubscribe()
      correlator.failAll(
        new SessionTurnCorrelationLostError("handle_closed", "the handle was closed locally"),
      )
      for (const listener of [...stateListeners]) {
        try {
          listener({ status: "closed", reason: "local_close" })
        } catch {
          // Same swallow rule as the wire fan-out.
        }
      }
      stateListeners.clear()
      rejectionListeners.clear()
    },
  }
}
