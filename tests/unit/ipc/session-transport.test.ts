import { describe, expect, test } from "bun:test"
import {
  createSessionStdioTransport,
  createSessionTransportBridge,
  encodeSessionTransportMessage,
  SessionDuplicateCommandError,
  type SessionTransport,
  type SessionTransportMessage,
  wrapWebSocketLikeAsSessionTransport,
} from "@/ipc/session"
import {
  type SessionCommand,
  type SessionEvent,
  SessionRevisionConflictError,
  type SessionSnapshotLite,
} from "@/protocol/session"

const CAPABILITIES = {
  approvals: "operator" as const,
  tools: true,
  memory: false,
  artifacts: true,
  subagents: false,
  automation: false,
  shellSnapshot: false,
  transport: "stdio" as const,
}

const makeSnapshot = (overrides: Partial<SessionSnapshotLite> = {}): SessionSnapshotLite => {
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
    capabilities: CAPABILITIES,
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
      ...CAPABILITIES,
      ...(overrides.capabilities ?? {}),
    },
    pendingApproval:
      overrides.pendingApproval === undefined ? base.pendingApproval : overrides.pendingApproval,
    openArtifacts: overrides.openArtifacts ?? base.openArtifacts,
  }
}

const makeStateUpdatedEvent = (
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

const makeCommand = (
  overrides: Partial<Extract<SessionCommand, { type: "turn.run" }>> = {},
): Extract<SessionCommand, { type: "turn.run" }> => ({
  sessionId: "session-1",
  commandId: "command-1",
  issuedAt: "2026-05-26T00:00:00.000Z",
  type: "turn.run",
  ...overrides,
})

const makeStreamPair = () => {
  let dataHandler: ((chunk: Buffer | string) => void) | undefined
  const reader = {
    on(event: "data", handler: (chunk: Buffer | string) => void) {
      if (event === "data") dataHandler = handler
    },
    off(event: "data", handler: (chunk: Buffer | string) => void) {
      if (event === "data" && dataHandler === handler) dataHandler = undefined
    },
  }
  const written: string[] = []
  return {
    reader,
    writer: {
      write(chunk: string) {
        written.push(chunk)
        return true
      },
    },
    push(chunk: string) {
      dataHandler?.(chunk)
    },
    written,
  }
}

const makeConnectMessage = (
  overrides: { readonly sessionId?: string; readonly resumeFromSeq?: number } = {},
): SessionTransportMessage => ({
  kind: "connect",
  sessionId: overrides.sessionId ?? "session-1",
  ...(overrides.resumeFromSeq !== undefined ? { resumeFromSeq: overrides.resumeFromSeq } : {}),
})

const makeSocketHarness = () => {
  const listeners = new Set<(event: { data: unknown }) => void>()
  const sent: string[] = []
  return {
    socket: {
      send(data: string) {
        sent.push(data)
      },
      close() {
        return undefined
      },
      addEventListener(type: "message", handler: (event: { data: unknown }) => void) {
        if (type === "message") listeners.add(handler)
      },
      removeEventListener(type: "message", handler: (event: { data: unknown }) => void) {
        if (type === "message") listeners.delete(handler)
      },
    },
    emit(data: unknown) {
      for (const handler of [...listeners]) handler({ data })
    },
    sent,
  }
}

const createTransportPair = (): { client: SessionTransport; server: SessionTransport } => {
  const clientHandlers = new Set<(message: SessionTransportMessage) => void | Promise<void>>()
  const serverHandlers = new Set<(message: SessionTransportMessage) => void | Promise<void>>()
  let clientClosed = false
  let serverClosed = false

  const build = (
    local: Set<(message: SessionTransportMessage) => void | Promise<void>>,
    remote: Set<(message: SessionTransportMessage) => void | Promise<void>>,
    isLocalClosed: () => boolean,
    closeLocal: () => void,
  ): SessionTransport => ({
    async send(message) {
      if (isLocalClosed()) return
      for (const handler of [...remote]) {
        await handler(message)
      }
    },
    onMessage(handler) {
      local.add(handler)
      return () => {
        local.delete(handler)
      }
    },
    async close() {
      closeLocal()
      local.clear()
    },
  })

  return {
    client: build(
      clientHandlers,
      serverHandlers,
      () => clientClosed,
      () => {
        clientClosed = true
      },
    ),
    server: build(
      serverHandlers,
      clientHandlers,
      () => serverClosed,
      () => {
        serverClosed = true
      },
    ),
  }
}

describe("session stdio transport", () => {
  test("decodes partial command frames and encodes snapshot frames", async () => {
    const pair = makeStreamPair()
    const transport = createSessionStdioTransport({
      reader: pair.reader,
      writer: pair.writer,
    })
    const seen: SessionTransportMessage[] = []
    transport.onMessage((message) => {
      seen.push(message)
    })

    const command = makeCommand({ commandId: "stdio-command" })
    const wire = `${encodeSessionTransportMessage({ kind: "command", command })}\n`
    pair.push(wire.slice(0, 9))
    pair.push(wire.slice(9))

    expect(seen).toEqual([{ kind: "command", command }])

    const snapshot = makeSnapshot({ revision: 3, seq: 8 })
    await transport.send({ kind: "snapshot", snapshot })
    expect(pair.written).toEqual([
      `${encodeSessionTransportMessage({ kind: "snapshot", snapshot })}\n`,
    ])

    await transport.close()
  })
})

describe("session websocket transport", () => {
  test("decodes event messages and encodes command messages", async () => {
    const harness = makeSocketHarness()
    const transport = wrapWebSocketLikeAsSessionTransport(harness.socket)
    const seen: SessionTransportMessage[] = []
    transport.onMessage((message) => {
      seen.push(message)
    })

    const event = makeStateUpdatedEvent({ eventId: "ws-event", seq: 4, revision: 2 })
    harness.emit(encodeSessionTransportMessage({ kind: "event", event }))
    expect(seen).toEqual([{ kind: "event", event }])

    const command = makeCommand({ commandId: "ws-command" })
    await transport.send({ kind: "command", command })
    expect(harness.sent).toEqual([encodeSessionTransportMessage({ kind: "command", command })])

    await transport.close()
  })
})

describe("session transport bridge replay", () => {
  test("resume inside retained tail replays only missing tail events", async () => {
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ revision: 5, seq: 10 }),
      tailLimit: 4,
    })
    const event11 = makeStateUpdatedEvent({
      eventId: "event-11",
      seq: 11,
      revision: 6,
      state: { status: "idle", draftInput: "a", permissionMode: "default", messageCount: 1 },
    })
    const event12 = makeStateUpdatedEvent({
      eventId: "event-12",
      seq: 12,
      revision: 6,
      state: { status: "idle", draftInput: "ab", permissionMode: "default", messageCount: 1 },
    })
    await bridge.publishEvents([event11, event12])

    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((message) => {
      inbound.push(message)
    })

    await bridge.connect(pair.server)
    await pair.client.send(makeConnectMessage({ resumeFromSeq: 11 }))
    expect(inbound).toEqual([{ kind: "event", event: event12 }])

    await bridge.close()
    await pair.client.close()
  })

  test("resume before retained tail falls back to snapshot plus retained tail", async () => {
    const snapshot = makeSnapshot({ revision: 5, seq: 10 })
    const bridge = createSessionTransportBridge({
      snapshot,
      tailLimit: 2,
    })
    const event11 = makeStateUpdatedEvent({
      eventId: "event-11",
      seq: 11,
      revision: 6,
    })
    const event12 = makeStateUpdatedEvent({
      eventId: "event-12",
      seq: 12,
      revision: 6,
    })
    const event13 = makeStateUpdatedEvent({
      eventId: "event-13",
      seq: 13,
      revision: 7,
    })
    await bridge.publishEvents([event11, event12, event13])

    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((message) => {
      inbound.push(message)
    })

    await bridge.connect(pair.server)
    await pair.client.send(makeConnectMessage({ resumeFromSeq: 10 }))
    expect(inbound).toEqual([
      { kind: "snapshot", snapshot },
      { kind: "event", event: event12 },
      { kind: "event", event: event13 },
    ])

    await bridge.close()
    await pair.client.close()
  })
})

