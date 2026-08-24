/**
 * J-MED-1 (jul-16 종합/J audit) — connect handshake-window ↔ live-event
 * INTERLEAVE / out-of-order delivery.
 *
 * DEFECT (repro confirmed): the `connect` handler flips `peer.connected = true`
 * SYNCHRONOUSLY, then `handleConnect` serves the replay answer (snapshot / tail
 * / durable rescue + the ticket-05 `resumed` marker) through a chain of
 * `await peer.send(...)`. On an ASYNC transport (real ws/stdio — `send` is a
 * genuine promise) a concurrent `publishEvents` fan-out sees this peer already
 * `connected` and slots its live frames BETWEEN the replay frames → the peer
 * observes a seq order that violates the global sequence (e.g. 12, 14, 13,
 * resumed) — the audited out-of-order bug.
 *
 * THE TRAP (why the naive fix is wrong): merely deferring the `connected` flip
 * to AFTER `handleConnect` stops the interleave but DROPS the live events that
 * arrived DURING the replay (they are gated out, and the replay window was
 * snapshotted at connect-start) — silent event LOSS. So these tests assert BOTH
 * invariants: (a) monotone non-decreasing seq order across every frame the peer
 * receives, AND (b) NO LOSS — the multiset of delivered event seqs equals the
 * union of {replay window} ∪ {live events published during the handshake},
 * each exactly once.
 *
 * red-on-injection: the per-peer send queue that enforces this is load-bearing.
 * The `unqueued-control` sibling drives the SAME race through a hand-rolled
 * topology that bypasses any serialization, proving the harness truly creates
 * the race (it MUST go out-of-order without a shared ordering channel).
 */

import { describe, expect, test } from "bun:test"
import {
  createSessionTransportBridge,
  type SessionDurableEventLogReader,
  type SessionTransport,
  type SessionTransportMessage,
} from "@/ipc/session"
import type { SessionEvent, SessionSnapshotLite } from "@/protocol/session"
import { nth } from "../../_helpers/expect-present"
import { capabilitiesFor } from "../../support/session-fixtures"

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* ------------------------------------------------------------------------- */

const makeSnapshot = (seq: number): SessionSnapshotLite => ({
  sessionId: "session-1",
  revision: seq,
  seq,
  state: { status: "idle", draftInput: "", permissionMode: "default", messageCount: 0 },
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
  state: { status: "idle", draftInput: "", permissionMode: "default", messageCount: 0 },
})

/** A macrotask hop — a genuine async boundary that lets any already-scheduled
 *  work (a concurrent `publishEvents` fan-out) run to completion in between. */
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const drain = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) await macrotask()
}

/**
 * Server-side peer harness against the REAL bridge whose `send` is genuinely
 * ASYNC: each send awaits a macrotask hop before recording the frame, so a
 * `publishEvents` that races the replay has a real window to interleave. This
 * is the crux the pre-05/05 tests missed — their `send` pushed synchronously,
 * so no interleave could ever manifest.
 */
