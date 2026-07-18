/**
 * Ticket 05 — DOOR-LEVEL resume: `connect({ resumeFromSeq })` against the
 * REAL transport bridge (`createSessionTransportBridge` ± durableLog).
 *
 * Written RED-FIRST (hellgate): the `resumeFromSeq` option had been
 * adversarial-audit KILLED out of ticket 01 because the handshake could only
 * settle on a snapshot frame while the bridge answers a servable cursor with
 * events-only — ZERO frames at cursor==tip — a structural forever-hang. The
 * `resumed` served-marker frame closes the ack gap; this suite pins the whole
 * door-level composition on the FIVE scenarios the ticket names, every one
 * against the real bridge (jul-16 vacuous-test lesson: no hand-rolled server
 * doubles for resume semantics):
 *
 *   1. cursor==tip     — 0 replay frames; connect() settles on `resumed`
 *                        (bounded — THIS was the audited hang), resume:
 *                        "replayed", lastSeq() == cursor, live events flow.
 *   2. in-window       — incremental event replay; the handshake-window buffer
 *                        re-delivers every replayed event to the handle's
 *                        subscribers (loss == 0), resume: "replayed".
 *   3. behind-window + durableLog — the on-disk segment rescues an
 *                        events-only replay, resume: "replayed".
 *   4. behind-window, NO log — honest snapshot fallback, surfaced LOUD as
 *                        resume: "snapshot_fallback" (silent demotion = red).
 *   5. old-client sim  — the attach-shaped flows are byte-identical: a plain
 *                        (non-resume) door connect and a RAW-client resume
 *                        connect both see ZERO resumed frames on the wire
 *                        (emission is resumeAck-opt-in; the raw client — H's
 *                        watcher — is deliberately unmodified).
 */

import { describe, expect, test } from "bun:test"
import {
  createSessionTransportBridge,
  createSessionTransportClient,
  type SessionDurableEventLogReader,
  type SessionTransport,
  type SessionTransportConnectionState,
  type SessionTransportMessage,
} from "@/ipc/session"
import type { SessionEvent, SessionSnapshotLite } from "@/protocol/session"
import { connect, transports } from "@/sdk"
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

/** In-memory duplex pair (the sdk-connect e2e shape): `send` AWAITS the remote
 *  handlers, so the bridge's whole replay answer — `resumed` included —
 *  completes inside the handshake's send await. */
const createTransportPair = (): { client: SessionTransport; server: SessionTransport } => {
  const clientHandlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  const serverHandlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  const build = (
    local: Set<(m: SessionTransportMessage) => void | Promise<void>>,
    remote: Set<(m: SessionTransportMessage) => void | Promise<void>>,
  ): SessionTransport => ({
    async send(message) {
      for (const handler of [...remote]) await handler(message)
    },
    onMessage(handler) {
      local.add(handler)
      return () => {
        local.delete(handler)
      }
    },
    async close() {
      local.clear()
    },
  })
  return {
    client: build(clientHandlers, serverHandlers),
    server: build(serverHandlers, clientHandlers),
  }
}

/** Bounded diagnostic race — the regression mode here is a FOREVER-PENDING
 *  connect() (the audited hang); it must fail loud, not wedge the suite. */
const bounded = async <T>(p: Promise<T>, label: string, ms = 5_000): Promise<T> =>
  await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms),
    ),
  ])

/** A real bridge published on the server side of a fresh duplex pair, plus a
 *  server-side wire tap of every frame the bridge sent to this peer. */
const makeBridgeHarness = async (opts: {
  readonly snapshot: SessionSnapshotLite
  readonly tailLimit?: number
  readonly durableLog?: SessionDurableEventLogReader
  readonly events?: readonly SessionEvent[]
}) => {
  const bridge = createSessionTransportBridge({
    snapshot: opts.snapshot,
    ...(opts.tailLimit !== undefined ? { tailLimit: opts.tailLimit } : {}),
    ...(opts.durableLog !== undefined ? { durableLog: opts.durableLog } : {}),
  })
  if (opts.events !== undefined && opts.events.length > 0) {
    await bridge.publishEvents(opts.events)
  }
  const pair = createTransportPair()
  // Server→client wire tap (frames the CLIENT will receive).
  const serverSent: SessionTransportMessage[] = []
  pair.client.onMessage((message) => {
    serverSent.push(message)
  })
  const connected = await bridge.connect(pair.server)
  return { bridge, pair, serverSent, connected }
}

const resumedKinds = (messages: readonly SessionTransportMessage[]) =>
  messages.filter((message) => message.kind === "resumed")

const connectedStates = (states: readonly SessionTransportConnectionState[]) =>
  states.flatMap((state) => (state.status === "connected" ? [state] : []))

