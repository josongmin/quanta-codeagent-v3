import {
  type CreateSessionTransportClientOpts,
  createSessionStdioClient,
  createSessionStdioServer,
  createSessionTransportBridge,
  createSessionWebSocketClient,
  createSessionWebSocketServer,
  type SessionTransportBridge,
  type SessionTransportClient,
  type SessionTransportMessage,
  type SessionTransportServer,
} from "@/ipc/session"
import type { SessionCommand, SessionEvent, SessionSnapshotLite } from "@/protocol/session"

export type TransportKind = "stdio" | "websocket"

const capabilitiesFor = (transport: TransportKind) => ({
  approvals: "operator" as const,
  tools: true,
  memory: false,
  artifacts: true,
  subagents: false,
  automation: false,
  shellSnapshot: false,
  serverAutoContinues: false,
  transport,
})

export const makeSnapshot = (
  transport: TransportKind,
  overrides: Partial<SessionSnapshotLite> = {},
): SessionSnapshotLite => {
  const base: SessionSnapshotLite = {
    sessionId: "session-1",
    revision: 1,
    seq: 1,
    state: {
      status: "idle",
      draftInput: "",
      permissionMode: "default",
      messageCount: 0,
    },
    capabilities: capabilitiesFor(transport),
    pendingApproval: null,
    openArtifacts: [],
  }
  return {
    ...base,
    ...overrides,
    state: {
      ...base.state,
      ...(overrides.state ?? {}),
    },
    capabilities: {
      ...base.capabilities,
      ...(overrides.capabilities ?? {}),
    },
    pendingApproval:
      overrides.pendingApproval === undefined ? base.pendingApproval : overrides.pendingApproval,
    openArtifacts: overrides.openArtifacts ?? base.openArtifacts,
  }
}

export const makeStateUpdatedEvent = (
  overrides: Partial<Extract<SessionEvent, { type: "session.state.updated" }>> = {},
): Extract<SessionEvent, { type: "session.state.updated" }> => ({
  eventId: "event-1",
  seq: 2,
  revision: 2,
  emittedAt: "2026-05-26T00:00:00.000Z",
  type: "session.state.updated",
  state: {
    status: "idle",
    draftInput: "",
    permissionMode: "default",
    messageCount: 0,
  },
  ...overrides,
})

export const makeCommand = (
  overrides: Partial<Extract<SessionCommand, { type: "turn.run" }>> = {},
): Extract<SessionCommand, { type: "turn.run" }> => ({
  sessionId: "session-1",
  commandId: "command-1",
  issuedAt: "2026-05-26T00:00:00.000Z",
  type: "turn.run",
  ...overrides,
})

const createStdioEndpoint = (
  setReaderHandler: (handler: ((chunk: Buffer | string) => void) | undefined) => void,
  readHandler: () => ((chunk: Buffer | string) => void) | undefined,
) => ({
  reader: {
    on(event: "data", handler: (chunk: Buffer | string) => void) {
      if (event === "data") {
        setReaderHandler(handler)
      }
    },
    off(event: "data", handler: (chunk: Buffer | string) => void) {
      if (event === "data" && readHandler() === handler) {
        setReaderHandler(undefined)
      }
    },
  },
  writer: {
    write(chunk: string) {
      readHandler()?.(chunk)
      return true
    },
  },
})

const createStdioDuplexPair = () => {
  let clientReaderHandler: ((chunk: Buffer | string) => void) | undefined
  let serverReaderHandler: ((chunk: Buffer | string) => void) | undefined
  return {
    client: createStdioEndpoint(
      (handler) => {
        clientReaderHandler = handler
      },
      () => serverReaderHandler,
    ),
    server: createStdioEndpoint(
      (handler) => {
        serverReaderHandler = handler
      },
      () => clientReaderHandler,
    ),
  }
}

type MessageListener = (event: { data: unknown }) => void

const createSocketEndpoint = (
  listeners: Set<MessageListener>,
  remoteListeners: Set<MessageListener>,
) => {
  let closed = false
  return {
    send(data: string) {
      if (closed) return
      for (const handler of [...remoteListeners]) {
        handler({ data })
      }
    },
    close() {
      closed = true
    },
    addEventListener(type: "message", handler: MessageListener) {
      if (type === "message" && !closed) {
        listeners.add(handler)
      }
    },
    removeEventListener(type: "message", handler: MessageListener) {
      if (type === "message") {
        listeners.delete(handler)
      }
    },
  }
}

const createWebSocketPair = () => {
  const clientListeners = new Set<MessageListener>()
  const serverListeners = new Set<MessageListener>()
  return {
    client: createSocketEndpoint(clientListeners, serverListeners),
    server: createSocketEndpoint(serverListeners, clientListeners),
  }
}

