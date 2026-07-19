import { describe, expect, test } from "bun:test"
import {
  createSessionStdioTransport,
  createSessionTransportBridge,
  decodeSessionTransportMessage,
  encodeSessionTransportMessage,
  planSessionReplay,
  SessionDuplicateCommandError,
  type SessionTransport,
  type SessionTransportConnectMessage,
  type SessionTransportMessage,
  tryDecodeSessionTransportMessage,
  wrapWebSocketLikeAsSessionTransport,
} from "@/ipc/session"
import {
  type SessionCommand,
  type SessionEvent,
  SessionRevisionConflictError,
  type SessionSnapshotLite,
} from "@/protocol/session"
import { capabilitiesFor, makeSnapshotLite } from "../../support/session-fixtures"

const CAPABILITIES = capabilitiesFor({
  approvals: "operator",
  tools: true,
  artifacts: true,
  transport: "stdio",
})

const makeSnapshot = (overrides: Partial<SessionSnapshotLite> = {}): SessionSnapshotLite =>
  makeSnapshotLite({
    ...overrides,
    capabilities: { ...CAPABILITIES, ...(overrides.capabilities ?? {}) },
  })

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

describe("session transport connect-frame codec", () => {
  test("round-trips a connect frame carrying resumeFromSeq", () => {
    const message: SessionTransportMessage = {
      kind: "connect",
      sessionId: "session-1",
      resumeFromSeq: 42,
    }
    const wire = encodeSessionTransportMessage(message)
    expect(JSON.parse(wire).resumeFromSeq).toBe(42)
    expect(decodeSessionTransportMessage(wire)).toEqual(message)
  })

  test("round-trips a connect frame carrying explicit surface read-model coverage", () => {
    const message: SessionTransportConnectMessage = {
      kind: "connect",
      sessionId: "session-1",
      surfaceSubscription: {
        session: { status: "subscribed", protocol: "session.v1" },
        agentState: { status: "unsupported" },
        canvas: { status: "subscribed", protocol: "canvas.v1" },
        observability: { status: "unsupported" },
      },
    }
    const wire = encodeSessionTransportMessage(message)
    expect(JSON.parse(wire).surfaceSubscription).toEqual(message.surfaceSubscription)
    expect(decodeSessionTransportMessage(wire)).toEqual(message)
  })

  test("round-trips resumeFromSeq=0 (a valid bootstrap seq) without dropping it", () => {
    const message: SessionTransportMessage = {
      kind: "connect",
      sessionId: "session-1",
      resumeFromSeq: 0,
    }
    const wire = encodeSessionTransportMessage(message)
    expect(JSON.parse(wire).resumeFromSeq).toBe(0)
    expect(decodeSessionTransportMessage(wire)).toEqual(message)
  })

  test("a connect frame WITHOUT resumeFromSeq stays byte-identical (no key emitted)", () => {
    const message: SessionTransportMessage = {
      kind: "connect",
      sessionId: "session-1",
    }
    const wire = encodeSessionTransportMessage(message)
    expect("resumeFromSeq" in JSON.parse(wire)).toBe(false)
    // Decode preserves absence (no spurious resumeFromSeq key on the way back).
    expect(decodeSessionTransportMessage(wire)).toEqual(message)
  })
})

describe("session transport heartbeat codec", () => {
  test("round-trips a heartbeat ping frame", () => {
    const message: SessionTransportMessage = { kind: "heartbeat", phase: "ping" }
    const wire = encodeSessionTransportMessage(message)
    const parsed = JSON.parse(wire)
    expect(parsed.kind).toBe("heartbeat")
    expect(parsed.phase).toBe("ping")
    expect(decodeSessionTransportMessage(wire)).toEqual(message)
  })

  test("round-trips a heartbeat pong frame", () => {
    const message: SessionTransportMessage = { kind: "heartbeat", phase: "pong" }
    const wire = encodeSessionTransportMessage(message)
    expect(JSON.parse(wire).phase).toBe("pong")
    expect(decodeSessionTransportMessage(wire)).toEqual(message)
  })

  test("a heartbeat frame with an unknown phase is rejected", () => {
    const wire = JSON.stringify({ version: "session.v1", kind: "heartbeat", phase: "nope" })
    expect(tryDecodeSessionTransportMessage(wire)).toBeUndefined()
  })

  test("the 5 legacy transport kinds still decode unchanged (heartbeat is additive)", () => {
    // Each of the original 5 transport kinds must round-trip exactly as before —
    // heartbeat adds a 6th arm without perturbing ANY existing decoder. Loop a
    // representative frame of EVERY legacy kind so "heartbeat is additive" is
    // proven across all 5, not just `connect` (finding #6).
    const legacyFrames: readonly SessionTransportMessage[] = [
      { kind: "connect", sessionId: "session-1" },
      { kind: "command", command: makeCommand({ commandId: "legacy-command" }) },
      { kind: "event", event: makeStateUpdatedEvent({ eventId: "legacy-event", seq: 4 }) },
      {
        kind: "rejected",
        sessionId: "session-1",
        target: "command",
        reason: "duplicate_command",
        commandId: "legacy-command",
      },
      { kind: "snapshot", snapshot: makeSnapshot({ revision: 3, seq: 8 }) },
    ]
    expect(legacyFrames.map((m) => m.kind)).toEqual([
      "connect",
      "command",
      "event",
      "rejected",
      "snapshot",
    ])
    for (const message of legacyFrames) {
      expect(decodeSessionTransportMessage(encodeSessionTransportMessage(message))).toEqual(message)
    }
  })
})

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

  test("decodes connect messages with empty sessionId for bootstrap discovery", async () => {
    const harness = makeSocketHarness()
    const transport = wrapWebSocketLikeAsSessionTransport(harness.socket)
    const seen: SessionTransportMessage[] = []
    transport.onMessage((message) => {
      seen.push(message)
    })

    harness.emit(encodeSessionTransportMessage({ kind: "connect", sessionId: "" }))

    expect(seen).toEqual([{ kind: "connect", sessionId: "" }])

    await transport.close()
  })
})

