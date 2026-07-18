/**
 * Ticket 05 — durable incremental replay: planner seam battery + bridge wiring.
 *
 * `planSessionReplay` grew an optional `durableLog` feed (ticket 05): the three
 * historical snapshot-fallback paths (behind-window / ahead-of-tip / in-window
 * gap) first try an incremental EVENT replay merged from the on-disk segment
 * and the in-memory tail. The seam contract under test here, exhaustively:
 *
 *   - memory fast path untouched: a tail that reaches the cursor contiguously
 *     answers ALONE — the durable feed is not even consulted;
 *   - log-only rescue (post-restart empty tail) and log+tail merge (overlap
 *     deduplicated BY SEQ, tail object preferred) both serve `(cursor, tip]`
 *     with zero duplicates and zero holes;
 *   - ±1 boundary precision at the log↔tail seam (contiguous joins replay, a
 *     single missing seq falls back);
 *   - cursor extremes: 0 (full-history replay), == tip (empty events-only via
 *     the fast path, feed not consulted), > tip (snapshot fallback even when
 *     the log claims MORE events — never replay beyond the bridge tip);
 *   - a hostile feed (duplicate seqs, out-of-range junk, throwing reader) can
 *     neither crash the connect path nor smuggle a duplicate/hole through;
 *   - bridge level: rescue over a live transport, multi-peer isolation (one
 *     peer's durable replay leaks nothing to a live sibling; the next live
 *     fan-out reaches both exactly once), and the no-feed control staying on
 *     the historical snapshot fallback.
 */

import { describe, expect, test } from "bun:test"
import {
  createSessionTransportBridge,
  planSessionReplay,
  type SessionDurableEventLogReader,
  type SessionTransport,
  type SessionTransportMessage,
} from "@/ipc/session"
import type { SessionEvent, SessionSnapshotLite } from "@/protocol/session"
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

const makeEvent = (
  seq: number,
  overrides: Partial<Extract<SessionEvent, { type: "session.state.updated" }>> = {},
): Extract<SessionEvent, { type: "session.state.updated" }> => ({
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
  ...overrides,
})

/** Counting fake feed — `calls` proves whether the planner consulted it. */
const makeFeed = (
  events: readonly SessionEvent[],
): SessionDurableEventLogReader & { readonly calls: number[] } => {
  const calls: number[] = []
  return {
    calls,
    readFrom(afterSeq: number) {
      calls.push(afterSeq)
      return events.filter((event) => event.seq > afterSeq)
    },
  }
}

const seqsOf = (events: readonly SessionEvent[]): number[] => events.map((event) => event.seq)

// ---------------------------------------------------------------------------
// planner — memory fast path is untouched (and the feed is NOT consulted)
// ---------------------------------------------------------------------------