const connectAsyncPeer = async (bridge: ReturnType<typeof createSessionTransportBridge>) => {
  const sent: SessionTransportMessage[] = []
  const handlers = new Set<(message: SessionTransportMessage) => void | Promise<void>>()
  const transport: SessionTransport = {
    async send(message) {
      await macrotask()
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
    /** Fire a client→bridge frame WITHOUT awaiting the bridge's handling — the
     *  caller can then race `publishEvents` against the in-flight replay. */
    fire(message: SessionTransportMessage): void {
      for (const handler of [...handlers]) void handler(message)
    },
  }
}

/** seqs of the `event` frames, in delivery order. */
const eventSeqs = (messages: readonly SessionTransportMessage[]): number[] =>
  messages.flatMap((message) => (message.kind === "event" ? [message.event.seq] : []))

const kindsOf = (messages: readonly SessionTransportMessage[]): string[] =>
  messages.map((m) => m.kind)

/** Ordinal position of the `resumed` frame (or -1). */
const resumedAt = (messages: readonly SessionTransportMessage[]): number =>
  messages.findIndex((message) => message.kind === "resumed")

const eventAt = (messages: readonly SessionTransportMessage[], seq: number): number =>
  messages.findIndex((m) => m.kind === "event" && m.event.seq === seq)

/** The seq every frame carries for ordering: events by their seq, resumed by
 *  its servedThroughSeq, snapshots by their snapshot.seq. */
const orderingSeqs = (messages: readonly SessionTransportMessage[]): number[] =>
  messages.map((message) =>
    message.kind === "event"
      ? message.event.seq
      : message.kind === "resumed"
        ? message.servedThroughSeq
        : message.kind === "snapshot"
          ? message.snapshot.seq
          : Number.NaN,
  )

const isNonDecreasing = (xs: readonly number[]): boolean =>
  xs.every((x, i) => {
    if (i === 0 || Number.isNaN(x)) return true
    const prev = nth(xs, i - 1, "xs")
    return Number.isNaN(prev) || prev <= x
  })

/* ------------------------------------------------------------------------- */
/* RED → GREEN — in-window incremental replay racing a mid-handshake publish */
/* ------------------------------------------------------------------------- */

describe("connect handshake-window ↔ live-event interleave (async transport)", () => {
  test("in-window replay races a mid-handshake publish: order preserved AND no loss", async () => {
    const bridge = createSessionTransportBridge({ snapshot: makeSnapshot(10) })
    await bridge.publishEvents([makeEvent(11), makeEvent(12), makeEvent(13), makeEvent(14)])
    const peer = await connectAsyncPeer(bridge)

    // Resume from 11 ⇒ replay window is events {12, 13, 14} then a `resumed`
    // marker (servedThroughSeq 14). Fire the connect WITHOUT awaiting, then
    // publish a LIVE event 15 while the replay is mid-flight.
    peer.fire({ kind: "connect", sessionId: "session-1", resumeFromSeq: 11, resumeAck: true })
    await macrotask() // let the replay begin (first send in its macrotask hop)
    await bridge.publishEvents([makeEvent(15)]) // races the remaining replay frames
    await drain()

    // (a) global-seq order preserved across EVERY frame (events + resumed).
    expect(isNonDecreasing(orderingSeqs(peer.sent))).toBe(true)
    const seqs = eventSeqs(peer.sent)
    expect(seqs).toEqual([12, 13, 14, 15])
    // resumed lands strictly after its window (…,14) and before live 15.
    expect(resumedAt(peer.sent)).toBeGreaterThan(eventAt(peer.sent, 14))
    expect(resumedAt(peer.sent)).toBeLessThan(eventAt(peer.sent, 15))
    // (b) NO LOSS — union {12,13,14} ∪ {15}, each exactly once.
    expect([...seqs].sort((a, b) => a - b)).toEqual([12, 13, 14, 15])

    await bridge.close()
  })

  test("MANY live events race the replay: all delivered exactly once, monotone", async () => {
    const bridge = createSessionTransportBridge({ snapshot: makeSnapshot(10) })
    await bridge.publishEvents([makeEvent(11), makeEvent(12), makeEvent(13)])
    const peer = await connectAsyncPeer(bridge)

    peer.fire({ kind: "connect", sessionId: "session-1", resumeFromSeq: 11, resumeAck: true })
    await macrotask()
    await bridge.publishEvents([makeEvent(14)])
    await bridge.publishEvents([makeEvent(15)])
    await bridge.publishEvents([makeEvent(16)])
    await drain(16)

    expect(isNonDecreasing(orderingSeqs(peer.sent))).toBe(true)
    const seqs = eventSeqs(peer.sent)
    expect(seqs).toEqual([12, 13, 14, 15, 16]) // replay {12,13} first, then live
    expect([...seqs].sort((a, b) => a - b)).toEqual([12, 13, 14, 15, 16]) // no loss
    expect(resumedAt(peer.sent)).toBeGreaterThan(eventAt(peer.sent, 13))
    expect(resumedAt(peer.sent)).toBeLessThan(eventAt(peer.sent, 14))

    await bridge.close()
  })

  test("ZERO live events during replay: baseline order is unchanged (control)", async () => {
    const bridge = createSessionTransportBridge({ snapshot: makeSnapshot(10) })
    await bridge.publishEvents([makeEvent(11), makeEvent(12), makeEvent(13)])
    const peer = await connectAsyncPeer(bridge)
    peer.fire({ kind: "connect", sessionId: "session-1", resumeFromSeq: 11, resumeAck: true })
    await drain()
    expect(kindsOf(peer.sent)).toEqual(["event", "event", "resumed"])
    expect(eventSeqs(peer.sent)).toEqual([12, 13])
    await bridge.close()
  })

  /* ----------------------------------------------------------------------- */
  /* snapshot-fallback replay (behind-window) races a live publish           */
  /* ----------------------------------------------------------------------- */

  test("snapshot-fallback replay races a live publish: snapshot+tail THEN resumed THEN live, no loss", async () => {
    const bridge = createSessionTransportBridge({ snapshot: makeSnapshot(10), tailLimit: 2 })
    await bridge.publishEvents([makeEvent(11), makeEvent(12), makeEvent(13), makeEvent(14)])
    const peer = await connectAsyncPeer(bridge)
    // cursor 10 behind window (tail retains 13,14) ⇒ snapshot reset + tail 13,14.
    peer.fire({ kind: "connect", sessionId: "session-1", resumeFromSeq: 10, resumeAck: true })
    await macrotask()
    await bridge.publishEvents([makeEvent(15)])
    await drain()

    expect(kindsOf(peer.sent)).toEqual(["snapshot", "event", "event", "resumed", "event"])
    expect(eventSeqs(peer.sent)).toEqual([13, 14, 15])
    expect(isNonDecreasing(orderingSeqs(peer.sent))).toBe(true)
    await bridge.close()
  })

  /* ----------------------------------------------------------------------- */
  /* durable-log rescue replay races a live publish                          */
  /* ----------------------------------------------------------------------- */

  test("durable-log rescue replay races a live publish: full incremental THEN resumed THEN live", async () => {
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
    const peer = await connectAsyncPeer(bridge)
    peer.fire({ kind: "connect", sessionId: "session-1", resumeFromSeq: 10, resumeAck: true })
    await macrotask()
    await bridge.publishEvents([makeEvent(15)])
    await drain()

    expect(eventSeqs(peer.sent)).toEqual([11, 12, 13, 14, 15])
    expect(kindsOf(peer.sent)).toEqual(["event", "event", "event", "event", "resumed", "event"])
    expect(isNonDecreasing(orderingSeqs(peer.sent))).toBe(true)
    await bridge.close()
  })

  /* ----------------------------------------------------------------------- */
  /* plain full connect (no resume cursor) races a live publish              */
  /* ----------------------------------------------------------------------- */

  test("plain full connect races a live publish: snapshot+tail THEN resumed THEN live", async () => {
    const bridge = createSessionTransportBridge({ snapshot: makeSnapshot(10) })
    await bridge.publishEvents([makeEvent(11)])
    const peer = await connectAsyncPeer(bridge)
    peer.fire({ kind: "connect", sessionId: "session-1", resumeAck: true })
    await macrotask()
    await bridge.publishEvents([makeEvent(12)])
    await drain()

    expect(kindsOf(peer.sent)).toEqual(["snapshot", "event", "resumed", "event"])
    expect(eventSeqs(peer.sent)).toEqual([11, 12])
    expect(isNonDecreasing(orderingSeqs(peer.sent))).toBe(true)
    await bridge.close()
  })

  /* ----------------------------------------------------------------------- */
  /* multi-peer: one peer mid-replay must not disturb another's live stream  */
  /* ----------------------------------------------------------------------- */

  test("multi-peer: a live publish reaches an already-connected peer normally WHILE another peer is mid-replay", async () => {
    const bridge = createSessionTransportBridge({ snapshot: makeSnapshot(10) })
    await bridge.publishEvents([makeEvent(11), makeEvent(12), makeEvent(13)])

    // Peer A: connect + drain fully first (fully caught up, connected).
    const a = await connectAsyncPeer(bridge)
    a.fire({ kind: "connect", sessionId: "session-1", resumeFromSeq: 13, resumeAck: true })
    await drain()
    const aBefore = a.sent.length

    // Peer B: begin a resume replay from 11 ⇒ window {12,13} + resumed.
    const b = await connectAsyncPeer(bridge)
    b.fire({ kind: "connect", sessionId: "session-1", resumeFromSeq: 11, resumeAck: true })
    await macrotask()
    await bridge.publishEvents([makeEvent(14)]) // live WHILE B is mid-replay
    await drain()

    // Peer A (already connected) gets live 14 in order, exactly once.
    expect(eventSeqs(a.sent.slice(aBefore))).toEqual([14])
    expect(isNonDecreasing(orderingSeqs(a.sent))).toBe(true)

    // Peer B: replay window {12,13} THEN resumed THEN live 14 — order + no loss.
    expect(eventSeqs(b.sent)).toEqual([12, 13, 14])
    expect(isNonDecreasing(orderingSeqs(b.sent))).toBe(true)
    expect(resumedAt(b.sent)).toBeGreaterThan(eventAt(b.sent, 13))
    expect(resumedAt(b.sent)).toBeLessThan(eventAt(b.sent, 14))

    await bridge.close()
  })

  /* ----------------------------------------------------------------------- */
  /* red-on-injection control: the SAME race WITHOUT a shared ordering        */
  /* channel MUST manifest out-of-order (proves the harness is genuine).      */
  /* ----------------------------------------------------------------------- */

  test("unqueued-control: racing send streams with NO shared channel DO interleave (harness sanity)", async () => {
    // Two independent async send streams (a replay vs. a live push) that share
    // NO ordering channel — the buggy bridge topology. It must produce an
    // out-of-order delivery, otherwise the GREEN tests above prove nothing.
    const sent: SessionTransportMessage[] = []
    const sendAsync = async (m: SessionTransportMessage): Promise<void> => {
      await macrotask()
      sent.push(m)
    }
    const replayStream = (async () => {
      await sendAsync({ kind: "event", event: makeEvent(12) })
      await sendAsync({ kind: "event", event: makeEvent(13) })
      await sendAsync({ kind: "event", event: makeEvent(14) })
    })()
    const liveStream = (async () => {
      await sendAsync({ kind: "event", event: makeEvent(15) })
    })()
    await Promise.all([replayStream, liveStream])

    // Without a shared ordering channel, 15 slots in BEFORE 13/14 → not sorted.
    const seqs = eventSeqs(sent)
    expect(seqs).not.toEqual([...seqs].sort((a, b) => a - b))
  })
})