describe("session transport bridge command gating", () => {
  test("duplicate commandId replays prior command events and does not re-dispatch", async () => {
    const accepted: string[] = []
    const rejected: unknown[] = []
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ revision: 5, seq: 10 }),
      onCommand: async (command) => {
        accepted.push(command.commandId)
      },
      onCommandRejected: ({ error }) => {
        rejected.push(error)
      },
    })

    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((message) => {
      inbound.push(message)
    })
    await bridge.connect(pair.server)
    await pair.client.send(makeConnectMessage({ resumeFromSeq: 10 }))
    inbound.length = 0

    const command = makeCommand({
      commandId: "dup-1",
      expectedRevision: 5,
    })
    await pair.client.send({ kind: "command", command })
    expect(accepted).toEqual(["dup-1"])

    const appliedEvent = makeStateUpdatedEvent({
      eventId: "dup-event",
      seq: 11,
      revision: 6,
      causedByCommandId: "dup-1",
    })
    await bridge.publishEvents([appliedEvent])
    inbound.length = 0

    await pair.client.send({ kind: "command", command })
    expect(accepted).toEqual(["dup-1"])
    expect(rejected[0]).toBeInstanceOf(SessionDuplicateCommandError)
    expect(inbound).toEqual([
      {
        kind: "rejected",
        sessionId: "session-1",
        target: "command",
        reason: "duplicate_command",
        commandId: "dup-1",
      },
      { kind: "event", event: appliedEvent },
    ])

    await bridge.close()
    await pair.client.close()
  })

  test("stale expectedRevision sends full resync snapshot and tail", async () => {
    const snapshot = makeSnapshot({ revision: 5, seq: 10 })
    const rejected: unknown[] = []
    const bridge = createSessionTransportBridge({
      snapshot,
      onCommandRejected: ({ error }) => {
        rejected.push(error)
      },
    })
    const liveTailEvent = makeStateUpdatedEvent({
      eventId: "live-tail",
      seq: 11,
      revision: 6,
      causedByCommandId: "other-command",
    })
    await bridge.publishEvents([liveTailEvent])

    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((message) => {
      inbound.push(message)
    })
    await bridge.connect(pair.server)
    await pair.client.send(makeConnectMessage({ resumeFromSeq: 11 }))
    inbound.length = 0

    const staleCommand = makeCommand({
      commandId: "stale-1",
      expectedRevision: 5,
    })
    await pair.client.send({ kind: "command", command: staleCommand })

    expect(rejected[0]).toBeInstanceOf(SessionRevisionConflictError)
    expect(inbound).toEqual([
      {
        kind: "rejected",
        sessionId: "session-1",
        target: "command",
        reason: "revision_conflict",
        commandId: "stale-1",
        expectedRevision: 5,
        actualRevision: 6,
      },
      { kind: "snapshot", snapshot },
      { kind: "event", event: liveTailEvent },
    ])

    await bridge.close()
    await pair.client.close()
  })

  test("wrong-session connect is rejected before any replay is sent", async () => {
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ revision: 5, seq: 10 }),
    })
    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((message) => {
      inbound.push(message)
    })
    await bridge.connect(pair.server)

    await pair.client.send(makeConnectMessage({ sessionId: "wrong-session", resumeFromSeq: 10 }))

    expect(inbound).toEqual([
      {
        kind: "rejected",
        sessionId: "session-1",
        target: "connect",
        reason: "session_id_mismatch",
        issue: "session_id_mismatch",
      },
    ])

    await bridge.close()
    await pair.client.close()
  })
})
