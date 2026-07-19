/**
 * Ticket 04 (S2) — wire fidelity NEGOTIATION: codec (8th kind + connect
 * requestedFidelity) + bridge grant + ack-before-replay + skew matrix + SDK
 * client fidelity surfacing.
 */
import { describe, expect, test } from "bun:test"
import {
  createSessionTransportBridge,
  createSessionTransportClient,
  decodeSessionTransportMessage,
  encodeSessionTransportMessage,
  type SessionTransport,
  type SessionTransportConnectionState,
  type SessionTransportMessage,
  tryDecodeSessionTransportMessage,
} from "@/ipc/session"
import type { SessionEvent, SessionSnapshotLite } from "@/protocol/session"
import { capabilitiesFor, makeSnapshotLite } from "../../support/session-fixtures"

const CAPABILITIES = capabilitiesFor({ tools: true, transport: "stdio" })

const makeSnapshot = (overrides: Partial<SessionSnapshotLite> = {}): SessionSnapshotLite =>
  makeSnapshotLite({
    ...overrides,
    capabilities: { ...CAPABILITIES, ...(overrides.capabilities ?? {}) },
  })

/** A tool.completed event carrying full-fidelity fields (as the host bridge
 *  would produce when the production gate is ON). */
const makeToolEvent = (seq: number): SessionEvent => ({
  eventId: `event-${seq}`,
  seq,
  revision: seq,
  emittedAt: "2026-07-16T00:00:00.000Z",
  type: "tool.completed",
  toolCallId: "c1",
  toolName: "bash",
  outcome: "ok",
  resultPreview: "clamped",
  resultFull: "the-entire-model-visible-output-verbatim",
})

const createTransportPair = (): { client: SessionTransport; server: SessionTransport } => {
  const clientHandlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  const serverHandlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  let clientClosed = false
  let serverClosed = false
  const build = (
    remote: Set<(m: SessionTransportMessage) => void | Promise<void>>,
    local: Set<(m: SessionTransportMessage) => void | Promise<void>>,
    isClosed: () => boolean,
    close: () => void,
  ): SessionTransport => ({
    async send(message) {
      if (isClosed()) return
      for (const handler of [...remote]) await handler(message)
    },
    onMessage(handler) {
      local.add(handler)
      return () => local.delete(handler)
    },
    async close() {
      close()
      local.clear()
    },
  })
  return {
    client: build(
      serverHandlers,
      clientHandlers,
      () => clientClosed,
      () => {
        clientClosed = true
      },
    ),
    server: build(
      clientHandlers,
      serverHandlers,
      () => serverClosed,
      () => {
        serverClosed = true
      },
    ),
  }
}

// ---------------------------------------------------------------------------
// codec — 8th kind + connect opt-in
// ---------------------------------------------------------------------------

