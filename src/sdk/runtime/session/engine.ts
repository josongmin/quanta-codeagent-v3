import {
  type ConnectedSessionTransport,
  createSessionTransportBridge,
  type SessionTransport,
} from "@/ipc/session"
import type { SessionHost } from "@/kernel/session"
import {
  dispatchSessionCommand,
  type KernelDispatchContext,
  type KernelSessionState,
  toSessionSnapshotLite,
} from "@/kernel/session"
import type { SessionCommand, SessionEvent } from "@/protocol/session"
import { SessionClosedError } from "@/protocol/session"
import { errMessage, logger } from "@/shared"
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
}

export const ensureTransportBridge = (
  deps: SessionEngineDeps,
  replayWindow?: number,
): ReturnType<typeof createSessionTransportBridge> => {
  const { box, sessionId } = deps
  if (box.transportBridge !== undefined) return box.transportBridge
  box.transportBridge = createSessionTransportBridge({
    snapshot: toSessionSnapshotLite(box.state),
    ...(replayWindow !== undefined ? { tailLimit: replayWindow } : {}),
    onCommand: async (command) => {
      // Sequence transport-issued commands on a single tail so they apply in
      // order. The tail MUST NOT stay rejected after one dispatch throws:
      // append a `.catch` BEFORE storing it back so a poisoned promise can
      // never wedge every subsequent command (L5 H-3). The caller still sees
      // the failure for THIS command (we re-await the un-caught run below).
      const run = box.transportDispatchQueue.then(async () => {
        await dispatch(deps, command)
      })
      box.transportDispatchQueue = run.catch(() => undefined)
      await run
    },
    // L5 H-3: transport errors and rejected commands were silently dropped —
    // the bridge fired these callbacks but `session.ts` never supplied them,
    // so a failed transport / rejected command vanished with no diagnostic.
    onBridgeError: ({ error }) => {
      logger.error(`session transport bridge error (session=${sessionId}): ${errMessage(error)}`)
    },
    onCommandRejected: ({ command, error }) => {
      logger.warn(
        `session transport command rejected (session=${sessionId}, type=${command.type}): ${errMessage(error)}`,
      )
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
  deps.box.transportBridge?.updateSnapshot(toSessionSnapshotLite(deps.box.state))
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
    deps.box.transportBridge?.updateSnapshot(toSessionSnapshotLite(deps.box.state))
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
  const connected = await ensureTransportBridge(deps, options.replayWindow).connect(transport)
  // Synthesise a `session.created` event for the freshly-attached client
  // so it can render the model pill + capability manifest without an
  // out-of-band lookup. This is intentionally per-attach (not
  // per-session-life) so a reconnecting client sees the same shape.
  const createdEvent: SessionEvent = {
    type: "session.created",
    eventId: crypto.randomUUID(),
    seq: box.state.seq,
    revision: box.state.revision,
    emittedAt: deps.kernel.clock.now().toISOString(),
    capabilityManifest: box.state.capabilityManifest,
    ...(box.state.modelSlug !== undefined ? { model: box.state.modelSlug } : {}),
  }
  // Publish to in-proc subscribers AND the just-connected transport.
  publishEvents(deps, [createdEvent])
  await box.transportBridge?.publishEvents([createdEvent])
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
  box.transportBridge?.updateSnapshot(toSessionSnapshotLite(box.state))
  publishEvents(deps, [event])
  await box.transportBridge?.close()
}