describe("planSessionReplay + durableLog — memory fast path untouched", () => {
  test("tail alone serves a contiguous cursor: events-only, durable feed NEVER consulted", () => {
    const feed = makeFeed([makeEvent(6), makeEvent(7), makeEvent(8)])
    const plan = planSessionReplay({
      snapshot: makeSnapshot({ seq: 5, revision: 5 }),
      tail: [makeEvent(6), makeEvent(7), makeEvent(8)],
      resumeFromSeq: 6,
      durableLog: feed,
    })
    expect(plan.snapshot).toBeUndefined()
    expect(seqsOf(plan.tail)).toEqual([7, 8])
    expect(feed.calls).toEqual([])
  })

  test("boundary: cursor EXACTLY at oldestTailSeq - 1 stays on the memory path (feed not consulted)", () => {
    const feed = makeFeed([makeEvent(6), makeEvent(7)])
    const plan = planSessionReplay({
      snapshot: makeSnapshot({ seq: 5, revision: 5 }),
      tail: [makeEvent(6), makeEvent(7)],
      resumeFromSeq: 5, // oldestTailSeq(6) - 1 — contiguous, no gap
      durableLog: feed,
    })
    expect(plan.snapshot).toBeUndefined()
    expect(seqsOf(plan.tail)).toEqual([6, 7])
    expect(feed.calls).toEqual([])
  })

  test("cursor == tip: empty events-only via the fast path, feed not consulted", () => {
    const feed = makeFeed([makeEvent(6), makeEvent(7)])
    const plan = planSessionReplay({
      snapshot: makeSnapshot({ seq: 5, revision: 5 }),
      tail: [makeEvent(6), makeEvent(7)],
      resumeFromSeq: 7,
      durableLog: feed,
    })
    expect(plan.snapshot).toBeUndefined()
    expect(plan.tail).toEqual([])
    expect(feed.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// planner — durable rescue arms
// ---------------------------------------------------------------------------

describe("planSessionReplay + durableLog — incremental rescue", () => {
  test("log-only rescue (restart shape: empty tail, cursor behind the snapshot): events-only, no snapshot", () => {
    // Restart: bridge snapshot pinned at tip 5, no memory tail; log holds 1..5.
    const feed = makeFeed([1, 2, 3, 4, 5].map((seq) => makeEvent(seq)))
    const plan = planSessionReplay({
      snapshot: makeSnapshot({ seq: 5, revision: 5 }),
      tail: [],
      resumeFromSeq: 2,
      durableLog: feed,
    })
    expect(plan.snapshot).toBeUndefined()
    expect(seqsOf(plan.tail)).toEqual([3, 4, 5])
    expect(feed.calls).toEqual([2])
  })

  test("log+tail merge across the seam: overlap deduplicated by seq, tail object preferred, no hole", () => {
    // Log holds 1..7 (append-before-publish ⇒ log ⊇ tail); memory tail holds
    // 6..7 with DISTINCT eventIds so the collision winner is observable.
    const logSix = makeEvent(6, { eventId: "log-6" })
    const tailSix = makeEvent(6, { eventId: "tail-6" })
    const tailSeven = makeEvent(7, { eventId: "tail-7" })
    const feed = makeFeed([makeEvent(3), makeEvent(4), makeEvent(5), logSix, makeEvent(7)])
    const plan = planSessionReplay({
      snapshot: makeSnapshot({ seq: 5, revision: 5 }),
      tail: [tailSix, tailSeven],
      resumeFromSeq: 2,
      durableLog: feed,
    })
    expect(plan.snapshot).toBeUndefined()
    expect(seqsOf(plan.tail)).toEqual([3, 4, 5, 6, 7])
    // Dedup direction: the bridge's own live object wins the seq collision.
    expect(plan.tail.find((event) => event.seq === 6)?.eventId).toBe("tail-6")
    // Zero duplicates (the red-on-injection tripwire for the seam merge:
    // concatenating instead of seq-merging emits seq 6 twice here).
    expect(new Set(seqsOf(plan.tail)).size).toBe(plan.tail.length)
  })

  test("seam boundary +0 (log ends exactly one below the oldest tail seq): contiguous join replays", () => {
    // Log 3..5, tail 6..7 — 5→6 is contiguous: rescue must succeed.
    const feed = makeFeed([makeEvent(3), makeEvent(4), makeEvent(5)])
    const plan = planSessionReplay({
      snapshot: makeSnapshot({ seq: 5, revision: 5 }),
      tail: [makeEvent(6), makeEvent(7)],
      resumeFromSeq: 2,
      durableLog: feed,
    })
    expect(plan.snapshot).toBeUndefined()
    expect(seqsOf(plan.tail)).toEqual([3, 4, 5, 6, 7])
  })

  test("seam boundary -1 (single missing seq between log end and tail start): snapshot fallback", () => {
    // Log 3..4 only (5 missing), tail 6..7 — hole at 5: refuse the replay.
    const feed = makeFeed([makeEvent(3), makeEvent(4)])
    const snapshot = makeSnapshot({ seq: 5, revision: 5 })
    const tail = [makeEvent(6), makeEvent(7)]
    const plan = planSessionReplay({ snapshot, tail, resumeFromSeq: 2, durableLog: feed })
    expect(plan.snapshot).toEqual(snapshot)
    expect(seqsOf(plan.tail)).toEqual([6, 7])
  })

  test("hole at the FIRST rescued seq (cursor+1 missing): snapshot fallback", () => {
    // Cursor 2 ⇒ replay must start at 3; log starts at 4.
    const feed = makeFeed([makeEvent(4), makeEvent(5)])
    const snapshot = makeSnapshot({ seq: 5, revision: 5 })
    const plan = planSessionReplay({ snapshot, tail: [], resumeFromSeq: 2, durableLog: feed })
    expect(plan.snapshot).toEqual(snapshot)
  })

  test("cursor 0: full-history events-only replay", () => {
    const feed = makeFeed([1, 2, 3].map((seq) => makeEvent(seq)))
    const plan = planSessionReplay({
      snapshot: makeSnapshot({ seq: 3, revision: 3 }),
      tail: [],
      resumeFromSeq: 0,
      durableLog: feed,
    })
    expect(plan.snapshot).toBeUndefined()
    expect(seqsOf(plan.tail)).toEqual([1, 2, 3])
  })

  test("cursor AHEAD of the tip: snapshot fallback even when the log claims MORE events (never replay beyond the bridge tip, never an empty events-only answer)", () => {
    // Log runs ahead to 9 (in-flight appends / foreign junk) but the bridge
    // tip is 5. A cursor of 7 must NOT be answered from the log — those events
    // were never fanned out by this bridge and the live publish will carry
    // them; an events-only [] answer would strand the client entirely.
    const feed = makeFeed([6, 7, 8, 9].map((seq) => makeEvent(seq)))
    const snapshot = makeSnapshot({ seq: 5, revision: 5 })
    const plan = planSessionReplay({ snapshot, tail: [], resumeFromSeq: 7, durableLog: feed })
    expect(plan.snapshot).toEqual(snapshot)
    expect(plan.tail).toEqual([])
  })

  test("hostile feed: duplicate seqs and out-of-range junk are neutralized (unique, in-range, dense answer)", () => {
    const dupA = makeEvent(3, { eventId: "dup-a" })
    const dupB = makeEvent(3, { eventId: "dup-b" })
    const belowRange = makeEvent(2, { eventId: "below" }) // == cursor, not > cursor
    const aboveTip = makeEvent(9, { eventId: "above-tip" })
    const feed: SessionDurableEventLogReader = {
      readFrom: () => [belowRange, dupA, dupB, makeEvent(4), makeEvent(5), aboveTip],
    }
    const plan = planSessionReplay({
      snapshot: makeSnapshot({ seq: 5, revision: 5 }),
      tail: [],
      resumeFromSeq: 2,
      durableLog: feed,
    })
    expect(plan.snapshot).toBeUndefined()
    expect(seqsOf(plan.tail)).toEqual([3, 4, 5])
    expect(new Set(seqsOf(plan.tail)).size).toBe(plan.tail.length)
    expect(plan.tail.some((event) => event.eventId === "below")).toBe(false)
    expect(plan.tail.some((event) => event.eventId === "above-tip")).toBe(false)
  })

  test("no durable feed (control): every fallback path keeps the historical snapshot answer", () => {
    const snapshot = makeSnapshot({ seq: 5, revision: 5 })
    const tail = [makeEvent(7), makeEvent(8)]
    for (const resumeFromSeq of [2, 5, 99]) {
      const plan = planSessionReplay({ snapshot, tail, resumeFromSeq })
      expect(plan.snapshot).toEqual(snapshot)
      expect(seqsOf(plan.tail)).toEqual([7, 8])
    }
  })
})

// ---------------------------------------------------------------------------
// bridge wiring — rescue over a live transport
// ---------------------------------------------------------------------------

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

describe("session transport bridge — durable replay feed", () => {
  test("resume connect is answered from the durable feed: events-only over the wire, then live events in order", async () => {
    const feed = makeFeed([1, 2, 3].map((seq) => makeEvent(seq)))
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ seq: 3, revision: 3 }),
      durableLog: feed,
    })
    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((message) => {
      inbound.push(message)
    })
    await bridge.connect(pair.server)
    await pair.client.send({ kind: "connect", sessionId: "session-1", resumeFromSeq: 1 })

    expect(inbound.map((message) => message.kind)).toEqual(["event", "event"])
    expect(inbound.flatMap((m) => (m.kind === "event" ? [m.event.seq] : []))).toEqual([2, 3])

    const live = makeEvent(4)
    await bridge.publishEvents([live])
    expect(inbound.flatMap((m) => (m.kind === "event" ? [m.event.seq] : []))).toEqual([2, 3, 4])

    await bridge.close()
    await pair.client.close()
  })

  test("WIRE seam: replay stitched from log + LIVE memory tail arrives deduplicated — the overlap seqs ride the tail's own objects", async () => {
    // Raw-bridge shape (snapshot NOT advanced by the composer): snapshot at 3,
    // live tail [4, 5] published on top, durable log holding 1..5 (append-
    // before-publish ⇒ log ⊇ tail). A resume from 1 must stitch log[2, 3] +
    // overlap[4, 5] into ONE pass of each seq — a naive concatenation emits
    // 4 and 5 twice on the wire (the red-on-injection (ii) tripwire).
    const logFour = makeEvent(4, { eventId: "log-4" })
    const logFive = makeEvent(5, { eventId: "log-5" })
    const tailFour = makeEvent(4, { eventId: "tail-4" })
    const tailFive = makeEvent(5, { eventId: "tail-5" })
    const feed = makeFeed([makeEvent(2), makeEvent(3), logFour, logFive])
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ seq: 3, revision: 3 }),
      durableLog: feed,
    })
    await bridge.publishEvents([tailFour, tailFive])

    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((message) => {
      inbound.push(message)
    })
    await bridge.connect(pair.server)
    await pair.client.send({ kind: "connect", sessionId: "session-1", resumeFromSeq: 1 })

    expect(inbound.every((message) => message.kind === "event")).toBe(true)
    const seqs = inbound.flatMap((m) => (m.kind === "event" ? [m.event.seq] : []))
    expect(seqs).toEqual([2, 3, 4, 5])
    expect(new Set(seqs).size).toBe(seqs.length)
    // Collision winner is the bridge's own live object, on the wire.
    const ids = inbound.flatMap((m) => (m.kind === "event" ? [m.event.eventId] : []))
    expect(ids).toEqual(["event-2", "event-3", "tail-4", "tail-5"])

    await bridge.close()
    await pair.client.close()
  })

  test("multi-peer isolation: one peer's durable replay leaks nothing to a live sibling; the next live fan-out reaches both exactly once", async () => {
    const feed = makeFeed([1, 2, 3].map((seq) => makeEvent(seq)))
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ seq: 3, revision: 3 }),
      durableLog: feed,
    })

    const pairA = createTransportPair()
    const inboundA: SessionTransportMessage[] = []
    pairA.client.onMessage((message) => {
      inboundA.push(message)
    })
    await bridge.connect(pairA.server)
    await pairA.client.send({ kind: "connect", sessionId: "session-1" })
    inboundA.length = 0 // drop A's own connect answer; watch for leakage only

    const pairB = createTransportPair()
    const inboundB: SessionTransportMessage[] = []
    pairB.client.onMessage((message) => {
      inboundB.push(message)
    })
    await bridge.connect(pairB.server)
    await pairB.client.send({ kind: "connect", sessionId: "session-1", resumeFromSeq: 1 })

    // B replayed its window; A heard NOTHING of it.
    expect(inboundB.flatMap((m) => (m.kind === "event" ? [m.event.seq] : []))).toEqual([2, 3])
    expect(inboundA).toEqual([])

    // A live event reaches BOTH, exactly once each.
    await bridge.publishEvents([makeEvent(4)])
    expect(inboundA.flatMap((m) => (m.kind === "event" ? [m.event.seq] : []))).toEqual([4])
    expect(inboundB.flatMap((m) => (m.kind === "event" ? [m.event.seq] : []))).toEqual([2, 3, 4])

    await bridge.close()
    await pairA.client.close()
    await pairB.client.close()
  })

  test("throwing durable reader: reported to onBridgeError and degraded to the snapshot fallback (no crash, no silent replay)", async () => {
    const errors: unknown[] = []
    const snapshot = makeSnapshot({ seq: 3, revision: 3 })
    const bridge = createSessionTransportBridge({
      snapshot,
      durableLog: {
        readFrom: () => {
          throw new Error("disk exploded")
        },
      },
      onBridgeError: ({ error }) => {
        errors.push(error)
      },
    })
    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((message) => {
      inbound.push(message)
    })
    await bridge.connect(pair.server)
    await pair.client.send({ kind: "connect", sessionId: "session-1", resumeFromSeq: 1 })

    expect(inbound.map((message) => message.kind)).toEqual(["snapshot"])
    expect(errors.map((error) => (error instanceof Error ? error.message : "?"))).toEqual([
      "disk exploded",
    ])

    await bridge.close()
    await pair.client.close()
  })

  test("no-feed control: the same resume connect stays on the historical snapshot fallback", async () => {
    const snapshot = makeSnapshot({ seq: 3, revision: 3 })
    const bridge = createSessionTransportBridge({ snapshot })
    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((message) => {
      inbound.push(message)
    })
    await bridge.connect(pair.server)
    await pair.client.send({ kind: "connect", sessionId: "session-1", resumeFromSeq: 1 })

    expect(inbound.map((message) => message.kind)).toEqual(["snapshot"])
    expect(inbound[0]?.kind === "snapshot" ? inbound[0].snapshot : undefined).toEqual(snapshot)

    await bridge.close()
    await pair.client.close()
  })
})
