import {
  type SessionCommand,
  type SessionEvent,
  SessionProtocolValidationError,
  SessionRevisionConflictError,
  type SessionSnapshotLite,
} from "@/protocol/session"
import { SessionDuplicateCommandError } from "./errors"
import type {
  SessionReplayPlan,
  SessionTransport,
  SessionTransportConnectMessage,
  SessionTransportMessage,
  SessionTransportRejectedMessage,
} from "./types"

const DEFAULT_TAIL_LIMIT = 128

interface CommandRejectedArgs {
  readonly command: SessionCommand
  readonly error:
    | SessionDuplicateCommandError
    | SessionProtocolValidationError
    | SessionRevisionConflictError
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
  readonly error:
    | SessionDuplicateCommandError
    | SessionProtocolValidationError
    | SessionRevisionConflictError
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
  ...(args.error instanceof SessionProtocolValidationError ? { issue: args.error.issue } : {}),
})

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
  const commandStates = new Map<string, "pending" | "accepted">()
  type Peer = {
    readonly transport: SessionTransport
    unsubscribe: (() => void) | undefined
    closed: boolean
    connected: boolean
  }

  const peers = new Set<Peer>()

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
        reason:
          error instanceof SessionDuplicateCommandError
            ? "duplicate_command"
            : error instanceof SessionRevisionConflictError
              ? "revision_conflict"
              : error.issue === "session_id_mismatch"
                ? "session_id_mismatch"
                : "protocol_validation",
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

    commandStates.set(command.commandId, "pending")
    try {
      await opts.onCommand?.(command)
      commandStates.set(command.commandId, "accepted")
    } catch (error) {
      commandStates.delete(command.commandId)
      reportBridgeError(peer, error)
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
    async publishSnapshot(nextSnapshot) {
      snapshot = cloneSnapshot(nextSnapshot)
      tail = trimTail(snapshot, tail, opts.tailLimit ?? DEFAULT_TAIL_LIMIT)
      commandReplayIndex = rebuildCommandReplayIndex(tail)
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
          .filter((peer) => !peer.closed)
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
