/**
 * Ticket 04 (S3) — the per-peer STRIP is the server-side SOLE defense. This
 * hellgate proves a non-granted (preview) peer NEVER receives the full fields on
 * ANY of the four peer-bound send paths, and that concurrently a GRANTED peer
 * does — with red-on-injection: bypass the strip and each pin reds.
 *
 * The four paths (RFC §3.2, all through the single `sendMessages` chokepoint):
 *   1. live fan-out              (publishEvents)
 *   2. tail replay               (connect resumeFromSeq served from memory tail)
 *   3. dup-command replay        (a duplicate command's resync replay)
 *   4. durable-log replay        (a resume the memory tail cannot serve, rescued
 *                                 from the on-disk JSONL log — the §3.2 SACRED pin)
 */
import { describe, expect, test } from "bun:test"
import {
  createSessionTransportBridge,
  type SessionDurableEventLogReader,
  type SessionTransport,
  type SessionTransportMessage,
} from "@/ipc/session"
import type { SessionCommand, SessionEvent, SessionSnapshotLite } from "@/protocol/session"
import { capabilitiesFor, makeSnapshotLite } from "../../support/session-fixtures"

const CAPABILITIES = capabilitiesFor({ tools: true, transport: "stdio" })
const makeSnapshot = (o: Partial<SessionSnapshotLite> = {}): SessionSnapshotLite =>
  makeSnapshotLite({ ...o, capabilities: { ...CAPABILITIES, ...(o.capabilities ?? {}) } })

const FULL = "the-entire-model-visible-output-verbatim"
const makeToolEvent = (seq: number, causedBy?: string): SessionEvent => ({
  eventId: `event-${seq}`,
  seq,
  revision: seq,
  emittedAt: "2026-07-16T00:00:00.000Z",
  type: "tool.completed",
  toolCallId: "c1",
  toolName: "bash",
  outcome: "ok",
  resultPreview: "clamped",
  resultFull: FULL,
  ...(causedBy !== undefined ? { causedByCommandId: causedBy } : {}),
})

const makeFeed = (events: readonly SessionEvent[]): SessionDurableEventLogReader => ({
  readFrom: (afterSeq) => events.filter((e) => e.seq > afterSeq),
})

const createTransportPair = (): { client: SessionTransport; server: SessionTransport } => {
  const ch = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  const sh = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  let cc = false
  let sc = false
  const build = (
    remote: Set<(m: SessionTransportMessage) => void | Promise<void>>,
    local: Set<(m: SessionTransportMessage) => void | Promise<void>>,
    isClosed: () => boolean,
    close: () => void,
  ): SessionTransport => ({
    async send(m) {
      if (isClosed()) return
      for (const h of [...remote]) await h(m)
    },
    onMessage(h) {
      local.add(h)
      return () => local.delete(h)
    },
    async close() {
      close()
      local.clear()
    },
  })
  return {
    client: build(
      sh,
      ch,
      () => cc,
      () => {
        cc = true
      },
    ),
    server: build(
      ch,
      sh,
      () => sc,
      () => {
        sc = true
      },
    ),
  }
}

const fullFieldsSeen = (inbound: readonly SessionTransportMessage[]): string[] =>
  inbound.flatMap((m) =>
    m.kind === "event" && m.event.type === "tool.completed" && "resultFull" in m.event
      ? [(m.event as { resultFull?: string }).resultFull ?? ""]
      : [],
  )

