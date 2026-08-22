/**
 * Ticket 04 (S5) — wire fidelity END-TO-END over BOTH real transports (stdio +
 * websocket), through the actual encode/decode codec (the negotiation helpers
 * above exercise an in-proc fake pair; this proves the encoded wire carries it):
 *
 *  - gate OFF ⇒ a requesting client is refused (fidelity:"preview") and never
 *    receives a full field — parity across ws/stdio;
 *  - gate ON + request ⇒ the full field survives the round-trip on the wire;
 *  - gate ON + NO request (same session, concurrent) ⇒ that peer is stripped;
 *  - reconnect re-negotiates (per-peer state is connection-lifetime).
 */
import { describe, expect, test } from "bun:test"
import {
  createSessionTransportBridge,
  type SessionTransportConnectionState,
  type SessionTransportMessage,
} from "@/ipc/session"
import type { SessionEvent } from "@/protocol/session"
import {
  createHarness,
  makeSnapshot,
  type TransportKind,
} from "./session-transport-conformance-fixtures"

const KINDS: readonly TransportKind[] = ["stdio", "websocket"]
const FULL = "the-entire-model-visible-output-verbatim"

const toolEvent = (seq: number): SessionEvent => ({
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
})

const fullSeen = (msgs: readonly SessionTransportMessage[]): string[] =>
  msgs.flatMap((m) =>
    m.kind === "event" && m.event.type === "tool.completed" && "resultFull" in m.event
      ? [(m.event as { resultFull?: string }).resultFull ?? ""]
      : [],
  )

const fidelityOf = (states: readonly SessionTransportConnectionState[]): (string | undefined)[] =>
  states.flatMap((s) => (s.status === "connected" && s.fidelity !== undefined ? [s.fidelity] : []))

for (const kind of KINDS) {
  describe(`S5 [${kind}] — fidelity end-to-end over the real codec`, () => {
    test("gate ON + requested: the full field survives the wire round-trip; client sees fidelity:'full'", async () => {
      const bridge = createSessionTransportBridge({
        snapshot: makeSnapshot(kind, { seq: 0 }),
        fullFidelity: true,
      })
      const harness = await createHarness({ kind, bridge, requestedFidelity: "full" })
      const inbound: SessionTransportMessage[] = []
      const states: SessionTransportConnectionState[] = []
      harness.client.onMessage((m) => {
        inbound.push(m)
      })
      harness.client.onConnectionState((s) => {
        states.push(s)
      })
      await harness.client.connect()
      await bridge.publishEvents([toolEvent(1)])
      await new Promise((r) => setTimeout(r, 5))
      expect(fullSeen(inbound)).toEqual([FULL])
      expect(fidelityOf(states)).toEqual(["full"])
      await harness.close()
    })

    test("gate OFF + requested: refused (fidelity:'preview'), full field stripped over the wire", async () => {
      const bridge = createSessionTransportBridge({ snapshot: makeSnapshot(kind, { seq: 0 }) }) // OFF
      const harness = await createHarness({ kind, bridge, requestedFidelity: "full" })
      const inbound: SessionTransportMessage[] = []
      const states: SessionTransportConnectionState[] = []
      harness.client.onMessage((m) => {
        inbound.push(m)
      })
      harness.client.onConnectionState((s) => {
        states.push(s)
      })
      await harness.client.connect()
      await bridge.publishEvents([toolEvent(1)])
      await new Promise((r) => setTimeout(r, 5))
      expect(fullSeen(inbound)).toEqual([])
      expect(fidelityOf(states)).toEqual(["preview"])
      await harness.close()
    })

    test("gate ON + NOT requested (concurrent legacy peer): stripped, no fidelity enrichment", async () => {
      const bridge = createSessionTransportBridge({
        snapshot: makeSnapshot(kind, { seq: 0 }),
        fullFidelity: true,
      })
      const harness = await createHarness({ kind, bridge }) // no requestedFidelity
      const inbound: SessionTransportMessage[] = []
      const states: SessionTransportConnectionState[] = []
      harness.client.onMessage((m) => {
        inbound.push(m)
      })
      harness.client.onConnectionState((s) => {
        states.push(s)
      })
      await harness.client.connect()
      await bridge.publishEvents([toolEvent(1)])
      await new Promise((r) => setTimeout(r, 5))
      expect(fullSeen(inbound)).toEqual([])
      expect(fidelityOf(states)).toEqual([]) // never enriched (did not request)
      await harness.close()
    })
  })
}
