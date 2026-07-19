/**
 * Ticket 05 — client-side resume-outcome surfacing on `onConnectionState`.
 *
 * Contract (wire OBSERVATION, no protocol change — the bridge's replay planner
 * sends a `snapshot` frame only on its fallback paths):
 *   - a resumeFromSeq-carrying `connect()` emits the usual submission
 *     `connected` first, then a SECOND `connected` with
 *     `resume: "replayed" | "snapshot_fallback"` as soon as the first
 *     snapshot/event frame reveals the outcome — in that order on every
 *     transport (early sync answers included);
 *   - a connect WITHOUT a resume cursor never gets a `resume` field (byte-
 *     identical to the pre-05 client);
 *   - the watch is once-per-connect (no re-derivation from later frames),
 *     survives heartbeats untouched, is disarmed by a `rejected` frame
 *     targeting the connect (a refusal has no resume outcome) and by a
 *     throwing `send` (the connect never happened);
 *   - an EMPTY replay (cursor already at the tip) emits nothing extra until a
 *     later live event resolves the watch as "replayed" — nothing was lost.
 */

import { describe, expect, test } from "bun:test"
import {
  createSessionTransportClient,
  type SessionTransport,
  type SessionTransportConnectionState,
  type SessionTransportHandler,
  type SessionTransportMessage,
} from "@/ipc/session"
import type { SessionEvent } from "@/protocol/session"
import { makeSnapshotLite } from "../../support/session-fixtures"

const makeEvent = (seq: number): SessionEvent => ({
  eventId: `event-${seq}`,
  seq,
  revision: seq,
  emittedAt: "2026-07-16T00:00:00.000Z",
  type: "session.state.updated",
  state: {
    status: "idle",
    draftInput: "",
    permissionMode: "default",
    messageCount: 0,
  },
})

const SNAPSHOT_FRAME: SessionTransportMessage = {
  kind: "snapshot",
  snapshot: makeSnapshotLite({
    sessionId: "session-1",
    revision: 3,
    seq: 3,
    capabilities: { approvals: "operator", tools: true, artifacts: true, transport: "stdio" },
  }),
}

/** Manual transport: frames are pushed by the test AFTER `connect()` resolved
 *  — the asynchronous ("late") answer shape of real ws/stdio transports. */
const makeManualTransport = () => {
  const handlers = new Set<SessionTransportHandler>()
  const sent: SessionTransportMessage[] = []
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
  return {
    transport,
    sent,
    push(message: SessionTransportMessage) {
      for (const handler of [...handlers]) {
        void handler(message)
      }
    },
  }
}

const collectStates = (client: {
  onConnectionState(handler: (state: SessionTransportConnectionState) => void): () => void
}): SessionTransportConnectionState[] => {
  const states: SessionTransportConnectionState[] = []
  client.onConnectionState((state) => {
    states.push(state)
  })
  return states
}

