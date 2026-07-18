/**
 * Ticket 05 (door-level resume) — the `resumed` served-marker control frame.
 *
 * WHY THIS FRAME EXISTS (jul-16 adversarial-audit KILL, now closed): the
 * handshake's `ready` used to settle only on a SNAPSHOT frame, but the bridge
 * answers a servable resume cursor with an EVENTS-ONLY replay — ZERO frames
 * when the cursor is already at tip (`planSessionReplay`) — so a
 * resume-carrying handshake was a structural forever-hang: session.v1 carried
 * no ack that could signal "caught up". The `resumed` frame IS that ack: the
 * bridge emits it exactly once per `resumeAck`-requesting connect, AFTER the
 * whole replay answer (snapshot fallback, incremental events, or an EMPTY
 * replay), carrying how the view was restored (`mode`) and through which seq
 * (`servedThroughSeq`).
 *
 * Battery:
 *  - codec: round-trip both modes; malformed frames rejected typed; version
 *    gate identical to every other control frame.
 *  - wire-compat (ADDITIVE 7th kind, heartbeat precedent): an already-shipped
 *    peer's closed-kind gate drops the frame SILENTLY via
 *    `tryDecodeSessionTransportMessage` — pinned against a verbatim replica of
 *    the legacy gate, with a paired control that the replica still decodes all
 *    six legacy kinds (the replica itself is proven non-vacuous).
 *  - bridge emission vs the REAL bridge (jul-16 vacuous-test lesson — no
 *    hand-rolled server): opt-in only (`resumeAck` absent ⇒ byte-identical
 *    wire, including the zero-frame tip answer that WAS the hang), and the
 *    (mode, servedThroughSeq) pair per replay path: tip / in-window /
 *    snapshot-fallback / durable-log rescue / plain full connect.
 */

import { describe, expect, test } from "bun:test"
import {
  createSessionTransportBridge,
  decodeSessionTransportMessage,
  encodeSessionTransportMessage,
  type SessionDurableEventLogReader,
  type SessionTransport,
  type SessionTransportMessage,
  tryDecodeSessionTransportMessage,
} from "@/ipc/session"
import type { SessionEvent, SessionSnapshotLite } from "@/protocol/session"
import { capabilitiesFor } from "../../support/session-fixtures"

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* ------------------------------------------------------------------------- */

const makeSnapshot = (seq: number): SessionSnapshotLite => ({
  sessionId: "session-1",
  revision: seq,
  seq,
  state: {
    status: "idle",
    draftInput: "",
    permissionMode: "default",
    messageCount: 0,
  },
  capabilities: capabilitiesFor({
    approvals: "operator",
    tools: true,
    artifacts: true,
    transport: "stdio",
  }),
  pendingApproval: null,
  openArtifacts: [],
})

const makeEvent = (seq: number): SessionEvent => ({
  eventId: `event-${seq}`,
  seq,
  revision: seq,
  emittedAt: "2026-07-18T00:00:00.000Z",
  type: "session.state.updated",
  state: {
    status: "idle",
    draftInput: "",
    permissionMode: "default",
    messageCount: 0,
  },
})

/** Server-side peer harness against the REAL bridge: capture every frame the
 *  bridge sends to this peer, and let the test push client frames in. */
