import {
  type SessionCommand,
  type SessionEvent,
  SessionProtocolValidationError,
  SessionRevisionConflictError,
  type SessionSnapshotLite,
} from "@/protocol/session"
import { SessionDispatchFailedError, SessionDuplicateCommandError } from "./errors"
import type {
  SessionReplayPlan,
  SessionTransport,
  SessionTransportConnectMessage,
  SessionTransportMessage,
  SessionTransportRejectedMessage,
} from "./types"

const DEFAULT_TAIL_LIMIT = 128

/** Every error class a `rejected` frame can be minted from. The dispatch-stage
 *  members (S5a) are ADDITIVE: `SessionDispatchFailedError` wraps a non-protocol
 *  dispatch throw; a `SessionProtocolValidationError` may now also ORIGINATE in
 *  the kernel reducer (e.g. `empty_turn_input`) rather than only in the bridge's
 *  own admission checks. */
type SessionRejectError =
  | SessionDuplicateCommandError
  | SessionProtocolValidationError
  | SessionRevisionConflictError
  | SessionDispatchFailedError

interface CommandRejectedArgs {
  readonly command: SessionCommand
  readonly error: SessionRejectError
}

export interface SessionTransportBridgeErrorArgs {
  readonly error: unknown
  readonly peer: SessionTransport
}

export interface CreateSessionTransportBridgeOpts {
  readonly snapshot: SessionSnapshotLite
  readonly tailLimit?: number
  readonly onCommand?: (command: SessionCommand) => void | Promise<void>
  readonly onCommandRejected?: (args: CommandRejectedArgs) => void
  readonly onBridgeError?: (args: SessionTransportBridgeErrorArgs) => void
}

export interface ConnectedSessionTransport {
  close(): Promise<void>
}

export interface SessionTransportBridge {
  readonly sessionId: string
  connect(transport: SessionTransport): Promise<ConnectedSessionTransport>
  updateSnapshot(snapshot: SessionSnapshotLite): void
  publishSnapshot(snapshot: SessionSnapshotLite): Promise<void>
  publishEvents(events: readonly SessionEvent[]): Promise<void>
  currentSnapshot(): SessionSnapshotLite
  currentTail(): readonly SessionEvent[]
  close(): Promise<void>
}

export const planSessionReplay = ({
  snapshot,
  tail,
  resumeFromSeq,
}: {
  readonly snapshot: SessionSnapshotLite
  readonly tail: readonly SessionEvent[]
  readonly resumeFromSeq?: number
}): SessionReplayPlan => {
  const retainedTail = tail.filter((event) => event.seq > snapshot.seq)
  if (resumeFromSeq === undefined) {
    return { snapshot, tail: retainedTail }
  }
  if (resumeFromSeq < snapshot.seq) {
    return { snapshot, tail: retainedTail }
  }
  // Ahead-of-tip guard (daemon restart / seq reset). After a restart the
  // in-memory seq resets (kernel state seq:0) but a reconnecting client's
  // resumeFromSeq is still the OLD high-water mark — i.e. ahead of everything
  // the bridge now holds. Without this guard the resume arm below filters the
  // tail down to events with `seq > resumeFromSeq` (none), so the client gets
  // an empty events-only plan and is stuck with nothing. Fall back to a full
  // snapshot exactly like the behind-the-window case so the client resets.
  const tip = retainedTail.at(-1)?.seq ?? snapshot.seq
  if (resumeFromSeq > tip) {
    return { snapshot, tail: retainedTail }
  }
  const oldestTailSeq = retainedTail[0]?.seq
  if (oldestTailSeq !== undefined && resumeFromSeq < oldestTailSeq - 1) {
    return { snapshot, tail: retainedTail }
  }
  return {
    tail: retainedTail.filter((event) => event.seq > resumeFromSeq),
  }
}

const cloneSnapshot = (snapshot: SessionSnapshotLite): SessionSnapshotLite => ({
  ...snapshot,
  state: { ...snapshot.state },
  capabilities: { ...snapshot.capabilities },
  pendingApproval: snapshot.pendingApproval === null ? null : { ...snapshot.pendingApproval },
  openArtifacts: snapshot.openArtifacts.map((artifact) => ({ ...artifact })),
})