/* ------------------------------------------------------------------------- */
/* The five scenarios                                                         */
/* ------------------------------------------------------------------------- */

describe("connect({resumeFromSeq}) — door-level resume against the real bridge", () => {
  test("1. cursor==tip: ZERO replay frames, connect() settles on the resumed marker (the audited hang case), resume:'replayed', live events flow", async () => {
    const harness = await makeBridgeHarness({
      snapshot: makeSnapshot(10),
      events: [makeEvent(11), makeEvent(12)],
    })
    const states: SessionTransportConnectionState[] = []
    const handle = await bounded(
      connect({
        transport: transports.stdio({ transport: harness.pair.client }),
        resumeFromSeq: 12,
        onConnectionState: (state) => {
          states.push(state)
        },
      }),
      "connect() at cursor==tip (the pre-fix structural hang)",
    )

    // The empty replay really was empty — no snapshot, no events, ONE resumed.
    expect(harness.serverSent.filter((m) => m.kind === "snapshot")).toEqual([])
    expect(harness.serverSent.filter((m) => m.kind === "event")).toEqual([])
    expect(resumedKinds(harness.serverSent)).toEqual([
      { kind: "resumed", sessionId: "session-1", servedThroughSeq: 12, mode: "replay" },
    ])

    // Outcome surfacing + cursor integrity.
    const seen = connectedStates(states)
    expect(seen.at(-1)).toEqual({ status: "connected", resume: "replayed" })
    expect(seen.some((state) => state.resume === "snapshot_fallback")).toBe(false)
    expect(handle.sessionId).toBe("session-1")
    expect(handle.lastSeq()).toBe(12)
    // No snapshot frame was ever received ⇒ the cache is honestly empty.
    expect(await handle.snapshot()).toBeUndefined()

    // The connection is LIVE past the handshake: a fresh publish arrives.
    const live: SessionEvent[] = []
    handle.subscribe((event) => {
      live.push(event)
    })
    await harness.bridge.publishEvents([makeEvent(13)])
    expect(live.map((event) => event.seq)).toEqual([13])
    expect(handle.lastSeq()).toBe(13)

    await handle.close()
    await harness.bridge.close()
  })

  test("2. in-window incremental: the replay events are re-delivered to handle subscribers (loss == 0), resume:'replayed', no snapshot frame", async () => {
    const harness = await makeBridgeHarness({
      snapshot: makeSnapshot(10),
      events: [makeEvent(11), makeEvent(12), makeEvent(13)],
    })
    const states: SessionTransportConnectionState[] = []
    const handle = await bounded(
      connect({
        transport: transports.stdio({ transport: harness.pair.client }),
        resumeFromSeq: 11,
        onConnectionState: (state) => {
          states.push(state)
        },
      }),
      "connect() in-window incremental",
    )

    expect(harness.serverSent.filter((m) => m.kind === "snapshot")).toEqual([])
    expect(
      harness.serverSent.flatMap((m) => (m.kind === "event" ? [m.event.seq] : [])),
    ).toEqual([12, 13])
    expect(resumedKinds(harness.serverSent)).toEqual([
      { kind: "resumed", sessionId: "session-1", servedThroughSeq: 13, mode: "replay" },
    ])

    // M-2 replay buffer: a subscriber attached AFTER connect() still receives
    // the handshake-window replay — the disconnect gap is delivered, not lost.
    const seen: SessionEvent[] = []
    handle.subscribe((event) => {
      seen.push(event)
    })
    expect(seen.map((event) => event.seq)).toEqual([12, 13])
    expect(seen[0]?.eventId).toBe("event-12") // identity, not a re-synthesis

    expect(connectedStates(states).at(-1)).toEqual({ status: "connected", resume: "replayed" })
    expect(handle.lastSeq()).toBe(13)

    await handle.close()
    await harness.bridge.close()
  })

  test("3. behind-window + durableLog: the on-disk segment rescues an events-only replay, resume:'replayed'", async () => {
    const all = [makeEvent(11), makeEvent(12), makeEvent(13), makeEvent(14)]
    const durableLog: SessionDurableEventLogReader = {
      readFrom: (afterSeq) => all.filter((event) => event.seq > afterSeq),
    }
    const harness = await makeBridgeHarness({
      snapshot: makeSnapshot(10),
      tailLimit: 2, // retains [13, 14] — cursor 10 is behind the memory window
      durableLog,
      events: all,
    })
    const states: SessionTransportConnectionState[] = []
    const handle = await bounded(
      connect({
        transport: transports.stdio({ transport: harness.pair.client }),
        resumeFromSeq: 10,
        onConnectionState: (state) => {
          states.push(state)
        },
      }),
      "connect() durable-log rescue",
    )

    expect(harness.serverSent.filter((m) => m.kind === "snapshot")).toEqual([])
    expect(
      harness.serverSent.flatMap((m) => (m.kind === "event" ? [m.event.seq] : [])),
    ).toEqual([11, 12, 13, 14])
    expect(resumedKinds(harness.serverSent)).toEqual([
      { kind: "resumed", sessionId: "session-1", servedThroughSeq: 14, mode: "replay" },
    ])

    const seen: SessionEvent[] = []
    handle.subscribe((event) => {
      seen.push(event)
    })
    expect(seen.map((event) => event.seq)).toEqual([11, 12, 13, 14])
    expect(connectedStates(states).at(-1)).toEqual({ status: "connected", resume: "replayed" })
    expect(handle.lastSeq()).toBe(14)

    await handle.close()
    await harness.bridge.close()
  })

  test("4. behind-window WITHOUT a log: snapshot fallback + the demotion is SURFACED as resume:'snapshot_fallback' (silent demotion = red)", async () => {
    const harness = await makeBridgeHarness({
      snapshot: makeSnapshot(10),
      tailLimit: 2,
      events: [makeEvent(11), makeEvent(12), makeEvent(13), makeEvent(14)],
    })
    const states: SessionTransportConnectionState[] = []
    const handle = await bounded(
      connect({
        transport: transports.stdio({ transport: harness.pair.client }),
        resumeFromSeq: 10,
        onConnectionState: (state) => {
          states.push(state)
        },
      }),
      "connect() snapshot fallback",
    )

    // The wire really fell back: after the id-adoption reject leg, the reply
    // to the adopted connect is a SNAPSHOT first, then the retained tail.
    expect(harness.serverSent.map((m) => m.kind)).toEqual([
      "rejected", // discovery sentinel → canonical-id adoption (normal leg)
      "snapshot",
      "event",
      "event",
      "resumed",
    ])
    expect(resumedKinds(harness.serverSent)).toEqual([
      { kind: "resumed", sessionId: "session-1", servedThroughSeq: 14, mode: "snapshot" },
    ])

    const seen = connectedStates(states)
    expect(seen.at(-1)).toEqual({ status: "connected", resume: "snapshot_fallback" })
    expect(seen.some((state) => state.resume === "replayed")).toBe(false)
    // The fallback snapshot seeds the cache (state is restored, not lost).
    expect((await handle.snapshot())?.snapshot.seq).toBe(10)
    // The retained tail still rides along (buffer re-delivery).
    const seenEvents: SessionEvent[] = []
    handle.subscribe((event) => {
      seenEvents.push(event)
    })
    expect(seenEvents.map((event) => event.seq)).toEqual([13, 14])
    expect(handle.lastSeq()).toBe(14)

    await handle.close()
    await harness.bridge.close()
  })

  test("5a. old-harness control: a PLAIN door connect (no resumeFromSeq) sees ZERO resumed frames — the attach-shaped handshake wire is untouched", async () => {
    const harness = await makeBridgeHarness({
      snapshot: makeSnapshot(10),
      events: [makeEvent(11)],
    })
    const states: SessionTransportConnectionState[] = []
    const handle = await bounded(
      connect({
        transport: transports.stdio({ transport: harness.pair.client }),
        onConnectionState: (state) => {
          states.push(state)
        },
      }),
      "plain connect()",
    )
    expect(resumedKinds(harness.serverSent)).toEqual([])
    // …and the connected payload carries NO resume field (pre-05 byte-identical).
    const seen = connectedStates(states)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((state) => state.resume === undefined)).toBe(true)
    await handle.close()
    await harness.bridge.close()
  })

  test("5b. raw-client control: a RAW createSessionTransportClient resume connect (H's watcher, unmodified) never receives a resumed frame — emission is strictly resumeAck-opt-in", async () => {
    const harness = await makeBridgeHarness({
      snapshot: makeSnapshot(10),
      events: [makeEvent(11), makeEvent(12)],
    })
    const inbound: SessionTransportMessage[] = []
    const states: SessionTransportConnectionState[] = []
    const client = createSessionTransportClient({
      transport: harness.pair.client,
      sessionId: "session-1",
      resumeFromSeq: 11,
    })
    client.onMessage((message) => {
      inbound.push(message)
    })
    client.onConnectionState((state) => {
      states.push(state)
    })
    await client.connect()

    // Exactly the pre-05 raw wire: the incremental event, NOTHING else.
    expect(inbound).toEqual([{ kind: "event", event: makeEvent(12) }])
    // …and H's watcher semantics hold unchanged (first frame = event ⇒ replayed).
    expect(connectedStates(states)).toEqual([
      { status: "connected" },
      { status: "connected", resume: "replayed" },
    ])

    await client.close()
    await harness.bridge.close()
  })
})