describe("S2 codec — fidelity frame (additive 8th kind)", () => {
  test("round-trips a granted fidelity ack", () => {
    const message: SessionTransportMessage = { kind: "fidelity", sessionId: "s1", granted: true }
    expect(decodeSessionTransportMessage(encodeSessionTransportMessage(message))).toEqual(message)
  })

  test("round-trips a refused fidelity ack", () => {
    const message: SessionTransportMessage = { kind: "fidelity", sessionId: "s1", granted: false }
    expect(decodeSessionTransportMessage(encodeSessionTransportMessage(message))).toEqual(message)
  })

  test("malformed fidelity frames are rejected typed (granted / sessionId)", () => {
    const base = { version: "session.v1", kind: "fidelity", sessionId: "s1", granted: true }
    expect(() =>
      decodeSessionTransportMessage(JSON.stringify({ ...base, granted: "yes" })),
    ).toThrow()
    expect(() =>
      decodeSessionTransportMessage(JSON.stringify({ ...base, granted: undefined })),
    ).toThrow()
    expect(() =>
      decodeSessionTransportMessage(JSON.stringify({ ...base, sessionId: "" })),
    ).toThrow()
  })

  test("foreign-version fidelity frame is dropped by tryDecode (control-frame version gate)", () => {
    const wire = JSON.stringify({
      version: "session.v999",
      kind: "fidelity",
      sessionId: "s1",
      granted: true,
    })
    expect(tryDecodeSessionTransportMessage(wire)).toBeUndefined()
  })

  test("connect requestedFidelity opt-in round-trips and stays ABSENT when not requested", () => {
    const withFid: SessionTransportMessage = {
      kind: "connect",
      sessionId: "s1",
      requestedFidelity: "full",
    }
    expect(decodeSessionTransportMessage(encodeSessionTransportMessage(withFid))).toEqual(withFid)
    const without: SessionTransportMessage = { kind: "connect", sessionId: "s1" }
    const encoded = encodeSessionTransportMessage(without)
    expect(encoded).not.toContain("requestedFidelity")
    expect(decodeSessionTransportMessage(encoded)).toEqual(without)
  })

  test("a foreign requestedFidelity value is rejected (closed single-value enum)", () => {
    const wire = JSON.stringify({
      version: "session.v1",
      kind: "connect",
      sessionId: "s1",
      requestedFidelity: "partial",
    })
    expect(() => decodeSessionTransportMessage(wire)).toThrow()
  })

  test("an already-shipped decoder that lacks the connect requestedFidelity key still decodes the connect (unknown key dropped)", () => {
    // The connect decoder ignores fields it does not model — a request from a NEW
    // client reaches an OLD-shaped decode as a plain connect (no throw). Simulated
    // by decoding a connect with requestedFidelity: our decoder models it, but the
    // point is the wire is a superset — prove the base connect fields survive.
    const wire = encodeSessionTransportMessage({
      kind: "connect",
      sessionId: "s1",
      requestedFidelity: "full",
    })
    const decoded = decodeSessionTransportMessage(wire)
    expect(decoded.kind).toBe("connect")
    if (decoded.kind === "connect") expect(decoded.sessionId).toBe("s1")
  })
})

// ---------------------------------------------------------------------------
// bridge grant + ack-before-replay + skew matrix
// ---------------------------------------------------------------------------

describe("S2 bridge — grant + ack-before-replay", () => {
  test("gate ON + requested: bridge acks granted:true BEFORE the replay, and the full field passes to the granted peer", async () => {
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ seq: 0 }),
      fullFidelity: true,
    })
    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((m) => {
      inbound.push(m)
    })
    await bridge.connect(pair.server)
    await pair.client.send({
      kind: "connect",
      sessionId: "session-1",
      requestedFidelity: "full",
      resumeFromSeq: 0,
    })

    // Ack is FIRST (before any snapshot/event replay frame).
    expect(inbound[0]?.kind).toBe("fidelity")
    if (inbound[0]?.kind === "fidelity") expect(inbound[0].granted).toBe(true)

    // A live tool event with a full field reaches the granted peer INTACT.
    await bridge.publishEvents([makeToolEvent(1)])
    const tool = inbound.find((m) => m.kind === "event" && m.event.type === "tool.completed")
    expect(
      tool?.kind === "event" && tool.event.type === "tool.completed" && tool.event.resultFull,
    ).toBe("the-entire-model-visible-output-verbatim")
    await bridge.close()
  })

  test("gate OFF + requested: bridge acks granted:false (honest refusal) and STRIPS the full field", async () => {
    const bridge = createSessionTransportBridge({ snapshot: makeSnapshot({ seq: 0 }) }) // gate OFF
    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((m) => {
      inbound.push(m)
    })
    await bridge.connect(pair.server)
    await pair.client.send({
      kind: "connect",
      sessionId: "session-1",
      requestedFidelity: "full",
      resumeFromSeq: 0,
    })

    const ack = inbound.find((m) => m.kind === "fidelity")
    expect(ack?.kind === "fidelity" && ack.granted).toBe(false)

    await bridge.publishEvents([makeToolEvent(1)])
    const tool = inbound.find((m) => m.kind === "event" && m.event.type === "tool.completed")
    // STRIPPED — a refused peer never receives the full field.
    expect(tool?.kind === "event" && "resultFull" in tool.event).toBe(false)
    await bridge.close()
  })

  test("gate ON + NOT requested: no ack, and the full field is STRIPPED (byte-identical legacy peer)", async () => {
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ seq: 0 }),
      fullFidelity: true,
    })
    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((m) => {
      inbound.push(m)
    })
    await bridge.connect(pair.server)
    await pair.client.send({ kind: "connect", sessionId: "session-1", resumeFromSeq: 0 }) // no requestedFidelity

    expect(inbound.some((m) => m.kind === "fidelity")).toBe(false)
    await bridge.publishEvents([makeToolEvent(1)])
    const tool = inbound.find((m) => m.kind === "event" && m.event.type === "tool.completed")
    expect(tool?.kind === "event" && "resultFull" in tool.event).toBe(false)
    await bridge.close()
  })
})