const connectPeer = async (bridge: ReturnType<typeof createSessionTransportBridge>) => {
  const sent: SessionTransportMessage[] = []
  const handlers = new Set<(message: SessionTransportMessage) => void | Promise<void>>()
  const transport: SessionTransport = {
    async send(message) {
      sent.push(message)
    },
    onMessage(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    async close() {
      handlers.clear()
    },
  }
  const connected = await bridge.connect(transport)
  return {
    sent,
    connected,
    async push(message: SessionTransportMessage) {
      for (const handler of [...handlers]) {
        await handler(message)
      }
    },
  }
}

const kinds = (messages: readonly SessionTransportMessage[]): string[] =>
  messages.map((message) => message.kind)

const resumedFrames = (messages: readonly SessionTransportMessage[]) =>
  messages.flatMap((message) => (message.kind === "resumed" ? [message] : []))

/* ------------------------------------------------------------------------- */
/* Codec                                                                      */
/* ------------------------------------------------------------------------- */

describe("resumed frame codec (additive 7th kind)", () => {
  test("round-trips a replay-mode resumed frame", () => {
    const message: SessionTransportMessage = {
      kind: "resumed",
      sessionId: "session-1",
      servedThroughSeq: 12,
      mode: "replay",
    }
    const parsed = decodeSessionTransportMessage(encodeSessionTransportMessage(message))
    expect(parsed).toEqual(message)
  })

  test("round-trips a snapshot-mode resumed frame", () => {
    const message: SessionTransportMessage = {
      kind: "resumed",
      sessionId: "session-1",
      servedThroughSeq: 3,
      mode: "snapshot",
    }
    const parsed = decodeSessionTransportMessage(encodeSessionTransportMessage(message))
    expect(parsed).toEqual(message)
  })

  test("malformed resumed frames are rejected typed (mode / servedThroughSeq / sessionId)", () => {
    const base = {
      version: "session.v1",
      kind: "resumed",
      sessionId: "session-1",
      servedThroughSeq: 12,
      mode: "replay",
    }
    expect(() => decodeSessionTransportMessage(JSON.stringify({ ...base, mode: "nope" }))).toThrow()
    expect(() =>
      decodeSessionTransportMessage(JSON.stringify({ ...base, servedThroughSeq: "12" })),
    ).toThrow()
    expect(() =>
      decodeSessionTransportMessage(JSON.stringify({ ...base, servedThroughSeq: undefined })),
    ).toThrow()
    expect(() => decodeSessionTransportMessage(JSON.stringify({ ...base, sessionId: "" }))).toThrow()
  })

  test("the control-frame version gate applies (a foreign-version resumed frame is dropped by tryDecode, not delivered)", () => {
    const wire = JSON.stringify({
      version: "session.v999",
      kind: "resumed",
      sessionId: "session-1",
      servedThroughSeq: 12,
      mode: "replay",
    })
    expect(tryDecodeSessionTransportMessage(wire)).toBeUndefined()
  })

  test("the connect frame's resumeAck opt-in round-trips, and stays ABSENT when not requested", () => {
    const withAck: SessionTransportMessage = {
      kind: "connect",
      sessionId: "session-1",
      resumeFromSeq: 7,
      resumeAck: true,
    }
    expect(decodeSessionTransportMessage(encodeSessionTransportMessage(withAck))).toEqual(withAck)
    const withoutAck: SessionTransportMessage = { kind: "connect", sessionId: "session-1" }
    const encoded = encodeSessionTransportMessage(withoutAck)
    expect(encoded).not.toContain("resumeAck")
    expect(decodeSessionTransportMessage(encoded)).toEqual(withoutAck)
  })
})

/* ------------------------------------------------------------------------- */
/* Old-client wire compatibility                                              */
/* ------------------------------------------------------------------------- */

/** VERBATIM replica of the pre-05 inbound gate: `decodeKind`'s closed switch
 *  (connect/command/event/rejected/snapshot/heartbeat) feeding the
 *  tryDecode → undefined → silent-drop path every shipped transport uses.
 *  An already-shipped peer has EXACTLY this gate — proving it drops `resumed`
 *  proves the frame is wire-compatible additive (heartbeat precedent). */
const legacyTryDecodeKind = (raw: string): string | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const kind = (parsed as Record<string, unknown>).kind
  switch (kind) {
    case "connect":
    case "command":
    case "event":
    case "rejected":
    case "snapshot":
    case "heartbeat":
      return kind
    default:
      return undefined // ← the silent drop (old tryDecodeSessionTransportMessage)
  }
}

describe("resumed frame — old-client compatibility (additive proof)", () => {
  test("an already-shipped peer's closed-kind gate drops an encoded resumed frame silently", () => {
    const wire = encodeSessionTransportMessage({
      kind: "resumed",
      sessionId: "session-1",
      servedThroughSeq: 12,
      mode: "replay",
    })
    expect(legacyTryDecodeKind(wire)).toBeUndefined()
  })

  test("paired control: the SAME legacy gate still decodes all six legacy kinds (the replica is not vacuous)", () => {
    const legacy: SessionTransportMessage[] = [
      { kind: "connect", sessionId: "session-1" },
      {
        kind: "command",
        command: {
          sessionId: "session-1",
          commandId: "command-1",
          issuedAt: "2026-07-18T00:00:00.000Z",
          type: "turn.run",
        },
      },
      { kind: "event", event: makeEvent(2) },
      {
        kind: "rejected",
        sessionId: "session-1",
        target: "command",
        reason: "protocol_validation",
      },
      { kind: "snapshot", snapshot: makeSnapshot(1) },
      { kind: "heartbeat", phase: "ping" },
    ]
    for (const message of legacy) {
      expect(legacyTryDecodeKind(encodeSessionTransportMessage(message))).toBe(message.kind)
    }
  })
})

/* ------------------------------------------------------------------------- */
/* Bridge emission (REAL bridge)                                              */
/* ------------------------------------------------------------------------- */