export const createHarness = async (args: {
  readonly kind: TransportKind
  readonly bridge: SessionTransportBridge
  readonly sessionId?: string
  readonly resumeFromSeq?: number
  /** S5 — typed `rejected` surfacing (additive; absent ⇒ prior behavior). */
  readonly onRejected?: CreateSessionTransportClientOpts["onRejected"]
}): Promise<{
  readonly client: SessionTransportClient
  readonly server: SessionTransportServer
  readonly close: () => Promise<void>
}> => {
  if (args.kind === "stdio") {
    const pair = createStdioDuplexPair()
    const client = createSessionStdioClient({
      reader: pair.client.reader,
      writer: pair.client.writer,
      sessionId: args.sessionId ?? "session-1",
      ...(args.resumeFromSeq !== undefined ? { resumeFromSeq: args.resumeFromSeq } : {}),
      ...(args.onRejected !== undefined ? { onRejected: args.onRejected } : {}),
    })
    const server = await createSessionStdioServer({
      reader: pair.server.reader,
      writer: pair.server.writer,
      bridge: args.bridge,
    })
    return {
      client,
      server,
      close: async () => {
        await client.close()
        await server.close()
      },
    }
  }

  const pair = createWebSocketPair()
  const client = createSessionWebSocketClient({
    socket: pair.client,
    sessionId: args.sessionId ?? "session-1",
    ...(args.resumeFromSeq !== undefined ? { resumeFromSeq: args.resumeFromSeq } : {}),
    ...(args.onRejected !== undefined ? { onRejected: args.onRejected } : {}),
  })
  const server = await createSessionWebSocketServer({
    socket: pair.server,
    bridge: args.bridge,
  })
  return {
    client,
    server,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

export const runConformanceTranscript = async (kind: TransportKind) => {
  const accepted: string[] = []
  const snapshot = makeSnapshot(kind, { revision: 5, seq: 10 })
  const bridge = createSessionTransportBridge({
    snapshot,
    onCommand: async (command) => {
      accepted.push(command.commandId)
    },
  })
  const harness = await createHarness({ kind, bridge })
  const seen: SessionTransportMessage[] = []
  harness.client.onMessage((message) => {
    seen.push(message)
  })
  await harness.client.connect()

  const command = makeCommand({
    commandId: `${kind}-command`,
    expectedRevision: 5,
  })
  await harness.client.sendCommand(command)

  const event11 = makeStateUpdatedEvent({
    eventId: `${kind}-event-11`,
    seq: 11,
    revision: 6,
    causedByCommandId: command.commandId,
    state: {
      status: "running",
      draftInput: "hello",
      permissionMode: "default",
      messageCount: 1,
    },
  })
  const event12 = makeStateUpdatedEvent({
    eventId: `${kind}-event-12`,
    seq: 12,
    revision: 6,
    causedByCommandId: command.commandId,
    state: {
      status: "idle",
      draftInput: "",
      permissionMode: "default",
      messageCount: 2,
    },
  })
  await bridge.publishEvents([event11, event12])

  return {
    accepted,
    bridge,
    command,
    snapshot,
    seen,
    harness,
    events: [event11, event12] as const,
  }
}

export const runRevisionConflictFlow = async (kind: TransportKind) => {
  const snapshot = makeSnapshot(kind, { revision: 5, seq: 10 })
  const bridge = createSessionTransportBridge({ snapshot })
  const harness = await createHarness({ kind, bridge })
  const seen: SessionTransportMessage[] = []
  harness.client.onMessage((message) => {
    seen.push(message)
  })
  await harness.client.connect()
  seen.length = 0

  const liveTailEvent = makeStateUpdatedEvent({
    eventId: `${kind}-live-tail`,
    seq: 11,
    revision: 6,
    causedByCommandId: "other-command",
  })
  await bridge.publishEvents([liveTailEvent])
  seen.length = 0

  await harness.client.sendCommand(
    makeCommand({
      commandId: `${kind}-stale-command`,
      expectedRevision: 5,
    }),
  )

  return {
    bridge,
    harness,
    liveTailEvent,
    seen,
    snapshot,
  }
}

export const runReconnectFlow = async (kind: TransportKind) => {
  const snapshot = makeSnapshot(kind, { revision: 5, seq: 10 })
  const bridge = createSessionTransportBridge({
    snapshot,
    tailLimit: 4,
  })

  const first = await createHarness({ kind, bridge })
  const firstSeen: SessionTransportMessage[] = []
  first.client.onMessage((message) => {
    firstSeen.push(message)
  })
  await first.client.connect()

  const event11 = makeStateUpdatedEvent({
    eventId: `${kind}-event-11`,
    seq: 11,
    revision: 6,
  })
  const event12 = makeStateUpdatedEvent({
    eventId: `${kind}-event-12`,
    seq: 12,
    revision: 6,
  })
  await bridge.publishEvents([event11, event12])
  const resumeFromSeq = first.client.currentResumeFromSeq()
  await first.close()

  const event13 = makeStateUpdatedEvent({
    eventId: `${kind}-event-13`,
    seq: 13,
    revision: 7,
  })
  await bridge.publishEvents([event13])

  const second = await createHarness({
    kind,
    bridge,
    ...(resumeFromSeq !== undefined ? { resumeFromSeq } : {}),
  })
  const secondSeen: SessionTransportMessage[] = []
  second.client.onMessage((message) => {
    secondSeen.push(message)
  })
  await second.client.connect()

  return {
    bridge,
    firstSeen,
    second,
    secondSeen,
    events: [event11, event12, event13] as const,
    resumeFromSeq,
    snapshot,
  }
}

export const runDuplicateCommandFlow = async (kind: TransportKind) => {
  const accepted: string[] = []
  const bridge = createSessionTransportBridge({
    snapshot: makeSnapshot(kind, { revision: 5, seq: 10 }),
    onCommand: async (command) => {
      accepted.push(command.commandId)
    },
  })
  const harness = await createHarness({ kind, bridge })
  const seen: SessionTransportMessage[] = []
  harness.client.onMessage((message) => {
    seen.push(message)
  })
  await harness.client.connect()
  seen.length = 0

  const command = makeCommand({
    commandId: `${kind}-dup-command`,
    expectedRevision: 5,
  })
  await harness.client.sendCommand(command)

  const appliedEvent = makeStateUpdatedEvent({
    eventId: `${kind}-dup-event`,
    seq: 11,
    revision: 6,
    causedByCommandId: command.commandId,
  })
  await bridge.publishEvents([appliedEvent])
  seen.length = 0

  await harness.client.sendCommand(command)

  return {
    accepted,
    appliedEvent,
    bridge,
    command,
    harness,
    seen,
  }
}