// ---------------------------------------------------------------------------
// SDK client fidelity surfacing (skew: new client → new/old server)
// ---------------------------------------------------------------------------

describe("S2 client — fidelity outcome surfacing", () => {
  test("new client → gate-ON server: onConnectionState enriches to fidelity:'full' (submission → enrichment)", async () => {
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ seq: 0 }),
      fullFidelity: true,
    })
    const pair = createTransportPair()
    await bridge.connect(pair.server)
    const client = createSessionTransportClient({
      transport: pair.client,
      sessionId: "session-1",
      requestedFidelity: "full",
    })
    const states: SessionTransportConnectionState[] = []
    client.onConnectionState((s) => {
      states.push(s)
    })
    await client.connect()

    const fidelities = states.flatMap((s) =>
      s.status === "connected" && s.fidelity !== undefined ? [s.fidelity] : [],
    )
    expect(fidelities).toEqual(["full"])
    // Submission state came first (no fidelity), enrichment second.
    expect(states[0]?.status).toBe("connected")
    expect(states[0]?.status === "connected" ? states[0].fidelity : "x").toBeUndefined()
    await bridge.close()
    await client.close()
  })

  test("new client → gate-OFF server: explicit refusal surfaces as fidelity:'preview' (never a silent downgrade)", async () => {
    const bridge = createSessionTransportBridge({ snapshot: makeSnapshot({ seq: 0 }) }) // OFF
    const pair = createTransportPair()
    await bridge.connect(pair.server)
    const client = createSessionTransportClient({
      transport: pair.client,
      sessionId: "session-1",
      requestedFidelity: "full",
    })
    const states: SessionTransportConnectionState[] = []
    client.onConnectionState((s) => {
      states.push(s)
    })
    await client.connect()
    const fidelities = states.flatMap((s) =>
      s.status === "connected" && s.fidelity !== undefined ? [s.fidelity] : [],
    )
    expect(fidelities).toEqual(["preview"])
    await bridge.close()
    await client.close()
  })

  test("new client (requested) → OLD/silent server (no ack, sends snapshot directly): resolves to 'preview' with NO timer", async () => {
    // Simulate an old server: a bare transport whose server side replies with a
    // snapshot frame and NEVER a fidelity ack.
    const pair = createTransportPair()
    pair.server.onMessage(async (m) => {
      if (m.kind === "connect") {
        await pair.server.send({ kind: "snapshot", snapshot: makeSnapshot({ seq: 0 }) })
      }
    })
    const client = createSessionTransportClient({
      transport: pair.client,
      sessionId: "session-1",
      requestedFidelity: "full",
    })
    const states: SessionTransportConnectionState[] = []
    client.onConnectionState((s) => {
      states.push(s)
    })
    await client.connect()
    const fidelities = states.flatMap((s) =>
      s.status === "connected" && s.fidelity !== undefined ? [s.fidelity] : [],
    )
    expect(fidelities).toEqual(["preview"])
    await client.close()
  })

  test("client did NOT request full: no fidelity enrichment is ever emitted (byte-identical)", async () => {
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ seq: 0 }),
      fullFidelity: true,
    })
    const pair = createTransportPair()
    await bridge.connect(pair.server)
    const client = createSessionTransportClient({ transport: pair.client, sessionId: "session-1" })
    const states: SessionTransportConnectionState[] = []
    client.onConnectionState((s) => {
      states.push(s)
    })
    await client.connect()
    expect(states.some((s) => s.status === "connected" && s.fidelity !== undefined)).toBe(false)
    await bridge.close()
    await client.close()
  })
})