describe("S3 — preview peer never receives full fields (strip leak pins)", () => {
  test("path 1 (live fan-out): preview peer sees NO resultFull; a granted sibling DOES (concurrent isolation)", async () => {
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ seq: 0 }),
      fullFidelity: true,
    })
    const preview = createTransportPair()
    const full = createTransportPair()
    const previewIn: SessionTransportMessage[] = []
    const fullIn: SessionTransportMessage[] = []
    preview.client.onMessage((m) => {
      previewIn.push(m)
    })
    full.client.onMessage((m) => {
      fullIn.push(m)
    })
    await bridge.connect(preview.server)
    await bridge.connect(full.server)
    await preview.client.send({ kind: "connect", sessionId: "session-1", resumeFromSeq: 0 }) // no request
    await full.client.send({
      kind: "connect",
      sessionId: "session-1",
      requestedFidelity: "full",
      resumeFromSeq: 0,
    })

    await bridge.publishEvents([makeToolEvent(1)])
    // Same session, same event — preview peer STRIPPED, granted peer INTACT.
    expect(fullFieldsSeen(previewIn)).toEqual([])
    expect(fullFieldsSeen(fullIn)).toEqual([FULL])
    await bridge.close()
  })

  test("path 1b (audit MED — re-connect downgrade FAIL-CLOSED): a granted peer that re-connects WITHOUT the request is stripped again (stale grant cleared)", async () => {
    // The server-side strip is the SOLE defense, so a re-negotiation that drops
    // the fidelity request MUST clear the prior grant — otherwise full keeps
    // leaking to a peer that no longer asked. red-on-injection: revert the
    // bridge's unconditional grant recompute and this leaks (full survives).
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ seq: 0 }),
      fullFidelity: true,
    })
    const peer = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    peer.client.onMessage((m) => {
      inbound.push(m)
    })
    await bridge.connect(peer.server)
    // First connect REQUESTS full ⇒ granted.
    await peer.client.send({
      kind: "connect",
      sessionId: "session-1",
      requestedFidelity: "full",
      resumeFromSeq: 0,
    })
    await bridge.publishEvents([makeToolEvent(1)])
    expect(fullFieldsSeen(inbound)).toEqual([FULL]) // granted: full carried
    inbound.length = 0
    // Re-connect on the SAME transport WITHOUT the request ⇒ must downgrade.
    await peer.client.send({ kind: "connect", sessionId: "session-1", resumeFromSeq: 1 })
    await bridge.publishEvents([makeToolEvent(2)])
    expect(fullFieldsSeen(inbound)).toEqual([]) // stale grant cleared ⇒ stripped
    await bridge.close()
  })

  test("path 2 (tail replay): a preview peer resuming from memory tail is stripped", async () => {
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ seq: 0 }),
      fullFidelity: true,
    })
    await bridge.publishEvents([makeToolEvent(1), makeToolEvent(2)]) // now in the tail
    const preview = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    preview.client.onMessage((m) => {
      inbound.push(m)
    })
    await bridge.connect(preview.server)
    await preview.client.send({ kind: "connect", sessionId: "session-1", resumeFromSeq: 0 })
    expect(fullFieldsSeen(inbound)).toEqual([])
    await bridge.close()
  })

  test("path 3 (dup-command replay): the resync replay to a preview peer is stripped", async () => {
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ seq: 0 }),
      fullFidelity: true,
      onCommand: async () => undefined,
    })
    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((m) => {
      inbound.push(m)
    })
    await bridge.connect(pair.server)
    await pair.client.send({ kind: "connect", sessionId: "session-1", resumeFromSeq: 0 })
    const command: SessionCommand = {
      type: "input.append",
      sessionId: "session-1",
      commandId: "cmd-1",
      issuedAt: "2026-07-16T00:00:00.000Z",
      text: "x",
    }
    // First accept the command, then publish a full-field event caused by it so it
    // is in the dup replay index.
    await pair.client.send({ kind: "command", command })
    await bridge.publishEvents([makeToolEvent(1, "cmd-1")])
    inbound.length = 0
    // Re-send the SAME command ⇒ duplicate ⇒ resync replay of the caused events.
    await pair.client.send({ kind: "command", command })
    // The replayed caused-event must be STRIPPED for this preview peer.
    expect(fullFieldsSeen(inbound)).toEqual([])
    await bridge.close()
  })

  test("path 4 (durable-log replay — SACRED §3.2 pin): a preview peer rescued from the JSONL log is stripped", async () => {
    // Snapshot at 3, live tail [4,5], durable log holds 1..5 WITH full fields. A
    // resume from 1 falls off the memory tail ⇒ the bridge rescues from the log.
    // Those log events carry `resultFull` — the strip MUST still apply on the
    // durable path (if it were only on live fan-out, this pin reds).
    const feed = makeFeed([1, 2, 3, 4, 5].map((s) => makeToolEvent(s)))
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ seq: 3, revision: 3 }),
      durableLog: feed,
      fullFidelity: true,
    })
    await bridge.publishEvents([makeToolEvent(4), makeToolEvent(5)])
    const preview = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    preview.client.onMessage((m) => {
      inbound.push(m)
    })
    await bridge.connect(preview.server)
    await preview.client.send({ kind: "connect", sessionId: "session-1", resumeFromSeq: 1 })
    // Sanity: the resume WAS served as events (durable rescue), not a snapshot reset.
    const events = inbound.filter((m) => m.kind === "event")
    expect(events.length).toBeGreaterThan(0)
    // And NONE of them leaked a full field to this preview peer.
    expect(fullFieldsSeen(inbound)).toEqual([])
    await bridge.close()
  })

  test("path 4 GRANTED control: a granted peer's durable rescue DOES carry the full field (proves the pin is non-vacuous)", async () => {
    const feed = makeFeed([1, 2, 3, 4, 5].map((s) => makeToolEvent(s)))
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot({ seq: 3, revision: 3 }),
      durableLog: feed,
      fullFidelity: true,
    })
    await bridge.publishEvents([makeToolEvent(4), makeToolEvent(5)])
    const full = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    full.client.onMessage((m) => {
      inbound.push(m)
    })
    await bridge.connect(full.server)
    await full.client.send({
      kind: "connect",
      sessionId: "session-1",
      requestedFidelity: "full",
      resumeFromSeq: 1,
    })
    // The granted peer's durable-rescued events carry the full field verbatim.
    expect(fullFieldsSeen(inbound).length).toBeGreaterThan(0)
    expect(fullFieldsSeen(inbound).every((v) => v === FULL)).toBe(true)
    await bridge.close()
  })
})