const trimTail = (
  snapshot: SessionSnapshotLite,
  tail: readonly SessionEvent[],
  tailLimit: number,
): SessionEvent[] => {
  const retained = tail.filter((event) => event.seq > snapshot.seq)
  return retained.length <= tailLimit ? [...retained] : retained.slice(retained.length - tailLimit)
}

const toEventMessages = (events: readonly SessionEvent[]): SessionTransportMessage[] =>
  events.map((event) => ({ kind: "event", event }))

const toRejectedMessage = (args: {
  readonly sessionId: string
  readonly target: SessionTransportRejectedMessage["target"]
  readonly reason: SessionTransportRejectedMessage["reason"]
  readonly command?: SessionCommand
  readonly error: SessionRejectError
}): SessionTransportRejectedMessage => ({
  kind: "rejected",
  sessionId: args.sessionId,
  target: args.target,
  reason: args.reason,
  ...(args.command !== undefined ? { commandId: args.command.commandId } : {}),
  ...(args.error instanceof SessionRevisionConflictError
    ? {
        expectedRevision: args.error.expectedRevision,
        actualRevision: args.error.actualRevision,
      }
    : {}),
  ...(args.error instanceof SessionProtocolValidationError ||
  args.error instanceof SessionDispatchFailedError
    ? { issue: args.error.issue }
    : {}),
})

/** Single source of the error→wire-reason mapping (shared by the admission
 *  rejects and the S5a dispatch-failure promotion). NOTE the reason set is
 *  CLOSED at 4 on the wire (old peers hard-check it — codec.ts), which is why
 *  dispatch failures ride `protocol_validation` instead of a new value. */
const rejectReasonOf = (error: SessionRejectError): SessionTransportRejectedMessage["reason"] =>
  error instanceof SessionDuplicateCommandError
    ? "duplicate_command"
    : error instanceof SessionRevisionConflictError
      ? "revision_conflict"
      : error instanceof SessionProtocolValidationError && error.issue === "session_id_mismatch"
        ? "session_id_mismatch"
        : "protocol_validation"

const currentRevisionOf = (snapshot: SessionSnapshotLite, tail: readonly SessionEvent[]): number =>
  tail.at(-1)?.revision ?? snapshot.revision

const rebuildCommandReplayIndex = (
  tail: readonly SessionEvent[],
): Map<string, readonly SessionEvent[]> => {
  const next = new Map<string, SessionEvent[]>()
  for (const event of tail) {
    if (event.causedByCommandId === undefined) continue
    const prior = next.get(event.causedByCommandId) ?? []
    prior.push(event)
    next.set(event.causedByCommandId, prior)
  }
  return next
}

