import {
  type ConnectedSessionTransport,
  createSessionTransportBridge,
  type SessionTransport,
} from "@/ipc/session"
import type { SessionHost } from "@/kernel/session"
import {
  dispatchSessionCommand,
  isDurableSessionEventLog,
  type KernelDispatchContext,
  type KernelSessionState,
  toSessionSnapshotLite,
} from "@/kernel/session"
import type { SessionCommand, SessionEvent, SessionSnapshotLite } from "@/protocol/session"
import { SessionClosedError, SessionProtocolValidationError } from "@/protocol/session"
import { errMessage, fullFidelityEnabled, logger } from "@/shared"

/**
 * S5a LOW-3 (jul-16 ticket 01) — dispatch-stage validation issues that are a
 * BENIGN client-race no-op, not a server anomaly: they land at `info`, where
 * they previously spammed `logger.error` via `onBridgeError`. The set is a
 * closed allowlist (no pattern matching): `empty_turn_input` is a bare
 * `turn.run` racing an empty draft — the kernel already answers it with a
 * clean reject, and (post-S5a) the issuing peer sees a `rejected` frame.
 */
const BENIGN_DISPATCH_ISSUES: ReadonlySet<string> = new Set(["empty_turn_input"])

const isBenignDispatchError = (error: unknown): boolean =>
  error instanceof SessionProtocolValidationError && BENIGN_DISPATCH_ISSUES.has(error.issue)

import type { SessionSubscriptionHub } from "../subscription"
import type { SessionDispatchOptions, SessionDispatchResult } from "../types"

/**
 * Mutable runtime state for a session, boxed so the engine helpers below can
 * mutate it in place by reference — preserving the exact closure-over-`let`
 * semantics of the original inline `createRuntimeSession` body.
 */
export interface SessionRuntimeState {
  closed: boolean
  state: KernelSessionState
  transportBridge: ReturnType<typeof createSessionTransportBridge> | undefined
  transportDispatchQueue: Promise<void>
  /** ADR-0540 W1-B (audit M-1) — the latest DIRECT (non-queued) dispatch's
   *  in-flight window. `enqueue` chains behind this too, so a subscriber-fired
   *  enqueue during a direct dispatch cannot contend the single-writer lease
   *  that dispatch still holds. */
  activeDispatch: Promise<void>
}

/**
 * Immutable engine dependencies shared by every helper.
 */
export interface SessionEngineDeps {
  readonly box: SessionRuntimeState
  readonly sessionId: string
  readonly subscriptions: SessionSubscriptionHub
  readonly hostSession: SessionHost
  readonly kernel: Pick<KernelDispatchContext, "clock" | "eventLog">
  readonly consumeTurnSubmitProvenance?: NonNullable<
    KernelDispatchContext["consumeTurnSubmitProvenance"]
  >
}

/** Snapshot reads project the current book, not the last turn's cached book. */
export const currentSessionSnapshot = (deps: SessionEngineDeps): SessionSnapshotLite => {
  const snapshot = toSessionSnapshotLite(deps.box.state)
  const costView = deps.hostSession.describe().costView ?? deps.box.state.lastCostView
  return costView === undefined ? snapshot : { ...snapshot, state: { ...snapshot.state, costView } }
}

export const refreshSessionSnapshot = async (deps: SessionEngineDeps): Promise<void> => {
  if (deps.box.closed) throw new SessionClosedError(deps.sessionId)
  await deps.box.transportBridge?.publishSnapshot(currentSessionSnapshot(deps))
}