describe("ticket 05 — client resume-outcome surfacing (late/async answers)", () => {
  test("first frame is an EVENT ⇒ enrichment 'replayed', exactly once, after the submission state", async () => {
    const harness = makeManualTransport()
    const client = createSessionTransportClient({
      transport: harness.transport,
      sessionId: "session-1",
      resumeFromSeq: 5,
    })
    const states = collectStates(client)

    await client.connect()
    expect(states).toEqual([{ status: "connected" }])

    harness.push({ kind: "event", event: makeEvent(6) })
    expect(states).toEqual([{ status: "connected" }, { status: "connected", resume: "replayed" }])

    // Once-per-connect: further frames never re-derive.
    harness.push({ kind: "event", event: makeEvent(7) })
    harness.push(SNAPSHOT_FRAME)
    expect(states).toHaveLength(2)

    await client.close()
  })

  test("first frame is a SNAPSHOT ⇒ enrichment 'snapshot_fallback' (the demotion is loud)", async () => {
    const harness = makeManualTransport()
    const client = createSessionTransportClient({
      transport: harness.transport,
      sessionId: "session-1",
      resumeFromSeq: 5,
    })
    const states = collectStates(client)

    await client.connect()
    harness.push(SNAPSHOT_FRAME)
    expect(states).toEqual([
      { status: "connected" },
      { status: "connected", resume: "snapshot_fallback" },
    ])

    await client.close()
  })

  test("CONTROL: a connect without a resume cursor never carries `resume` — pre-05 byte-identical", async () => {
    const harness = makeManualTransport()
    const client = createSessionTransportClient({
      transport: harness.transport,
      sessionId: "session-1",
    })
    const states = collectStates(client)

    await client.connect()
    harness.push(SNAPSHOT_FRAME)
    harness.push({ kind: "event", event: makeEvent(4) })

    expect(states).toEqual([{ status: "connected" }])
    expect(states.some((state) => state.status === "connected" && state.resume !== undefined)).toBe(
      false,
    )
    // The connect frame itself carried no cursor (sanity on the arming input).
    expect(harness.sent[0]).toEqual({ kind: "connect", sessionId: "session-1" })

    await client.close()
  })

  test("EMPTY replay (cursor at tip): no enrichment until a later live event resolves the watch as 'replayed'", async () => {
    const harness = makeManualTransport()
    const client = createSessionTransportClient({
      transport: harness.transport,
      sessionId: "session-1",
      resumeFromSeq: 9,
    })
    const states = collectStates(client)

    await client.connect()
    // Nothing to replay ⇒ nothing arrives ⇒ no premature verdict.
    expect(states).toEqual([{ status: "connected" }])

    harness.push({ kind: "event", event: makeEvent(10) })
    expect(states).toEqual([{ status: "connected" }, { status: "connected", resume: "replayed" }])

    await client.close()
  })

  test("a rejected frame targeting the CONNECT disarms the watch: no outcome, and later frames mint none", async () => {
    const harness = makeManualTransport()
    const client = createSessionTransportClient({
      transport: harness.transport,
      sessionId: "session-1",
      resumeFromSeq: 5,
    })
    const states = collectStates(client)

    await client.connect()
    harness.push({
      kind: "rejected",
      sessionId: "session-1",
      target: "connect",
      reason: "session_id_mismatch",
    })
    harness.push({ kind: "event", event: makeEvent(6) })

    expect(states).toEqual([{ status: "connected" }])

    await client.close()
  })

  test("heartbeats pass through an armed watch untouched; the next event still derives", async () => {
    const harness = makeManualTransport()
    const client = createSessionTransportClient({
      transport: harness.transport,
      sessionId: "session-1",
      resumeFromSeq: 5,
    })
    const states = collectStates(client)

    await client.connect()
    harness.push({ kind: "heartbeat", phase: "pong" })
    expect(states).toEqual([{ status: "connected" }])

    harness.push({ kind: "event", event: makeEvent(6) })
    expect(states).toEqual([{ status: "connected" }, { status: "connected", resume: "replayed" }])

    await client.close()
  })

  test("a throwing send clears the watch (the connect never happened): a later frame mints no outcome", async () => {
    const handlers = new Set<SessionTransportHandler>()
    const transport: SessionTransport = {
      async send() {
        throw new Error("wire down")
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
    const client = createSessionTransportClient({
      transport,
      sessionId: "session-1",
      resumeFromSeq: 5,
    })
    const states = collectStates(client)

    await expect(client.connect()).rejects.toThrow("wire down")
    for (const handler of [...handlers]) {
      void handler({ kind: "event", event: makeEvent(6) })
    }
    expect(states).toEqual([])

    await client.close()
  })

  test("re-connect replaces the watch: two armed connects, one answer ⇒ exactly one enrichment", async () => {
    const harness = makeManualTransport()
    const client = createSessionTransportClient({
      transport: harness.transport,
      sessionId: "session-1",
      resumeFromSeq: 5,
    })
    const states = collectStates(client)

    await client.connect()
    await client.connect() // latest connect wins the (still-unanswered) watch
    harness.push(SNAPSHOT_FRAME)

    expect(states).toEqual([
      { status: "connected" },
      { status: "connected" },
      { status: "connected", resume: "snapshot_fallback" },
    ])

    await client.close()
  })

  test("auto-cursor re-connect: the SECOND connect of a plain client is armed by the accumulated resumeFromSeq", async () => {
    const harness = makeManualTransport()
    const client = createSessionTransportClient({
      transport: harness.transport,
      sessionId: "session-1",
    })
    const states = collectStates(client)

    await client.connect() // no cursor anywhere ⇒ not armed
    harness.push({ kind: "event", event: makeEvent(7) }) // live traffic, no enrichment
    expect(states).toEqual([{ status: "connected" }])

    await client.connect() // auto-resume: carries the observed high-water mark
    expect(harness.sent.at(-1)).toEqual({
      kind: "connect",
      sessionId: "session-1",
      resumeFromSeq: 7,
    })
    harness.push({ kind: "event", event: makeEvent(8) })
    expect(states).toEqual([
      { status: "connected" },
      { status: "connected" },
      { status: "connected", resume: "replayed" },
    ])

    await client.close()
  })

  test("EARLY sync answer (in-proc transport answers inside the send await): submission → enrichment order still holds", async () => {
    // A transport whose `send` delivers the server's whole replay answer
    // synchronously, BEFORE the client's connect() resumes — the derivation
    // happens before the submission emission and must be HELD, then flushed.
    const handlers = new Set<SessionTransportHandler>()
    const transport: SessionTransport = {
      async send(message) {
        if (message.kind === "connect") {
          for (const handler of [...handlers]) {
            void handler({ kind: "event", event: makeEvent(6) })
          }
        }
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
    const client = createSessionTransportClient({
      transport,
      sessionId: "session-1",
      resumeFromSeq: 5,
    })
    const states = collectStates(client)

    await client.connect()
    expect(states).toEqual([{ status: "connected" }, { status: "connected", resume: "replayed" }])

    await client.close()
  })
})