export const createSessionTransportBridge = (
  opts: CreateSessionTransportBridgeOpts,
): SessionTransportBridge => {
  let closed = false
  let snapshot = cloneSnapshot(opts.snapshot)
  let tail = trimTail(snapshot, [], opts.tailLimit ?? DEFAULT_TAIL_LIMIT)
  let commandReplayIndex = rebuildCommandReplayIndex(tail)
  // M18(a): the command-dedup window. Previously this Map only ever GREW —
  // a long-lived daemon session accumulated one entry per accepted command
  // forever, and the dedup window silently diverged from the BOUNDED replay
  // window (`commandReplayIndex`, derived from a `tailLimit`-capped tail). We
  // now bound the dedup window to the same magnitude (`tailLimit`) with FIFO
  // eviction. `pending` entries are pruned the moment the command reaches a
  // terminal transition (accepted → keep for dedup; errored → delete), and the
  // whole Map is capped so it cannot outgrow the replay window it guards.
  const commandStateCap = Math.max(1, opts.tailLimit ?? DEFAULT_TAIL_LIMIT)
  const commandStates = new Map<string, "pending" | "accepted">()
  const recordCommandState = (commandId: string, state: "pending" | "accepted"): void => {
    // Re-insert to refresh FIFO recency on the accepted-terminal transition.
    commandStates.delete(commandId)
    while (commandStates.size >= commandStateCap) {
      const oldest = commandStates.keys().next().value
      if (oldest === undefined) break
      commandStates.delete(oldest)
    }
    commandStates.set(commandId, state)
  }
  type Peer = {
    readonly transport: SessionTransport
    unsubscribe: (() => void) | undefined
    closed: boolean
    connected: boolean
  }

  const peers = new Set<Peer>()

  const updateSnapshotState = (nextSnapshot: SessionSnapshotLite): void => {
    snapshot = cloneSnapshot(nextSnapshot)
    tail = trimTail(snapshot, tail, opts.tailLimit ?? DEFAULT_TAIL_LIMIT)
    commandReplayIndex = rebuildCommandReplayIndex(tail)
  }

  const reportBridgeError = (peer: SessionTransport, error: unknown): void => {
    opts.onBridgeError?.({ peer, error })
  }

  const sendMessages = async (
    peer: SessionTransport,
    messages: readonly SessionTransportMessage[],
  ): Promise<void> => {
    for (const message of messages) {
      try {
        await peer.send(message)
      } catch (error) {
        reportBridgeError(peer, error)
        break
      }
    }
  }

  const sendReplay = async (peer: SessionTransport, resumeFromSeq?: number): Promise<void> => {
    const plan = planSessionReplay({
      snapshot,
      tail,
      ...(resumeFromSeq !== undefined ? { resumeFromSeq } : {}),
    })
    const messages: SessionTransportMessage[] = []
    if (plan.snapshot !== undefined) {
      messages.push({ kind: "snapshot", snapshot: plan.snapshot })
    }
    messages.push(...toEventMessages(plan.tail))
    await sendMessages(peer, messages)
  }

  const rejectCommand = async (
    peer: SessionTransport,
    command: SessionCommand,
    error:
      | SessionDuplicateCommandError
      | SessionProtocolValidationError
      | SessionRevisionConflictError,
  ): Promise<void> => {
    opts.onCommandRejected?.({ command, error })
    await sendMessages(peer, [
      toRejectedMessage({
        sessionId: snapshot.sessionId,
        target: "command",
        reason: rejectReasonOf(error),
        command,
        error,
      }),
    ])
    if (error instanceof SessionDuplicateCommandError) {
      const replay = commandReplayIndex.get(command.commandId)
      if (replay !== undefined && replay.length > 0) {
        await sendMessages(peer, toEventMessages(replay))
        return
      }
    }
    await sendReplay(peer)
  }

  /**
   * S5a (jul-16 ticket 01) — promote a DISPATCH-stage failure to a `rejected`
   * frame. Previously an accepted command whose dispatch threw (kernel reducer
   * validation like `empty_turn_input`, or a host crash) was only reported to
   * the SERVER-side `onBridgeError` hook: the issuing wire peer received no
   * frame at all and hung undiagnosed (the pre-existing silent bug this
   * closes). Encoding is S0-3: the CLOSED-4 reason `protocol_validation` +
   * the error's issue string (kernel issue verbatim; `dispatch_failed` for
   * non-protocol errors) — the only shape an already-shipped peer decodes.
   *
   * Deliberately FRAME-ONLY (contrast `rejectCommand`, which appends a resync
   * replay): a dispatch failure does not mean the peer's view is stale — the
   * command was admitted against the CURRENT revision — so no snapshot/tail
   * rides along (rejected-flood ⇒ no replay amplification).
   */
  const rejectDispatchFailure = async (
    peer: SessionTransport,
    command: SessionCommand,
    error: unknown,
  ): Promise<void> => {
    const rejection: SessionRejectError =
      error instanceof SessionProtocolValidationError ||
      error instanceof SessionRevisionConflictError
        ? error
        : new SessionDispatchFailedError({ commandId: command.commandId, cause: error })
    opts.onCommandRejected?.({ command, error: rejection })
    await sendMessages(peer, [
      toRejectedMessage({
        sessionId: snapshot.sessionId,
        target: "command",
        reason: rejectReasonOf(rejection),
        command,
        error: rejection,
      }),
    ])
  }

  const rejectConnect = async (
    peer: SessionTransport,
    error: SessionProtocolValidationError,
  ): Promise<void> => {
    await sendMessages(peer, [
      toRejectedMessage({
        sessionId: snapshot.sessionId,
        target: "connect",
        reason:
          error.issue === "session_id_mismatch" ? "session_id_mismatch" : "protocol_validation",
        error,
      }),
    ])
  }

  const handleConnect = async (
    peer: SessionTransport,
    message: SessionTransportConnectMessage,
  ): Promise<void> => {
    if (message.sessionId !== snapshot.sessionId) {
      await rejectConnect(peer, new SessionProtocolValidationError("session_id_mismatch"))
      return
    }
    await sendReplay(peer, message.resumeFromSeq)
  }

  const handleCommand = async (peer: SessionTransport, command: SessionCommand): Promise<void> => {
    if (command.sessionId !== snapshot.sessionId) {
      await rejectCommand(peer, command, new SessionProtocolValidationError("session_id_mismatch"))
      return
    }

    if (commandStates.has(command.commandId)) {
      await rejectCommand(peer, command, new SessionDuplicateCommandError(command.commandId))
      return
    }

    const actualRevision = currentRevisionOf(snapshot, tail)
    if (command.expectedRevision !== undefined && command.expectedRevision !== actualRevision) {
      await rejectCommand(
        peer,
        command,
        new SessionRevisionConflictError(command.expectedRevision, actualRevision),
      )
      return
    }

    recordCommandState(command.commandId, "pending")
    try {
      await opts.onCommand?.(command)
      // Terminal transition: keep the accepted id in the (bounded) dedup window.
      recordCommandState(command.commandId, "accepted")
    } catch (error) {
      // Terminal transition: a failed command is pruned so a retry can re-run.
      commandStates.delete(command.commandId)
      // Server-side diagnostic channel is PRESERVED (additive change)…
      reportBridgeError(peer, error)
      // …and S5a promotes the failure to the issuing peer as a `rejected`
      // frame — the wire is no longer silent about a dispatch-stage error.
      await rejectDispatchFailure(peer, command, error)
    }
  }

  const closePeer = async (peer: Peer): Promise<void> => {
    if (peer.closed) return
    peer.closed = true
    peer.unsubscribe?.()
    peer.unsubscribe = undefined
    peers.delete(peer)
    try {
      await peer.transport.close()
    } catch (error) {
      reportBridgeError(peer.transport, error)
    }
  }

  return {
    sessionId: snapshot.sessionId,
    async connect(transport) {
      if (closed) {
        await transport.close()
        return { close: async () => undefined }
      }

      const peer = {
        transport,
        closed: false,
        connected: false,
        unsubscribe: undefined as Peer["unsubscribe"],
      }
      peer.unsubscribe = transport.onMessage((message) => {
        switch (message.kind) {
          case "connect":
            peer.connected = true
            return handleConnect(transport, message)
          case "command":
            if (!peer.connected) {
              return rejectConnect(
                transport,
                new SessionProtocolValidationError("handshake_required"),
              )
            }
            return handleCommand(transport, message.command)
          default:
            return
        }
      })
      peers.add(peer)
      return {
        close: async () => closePeer(peer),
      }
    },
    updateSnapshot(nextSnapshot) {
      updateSnapshotState(nextSnapshot)
    },
    async publishSnapshot(nextSnapshot) {
      updateSnapshotState(nextSnapshot)
      await Promise.all(
        [...peers]
          .filter((peer) => !peer.closed)
          .map((peer) => sendMessages(peer.transport, [{ kind: "snapshot", snapshot }])),
      )
    },
    async publishEvents(events) {
      if (events.length === 0) return
      tail = trimTail(snapshot, [...tail, ...events], opts.tailLimit ?? DEFAULT_TAIL_LIMIT)
      commandReplayIndex = rebuildCommandReplayIndex(tail)
      const messages = toEventMessages(events)
      await Promise.all(
        [...peers]
          // Gate the live event fan-out on `peer.connected` — mirror the command
          // gate so a peer that has NOT completed its `connect` handshake never
          // receives a pre-handshake stray event (it gets its state via the
          // snapshot/replay path when its `connect` arrives, where the event is
          // already reflected in the retained tail). Already-connected peers
          // still receive every live event (fan-out unchanged for them).
          .filter((peer) => !peer.closed && peer.connected)
          .map((peer) => sendMessages(peer.transport, messages)),
      )
    },
    currentSnapshot() {
      return cloneSnapshot(snapshot)
    },
    currentTail() {
      return [...tail]
    },
    async close() {
      if (closed) return
      closed = true
      await Promise.all([...peers].map((peer) => closePeer(peer)))
    },
  }
}