describe("session transport bridge replay", () => {
  test("updates the retained snapshot without broadcasting it to already-connected peers", async () => {
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ revision: 1, seq: 1 }),
    })

    const livePair = createTransportPair()
    const liveInbound: SessionTransportMessage[] = []
    livePair.client.onMessage((message) => {
      liveInbound.push(message)
    })

    await bridge.connect(livePair.server)
    await livePair.client.send(makeConnectMessage())
    expect(liveInbound).toEqual([
      { kind: "snapshot", snapshot: makeSnapshot({ revision: 1, seq: 1 }) },
    ])

    liveInbound.length = 0
    const updatedSnapshot = makeSnapshot({
      revision: 3,
      seq: 5,
      state: {
        status: "running",
        draftInput: "hello",
        permissionMode: "default",
        messageCount: 1,
      },
    })
    bridge.updateSnapshot(updatedSnapshot)

    expect(liveInbound).toEqual([])
    expect(bridge.currentSnapshot()).toEqual(updatedSnapshot)

    const replayPair = createTransportPair()
    const replayInbound: SessionTransportMessage[] = []
    replayPair.client.onMessage((message) => {
      replayInbound.push(message)
    })
    await bridge.connect(replayPair.server)
    await replayPair.client.send(makeConnectMessage())

    expect(replayInbound).toEqual([{ kind: "snapshot", snapshot: updatedSnapshot }])

    await bridge.close()
    await livePair.client.close()
    await replayPair.client.close()
  })

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

  test("an event published while a peer is mid-handshake (connected=false) is NOT fanned out to it", async () => {
    // Finding #3 — the daemon synthesises a `session.created` event right after
    // a peer attaches but BEFORE that peer has sent its `connect` handshake. A
    // mid-handshake peer must NOT receive a stray pre-handshake event; it gets
    // its state via the snapshot/replay path when its `connect` arrives. The
    // command gate (bridge.ts) already requires `connected` — the event-publish
    // fan-out MUST mirror it.
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ revision: 1, seq: 1 }),
    })

    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((message) => {
      inbound.push(message)
    })

    // Attach but do NOT send `connect` — the peer is mid-handshake.
    await bridge.connect(pair.server)

    const strayEvent = makeStateUpdatedEvent({ eventId: "stray", seq: 2, revision: 2 })
    await bridge.publishEvents([strayEvent])

    // No stray event leaked to the un-handshaken peer.
    expect(inbound).toEqual([])

    // After the handshake the peer gets its state via snapshot/replay (the
    // event is reflected in the retained tail), NOT the lost stray.
    await pair.client.send(makeConnectMessage())
    expect(inbound).toEqual([
      { kind: "snapshot", snapshot: makeSnapshot({ revision: 1, seq: 1 }) },
      { kind: "event", event: strayEvent },
    ])

    await bridge.close()
    await pair.client.close()
  })

  test("an already-connected peer still receives live events (fan-out not regressed)", async () => {
    // Guard the fix for finding #3: a peer that HAS completed its handshake must
    // continue to receive live events fanned out by publishEvents.
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ revision: 1, seq: 1 }),
    })

    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((message) => {
      inbound.push(message)
    })

    await bridge.connect(pair.server)
    await pair.client.send(makeConnectMessage())
    // Snapshot from the handshake.
    expect(inbound).toEqual([{ kind: "snapshot", snapshot: makeSnapshot({ revision: 1, seq: 1 }) }])
    inbound.length = 0

    const liveEvent = makeStateUpdatedEvent({ eventId: "live", seq: 2, revision: 2 })
    await bridge.publishEvents([liveEvent])
    expect(inbound).toEqual([{ kind: "event", event: liveEvent }])

    await bridge.close()
    await pair.client.close()
  })

  test("a resume behind the EVICTED tail window falls back to a full snapshot", async () => {
    // Finding #4 — window-eviction fallback. Publish MORE events than the tail
    // window holds so the oldest are evicted from the retained tail; a resume
    // whose cursor sits behind the (now-shrunk) window MUST snapshot-reset
    // rather than replay a discontiguous tail. This is the eviction (`trimTail`
    // slice) path the daemon caps via WEB_DAEMON_REPLAY_WINDOW; here we drive it
    // with a tiny limit so > limit events forces eviction deterministically.
    const tailLimit = 3
    const snapshot = makeSnapshot({ revision: 1, seq: 0 })
    const bridge = createSessionTransportBridge({ snapshot, tailLimit })

    // Publish 5 events (seq 1..5) into a window of 3 → seq 1,2 evicted, the
    // retained tail is [3,4,5].
    const events = [1, 2, 3, 4, 5].map((seq) =>
      makeStateUpdatedEvent({ eventId: `event-${seq}`, seq, revision: seq + 1 }),
    )
    for (const event of events) await bridge.publishEvents([event])
    expect(bridge.currentTail().map((e) => e.seq)).toEqual([3, 4, 5])

    // Resume from seq 1 — behind the evicted window (oldest retained is 3, and
    // seq 2 is gone). The planner must fall back to the full snapshot + tail.
    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((message) => {
      inbound.push(message)
    })
    await bridge.connect(pair.server)
    await pair.client.send(makeConnectMessage({ resumeFromSeq: 1 }))

    expect(inbound[0]).toEqual({ kind: "snapshot", snapshot })
    expect(inbound.slice(1)).toEqual(events.slice(2).map((event) => ({ kind: "event", event })))

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

describe("planSessionReplay (pure replay planner)", () => {
  // Finding #1 — resume cursor AHEAD of the live tip (daemon restart / seq
  // reset). After a daemon restart the in-memory seq resets but the client's
  // resumeFromSeq is from the old high-water mark, so the cursor is ahead of
  // everything the bridge holds. The planner MUST fall back to a full snapshot
  // (mirror the behind-the-window fallback) — events-only with an empty tail
  // would leave the reconnecting client stuck with nothing.
  test("resume AHEAD of the live tip falls back to a full snapshot", () => {
    const snapshot = makeSnapshot({ revision: 2, seq: 2 })
    const event3 = makeStateUpdatedEvent({ eventId: "event-3", seq: 3, revision: 3 })
    const plan = planSessionReplay({
      snapshot,
      tail: [event3],
      resumeFromSeq: 999,
    })
    // A full SNAPSHOT, not events-only and not empty.
    expect(plan.snapshot).toEqual(snapshot)
    expect(plan.tail).toEqual([event3])
  })

  test("resume AHEAD of the live tip with an EMPTY tail still returns the snapshot", () => {
    // No retained tail at all (fresh restart). Ahead-of-tip cursor still must
    // get the snapshot — without it the client receives literally nothing.
    const snapshot = makeSnapshot({ revision: 2, seq: 2 })
    const plan = planSessionReplay({
      snapshot,
      tail: [],
      resumeFromSeq: 999,
    })
    expect(plan.snapshot).toEqual(snapshot)
    expect(plan.tail).toEqual([])
  })

  // Finding #2 — pin BOTH sides of the contiguous `oldestTailSeq - 1` boundary
  // so an off-by-one mutant (e.g. `< oldestTailSeq` instead of
  // `< oldestTailSeq - 1`) is killed.
  test("resume exactly contiguous with the tail (oldestTailSeq - 1) replays events-only", () => {
    const snapshot = makeSnapshot({ revision: 5, seq: 5 })
    const event11 = makeStateUpdatedEvent({ eventId: "event-11", seq: 11, revision: 6 })
    const event12 = makeStateUpdatedEvent({ eventId: "event-12", seq: 12, revision: 6 })
    const event13 = makeStateUpdatedEvent({ eventId: "event-13", seq: 13, revision: 7 })
    // oldestTailSeq=11, so resumeFromSeq=10 is exactly contiguous (no gap).
    const plan = planSessionReplay({
      snapshot,
      tail: [event11, event12, event13],
      resumeFromSeq: 10,
    })
    expect(plan.snapshot).toBeUndefined()
    expect(plan.tail).toEqual([event11, event12, event13])
  })

  test("resume one below the contiguous boundary (oldestTailSeq - 2) falls back to snapshot (gap)", () => {
    const snapshot = makeSnapshot({ revision: 5, seq: 5 })
    const event11 = makeStateUpdatedEvent({ eventId: "event-11", seq: 11, revision: 6 })
    const event12 = makeStateUpdatedEvent({ eventId: "event-12", seq: 12, revision: 6 })
    const event13 = makeStateUpdatedEvent({ eventId: "event-13", seq: 13, revision: 7 })
    // oldestTailSeq=11, resumeFromSeq=9 leaves a gap (event 10 was evicted) so
    // the planner MUST snapshot-reset rather than replay a discontiguous tail.
    const plan = planSessionReplay({
      snapshot,
      tail: [event11, event12, event13],
      resumeFromSeq: 9,
    })
    expect(plan.snapshot).toEqual(snapshot)
    expect(plan.tail).toEqual([event11, event12, event13])
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