export const ensureTransportBridge = (
  deps: SessionEngineDeps,
  replayWindow?: number,
): ReturnType<typeof createSessionTransportBridge> => {
  const { box, sessionId } = deps
  if (box.transportBridge !== undefined) return box.transportBridge
  // Ticket 05 (durable resume) — hand the kernel's ON-DISK event log to the
  // bridge as its incremental replay feed. Discovery is the same structural
  // guard the seq-continuity seam uses (`isDurableSessionEventLog`): the
  // default InMemory log exposes no durable surface ⇒ nothing is injected ⇒
  // the bridge's snapshot-fallback behavior stays byte-identical.
  const eventLog = deps.kernel.eventLog
  const durableLog = isDurableSessionEventLog(eventLog) ? eventLog : undefined
  box.transportBridge = createSessionTransportBridge({
    snapshot: currentSessionSnapshot(deps),
    readSnapshotForReplay: () => {
      const snapshot = currentSessionSnapshot(deps)
      return snapshot.state.costView === undefined ? undefined : snapshot
    },
    ...(replayWindow !== undefined ? { tailLimit: replayWindow } : {}),
    ...(durableLog !== undefined ? { durableLog } : {}),
    // Ticket 04 — the bridge is the sole grant authority for wire full fidelity.
    // Resolved from the SAME env gate the host runtime uses to PRODUCE the full
    // fields (`wireRuntimePorts`), so production and grant never disagree. OFF ⇒
    // every requesting connect is refused (granted:false) and the strip stays on
    // for every peer (byte-identical default-OFF wire).
    ...(fullFidelityEnabled(process.env) ? { fullFidelity: true } : {}),
    onCommand: async (command) => {
      // Sequence transport-issued commands on a single tail so they apply in
      // order. The tail MUST NOT stay rejected after one dispatch throws:
      // append a `.catch` BEFORE storing it back so a poisoned promise can
      // never wedge every subsequent command (L5 H-3). The caller still sees
      // the failure for THIS command (we re-await the un-caught run below).
      const run = box.transportDispatchQueue.then(async () => {
        await dispatch(deps, command)
      })
      box.transportDispatchQueue = run.catch((_error) => undefined)
      await run
    },
    // L5 H-3: transport errors and rejected commands were silently dropped —
    // the bridge fired these callbacks but `session.ts` never supplied them,
    // so a failed transport / rejected command vanished with no diagnostic.
    // S5a LOW-3: benign dispatch validation (see BENIGN_DISPATCH_ISSUES) is
    // demoted to `info` on BOTH channels — everything else keeps its severity.
    onBridgeError: ({ error }) => {
      const line = `session transport bridge error (session=${sessionId}): ${errMessage(error)}`
      if (isBenignDispatchError(error)) {
        logger.info(line)
        return
      }
      logger.error(line)
    },
    onCommandRejected: ({ command, error }) => {
      const line = `session transport command rejected (session=${sessionId}, type=${command.type}): ${errMessage(error)}`
      if (isBenignDispatchError(error)) {
        logger.info(line)
        return
      }
      logger.warn(line)
    },
  })
  return box.transportBridge
}

export const publishEvents = (deps: SessionEngineDeps, events: readonly SessionEvent[]): void => {
  for (const event of events) deps.subscriptions.publish(event)
}

export const publishCommittedEvents = async (
  deps: SessionEngineDeps,
  committedState: KernelSessionState,
  events: readonly SessionEvent[],
): Promise<number> => {
  if (events.length === 0) return 0
  deps.box.state = committedState
  publishEvents(deps, events)
  await deps.box.transportBridge?.publishEvents(events)
  deps.box.transportBridge?.updateSnapshot(currentSessionSnapshot(deps))
  return events.length
}

export const publishPendingEvents = async (
  deps: SessionEngineDeps,
  events: readonly SessionEvent[],
  committedEventCount: number,
): Promise<void> => {
  const pendingEvents = committedEventCount === 0 ? events : events.slice(committedEventCount)
  if (pendingEvents.length > 0) {
    publishEvents(deps, pendingEvents)
    await deps.box.transportBridge?.publishEvents(pendingEvents)
  }
  if (committedEventCount === 0 || pendingEvents.length > 0) {
    deps.box.transportBridge?.updateSnapshot(currentSessionSnapshot(deps))
  }
}

export const toDispatchResult = (
  deps: SessionEngineDeps,
  result: Awaited<ReturnType<typeof dispatchSessionCommand>>,
): SessionDispatchResult => ({
  revision: deps.box.state.revision,
  seq: deps.box.state.seq,
  events: result.events,
  ...(result.transcriptMessages !== undefined
    ? { transcript: { messages: [...result.transcriptMessages] } }
    : {}),
  ...(result.turnResult !== undefined
    ? {
        turn: {
          outcome: result.turnResult.outcome,
          messages: [...result.turnResult.messages],
          ...(result.turnResult.artifacts !== undefined
            ? { artifacts: [...result.turnResult.artifacts] }
            : {}),
          ...(result.turnResult.approvalRequest !== undefined
            ? { approvalRequest: result.turnResult.approvalRequest }
            : {}),
        },
      }
    : {}),
})