describe("bridge resumed emission (real createSessionTransportBridge)", () => {
  test("OPT-IN control: a resume connect WITHOUT resumeAck at cursor==tip is answered with ZERO frames — the pre-05 wire (and the audited hang), byte-identical", async () => {
    const bridge = createSessionTransportBridge({ snapshot: makeSnapshot(10) })
    await bridge.publishEvents([makeEvent(11), makeEvent(12)])
    const peer = await connectPeer(bridge)
    await peer.push({ kind: "connect", sessionId: "session-1", resumeFromSeq: 12 })
    expect(peer.sent).toEqual([]) // zero frames — old clients keep exactly this
    await bridge.close()
  })

  test("cursor==tip + resumeAck: EXACTLY ONE resumed frame (mode 'replay', servedThroughSeq == cursor), no snapshot, no events — the empty replay is now acknowledged", async () => {
    const bridge = createSessionTransportBridge({ snapshot: makeSnapshot(10) })
    await bridge.publishEvents([makeEvent(11), makeEvent(12)])
    const peer = await connectPeer(bridge)
    await peer.push({
      kind: "connect",
      sessionId: "session-1",
      resumeFromSeq: 12,
      resumeAck: true,
    })
    expect(peer.sent).toEqual([
      { kind: "resumed", sessionId: "session-1", servedThroughSeq: 12, mode: "replay" },
    ])
    await bridge.close()
  })

  test("in-window incremental + resumeAck: events THEN resumed (mode 'replay', servedThroughSeq == last replayed seq)", async () => {
    const bridge = createSessionTransportBridge({ snapshot: makeSnapshot(10) })
    await bridge.publishEvents([makeEvent(11), makeEvent(12), makeEvent(13)])
    const peer = await connectPeer(bridge)
    await peer.push({
      kind: "connect",
      sessionId: "session-1",
      resumeFromSeq: 11,
      resumeAck: true,
    })
    expect(kinds(peer.sent)).toEqual(["event", "event", "resumed"])
    expect(resumedFrames(peer.sent)).toEqual([
      { kind: "resumed", sessionId: "session-1", servedThroughSeq: 13, mode: "replay" },
    ])
    await bridge.close()
  })

  test("behind-window WITHOUT a durable log + resumeAck: snapshot fallback, resumed LAST (mode 'snapshot', servedThroughSeq == tail end)", async () => {
    const bridge = createSessionTransportBridge({ snapshot: makeSnapshot(10), tailLimit: 2 })
    await bridge.publishEvents([makeEvent(11), makeEvent(12), makeEvent(13), makeEvent(14)])
    const peer = await connectPeer(bridge)
    // Tail retains [13, 14]; cursor 10 is behind the window ⇒ snapshot reset.
    await peer.push({
      kind: "connect",
      sessionId: "session-1",
      resumeFromSeq: 10,
      resumeAck: true,
    })
    expect(kinds(peer.sent)).toEqual(["snapshot", "event", "event", "resumed"])
    expect(resumedFrames(peer.sent)).toEqual([
      { kind: "resumed", sessionId: "session-1", servedThroughSeq: 14, mode: "snapshot" },
    ])
    await bridge.close()
  })

  test("behind-window WITH the durable log + resumeAck: incremental rescue, resumed mode 'replay'", async () => {
    const all = [makeEvent(11), makeEvent(12), makeEvent(13), makeEvent(14)]
    const durableLog: SessionDurableEventLogReader = {
      readFrom: (afterSeq) => all.filter((event) => event.seq > afterSeq),
    }
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot(10),
      tailLimit: 2,
      durableLog,
    })
    await bridge.publishEvents(all)
    const peer = await connectPeer(bridge)
    await peer.push({
      kind: "connect",
      sessionId: "session-1",
      resumeFromSeq: 10,
      resumeAck: true,
    })
    expect(kinds(peer.sent)).toEqual(["event", "event", "event", "event", "resumed"])
    expect(resumedFrames(peer.sent)).toEqual([
      { kind: "resumed", sessionId: "session-1", servedThroughSeq: 14, mode: "replay" },
    ])
    await bridge.close()
  })

  test("a PLAIN full connect + resumeAck is acknowledged too (mode 'snapshot' — the full replay IS a snapshot restore)", async () => {
    const bridge = createSessionTransportBridge({ snapshot: makeSnapshot(10) })
    await bridge.publishEvents([makeEvent(11)])
    const peer = await connectPeer(bridge)
    await peer.push({ kind: "connect", sessionId: "session-1", resumeAck: true })
    expect(kinds(peer.sent)).toEqual(["snapshot", "event", "resumed"])
    expect(resumedFrames(peer.sent)).toEqual([
      { kind: "resumed", sessionId: "session-1", servedThroughSeq: 11, mode: "snapshot" },
    ])
    await bridge.close()
  })

  test("a NON-connect replay (duplicate-command resync) never emits resumed — the marker answers connects only", async () => {
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot(10),
      onCommand: async () => undefined,
    })
    const peer = await connectPeer(bridge)
    await peer.push({ kind: "connect", sessionId: "session-1" })
    const command = {
      sessionId: "session-1",
      commandId: "dup-1",
      issuedAt: "2026-07-18T00:00:00.000Z",
      type: "turn.run",
    } as const
    await peer.push({ kind: "command", command })
    await peer.push({ kind: "command", command }) // duplicate ⇒ rejected + resync replay
    expect(kinds(peer.sent)).not.toContain("resumed")
    expect(kinds(peer.sent)).toContain("rejected")
    await bridge.close()
  })
})