export const dispatch = async (
  deps: SessionEngineDeps,
  command: SessionCommand,
  options: SessionDispatchOptions = {},
): Promise<SessionDispatchResult> => {
  const { box, sessionId } = deps
  if (box.closed) throw new SessionClosedError(sessionId)
  // ADR-0540 W1-B — `enqueue` rides the SAME single tail transport-issued
  // commands serialize on (`ensureTransportBridge.onCommand`), so an enqueued
  // command runs strictly AFTER every in-flight/queued command instead of
  // contending the single-writer lease. The recursive call strips the flag, so
  // the queued execution takes the plain path below (no re-enqueue cycle).
  if (options.enqueue === true) {
    const { enqueue: _enqueue, ...plain } = options
    // Chain behind BOTH the transport tail AND the latest direct (non-queued)
    // in-flight dispatch (audit M-1): a subscriber firing DURING a direct
    // dispatch (e.g. an in-proc `approval.respond`) must land strictly after
    // that dispatch releases the single-writer lease — deterministically, not
    // by lease-contention retry.
    const run = Promise.all([box.transportDispatchQueue, box.activeDispatch]).then(
      async () => await dispatch(deps, command, plain),
    )
    // Mirror onCommand's tail discipline (L5 H-3): store a caught tail BEFORE
    // returning so one rejected enqueued command can never wedge the queue;
    // the CALLER still observes this command's own failure via `run`.
    box.transportDispatchQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return await run
  }
  // Expose this dispatch's in-flight window for the `enqueue` path above
  // (latest-wins is sufficient: overlapping direct dispatches already contend
  // the single-writer lease among themselves — pre-existing semantics).
  let releaseActive!: () => void
  box.activeDispatch = new Promise<void>((resolve) => {
    releaseActive = resolve
  })
  try {
    let committedEventCount = 0
    const result = await dispatchSessionCommand(box.state, command, {
      ...deps.kernel,
      host: deps.hostSession,
      ...(deps.consumeTurnSubmitProvenance !== undefined
        ? { consumeTurnSubmitProvenance: deps.consumeTurnSubmitProvenance }
        : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      onCommitted: async ({ state: committedState, events }) => {
        committedEventCount += await publishCommittedEvents(deps, committedState, events)
      },
    })
    box.state = result.state
    await publishPendingEvents(deps, result.events, committedEventCount)
    return toDispatchResult(deps, result)
  } finally {
    releaseActive()
  }
}

export const attachSessionTransport = async (
  deps: SessionEngineDeps,
  transport: SessionTransport,
  options: { readonly replayWindow?: number } = {},
): Promise<ConnectedSessionTransport> => {
  const { box, sessionId } = deps
  if (box.closed) throw new SessionClosedError(sessionId)
  const bridge = ensureTransportBridge(deps, options.replayWindow)
  bridge.updateSnapshot(currentSessionSnapshot(deps))
  const connected = await bridge.connect(transport)
  // Synthesise a per-attach `session.created` event — IN-PROC NOTIFICATION
  // ONLY. On the wire, the connect/resume SNAPSHOT is the authoritative
  // carrier of `capabilities` + `modelSlug` (the bridge replies to the
  // client's `connect` handshake with it); this event is deliberately NOT
  // published to the transport bridge:
  //   - it could never reach the client it is attached FOR anyway: it is
  //     minted at `seq = state.seq` (the current tip, attach is a read),
  //     so the bridge tail filter (`seq > snapshot.seq`) drops it from the
  //     connect replay, and the live fan-out's `peer.connected` gate
  //     excludes the still-mid-handshake target peer;
  //   - the ONLY wire effect it ever had was dup-seq noise fanned out to
  //     the OTHER, already-connected peers (runtime-confirmed:
  //     docs/tickets/jul-16-session-created-tail-filter-drop.md, fixed as
  //     option B "wire delivery non-guaranteed, snapshot is the carrier").
  // In-proc subscribers are REAL consumers (e.g. the web daemon's SQLite
  // thread persistence archives every SessionEvent and HTTP hydration
  // replays it to web clients), so the hub publish stays. Do NOT re-add a
  // `transportBridge.publishEvents` here — a regression pin
  // (tests/unit/sdk/session-created-attach-notification.test.ts) goes red
  // on exactly that injection.
  const createdEvent: SessionEvent = {
    type: "session.created",
    eventId: crypto.randomUUID(),
    seq: box.state.seq,
    revision: box.state.revision,
    emittedAt: deps.kernel.clock.now().toISOString(),
    capabilityManifest: box.state.capabilityManifest,
    ...(box.state.modelSlug !== undefined ? { model: box.state.modelSlug } : {}),
  }
  publishEvents(deps, [createdEvent])
  return connected
}

export const closeSession = async (deps: SessionEngineDeps): Promise<void> => {
  const { box } = deps
  if (box.closed) return
  box.closed = true
  await deps.hostSession.close()
  box.state = { ...box.state, status: "closed", seq: box.state.seq + 1 }
  const event: SessionEvent = {
    eventId: crypto.randomUUID(),
    seq: box.state.seq,
    revision: box.state.revision,
    emittedAt: deps.kernel.clock.now().toISOString(),
    type: "session.closed",
  }
  await deps.kernel.eventLog.append(event)
  await box.transportBridge?.publishEvents([event])
  box.transportBridge?.updateSnapshot(currentSessionSnapshot(deps))
  publishEvents(deps, [event])
  await box.transportBridge?.close()
}
