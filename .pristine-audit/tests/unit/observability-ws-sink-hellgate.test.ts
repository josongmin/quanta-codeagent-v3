/**
 * ADR-0420 — served-WebSocket observability sink — hellgate.
 *
 * ADR-0415 wired the live observability ports onto the daemon facade and fed
 * them to `createObservabilityEmitter`, but the emitter ran PORT-ONLY: no
 * daemon-level WebSocket sink, so `observability.snapshot`/`observability.delta`
 * frames never reached a connected UI. ADR-0420 closes that deferral: the
 * served `ServerWebSocket` is bridged into a per-connection `ObservabilitySink`
 * (`{ send: (frame) => ws.send(frame) }`) so snapshot-on-connect + subsequent
 * deltas flow to each client.
 *
 * This battery pins the bridge WITHOUT booting a real Bun.serve. It exercises
 * `attachObservabilitySink(...)` — the per-connection wiring server.ts uses —
 * against a FAKE ServerWebSocket recording every `.send()` and a fake
 * `RunLedgerPort` whose state the test mutates between emitter ticks.
 *
 *   - gate OFF (no ports) ⇒ no sink attached, ws.send never carries an
 *     observability frame (byte-identical).
 *   - gate ON + connect ⇒ exactly one `observability.snapshot` frame first.
 *   - subsequent port changes ⇒ `observability.delta` frames (emitter tick).
 *   - disconnect ⇒ sink detached, send-count frozen after disconnect.
 *   - two connections ⇒ each gets its OWN snapshot (independent sinks).
 *   - malformed/throwing ws.send ⇒ swallowed (NO-THROW, emitter survives).
 *   - every frame decode-round-trips to a valid `ObservabilityMessage`.
 */

import { describe, expect, test } from "bun:test"
import { attachObservabilitySink } from "@/../src/apps/web-daemon/server"
import type { RunEntry, RunLedgerPort, RunStatus } from "@/agent/run-ledger"
import {
  decodeObservabilityFrame,
  isObservabilityMessage,
  type ObservabilityMessage,
} from "@/protocol/observability"

// -----------------------------------------------------------------------------
// fakes
// -----------------------------------------------------------------------------

/** A FAKE ServerWebSocket recording every `.send()` payload. Only the surface
 *  the sink touches (`send`) is implemented. `throwOnSend` flips it into the
 *  NO-THROW adversary. */
class FakeServerWebSocket {
  readonly sent: string[] = []
  throwOnSend = false
  send(data: string | Uint8Array): number {
    if (this.throwOnSend) throw new Error("socket is dead")
    this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data))
    return 0
  }
  /** Only observability frames (the discriminant lives in the wire envelope). */
  observabilityFrames(): string[] {
    return this.sent.filter((raw) => raw.includes('"observability"'))
  }
}

/** A mutable fake `RunLedgerPort` — the emitter reads `list()` each tick. The
 *  test pushes/replaces entries to drive snapshot → delta transitions. Only
 *  the methods the emitter calls are real; the rest are inert no-throws. */
const fakeRunLedger = (): { port: RunLedgerPort; setEntries(e: RunEntry[]): void } => {
  let entries: RunEntry[] = []
  const port: RunLedgerPort = {
    start: () => entry("x", "running"),
    touch: () => null,
    settle: () => null,
    get: () => null,
    list: () => entries,
    running: () => entries.filter((e) => e.status === "running"),
    waiting: () => entries.filter((e) => e.status === "waiting"),
    toSnapshot: () => ({ entries }),
    fromSnapshot: () => undefined,
  }
  return { port, setEntries: (e) => (entries = e) }
}

const entry = (id: string, status: RunStatus): RunEntry => ({
  id,
  kind: "shell",
  owner: "default",
  title: `run ${id}`,
  status,
  startedAt: 1,
  lastEventAt: 1,
  artifacts: [],
})

/** Deterministic manual timer seam — the emitter's `tick()` is also callable
 *  directly, so we never need a real interval here. */
const noopTimer = { setInterval: () => 0, clearInterval: () => undefined }

// -----------------------------------------------------------------------------
// tests
// -----------------------------------------------------------------------------

describe("ADR-0420 observability-ws-sink — gate OFF (byte-identical)", () => {
  test("no ports ⇒ no sink attached, ws.send carries zero observability frames", () => {
    const ws = new FakeServerWebSocket()
    const handle = attachObservabilitySink(ws, undefined)
    expect(handle).toBeNull()
    // Even after a manual tick attempt the socket sees nothing.
    handle?.tick()
    expect(ws.sent).toHaveLength(0)
    expect(ws.observabilityFrames()).toHaveLength(0)
  })

  test("explicit empty-ports bundle ⇒ no sink (emitter has no port ⇒ silent)", () => {
    const ws = new FakeServerWebSocket()
    const handle = attachObservabilitySink(ws, {})
    // No port ⇒ emitter never writes. The helper MAY return a handle but it
    // must produce zero frames.
    handle?.tick()
    expect(ws.observabilityFrames()).toHaveLength(0)
  })
})

describe("ADR-0420 observability-ws-sink — gate ON", () => {
  test("connect ⇒ exactly one observability.snapshot frame sent first", () => {
    const ws = new FakeServerWebSocket()
    const { port } = fakeRunLedger()
    const handle = attachObservabilitySink(ws, { runLedger: port, timer: noopTimer })
    expect(handle).not.toBeNull()
    handle?.tick()
    const frames = ws.observabilityFrames()
    expect(frames).toHaveLength(1)
    const msg = decodeObservabilityFrame(frames[0])
    expect(msg?.kind).toBe("observability.snapshot")
  })

  test("subsequent port changes ⇒ observability.delta frames", () => {
    const ws = new FakeServerWebSocket()
    const { port, setEntries } = fakeRunLedger()
    const handle = attachObservabilitySink(ws, { runLedger: port, timer: noopTimer })
    handle?.tick() // snapshot
    setEntries([entry("a", "running")])
    handle?.tick() // delta
    const frames = ws.observabilityFrames()
    expect(frames).toHaveLength(2)
    expect(decodeObservabilityFrame(frames[0])?.kind).toBe("observability.snapshot")
    const delta = decodeObservabilityFrame(frames[1])
    expect(delta?.kind).toBe("observability.delta")
    if (delta?.kind === "observability.delta") {
      expect(delta.runChanges?.[0]?.id).toBe("a")
    }
  })

  test("no change between ticks ⇒ no extra frame emitted", () => {
    const ws = new FakeServerWebSocket()
    const { port } = fakeRunLedger()
    const handle = attachObservabilitySink(ws, { runLedger: port, timer: noopTimer })
    handle?.tick() // snapshot
    handle?.tick() // no change ⇒ no delta
    handle?.tick()
    expect(ws.observabilityFrames()).toHaveLength(1)
  })

  test("requestSnapshot forces a fresh snapshot (reconnect/re-attach)", () => {
    const ws = new FakeServerWebSocket()
    const { port, setEntries } = fakeRunLedger()
    const handle = attachObservabilitySink(ws, { runLedger: port, timer: noopTimer })
    handle?.tick() // snapshot #1
    setEntries([entry("a", "running")])
    handle?.tick() // delta
    handle?.requestSnapshot()
    handle?.tick() // snapshot #2
    const frames = ws.observabilityFrames()
    expect(decodeObservabilityFrame(frames[0])?.kind).toBe("observability.snapshot")
    expect(decodeObservabilityFrame(frames[1])?.kind).toBe("observability.delta")
    expect(decodeObservabilityFrame(frames[2])?.kind).toBe("observability.snapshot")
  })
})

describe("ADR-0420 observability-ws-sink — disconnect", () => {
  test("stop() detaches the sink, send-count frozen after disconnect", () => {
    const ws = new FakeServerWebSocket()
    const { port, setEntries } = fakeRunLedger()
    const handle = attachObservabilitySink(ws, { runLedger: port, timer: noopTimer })
    handle?.tick() // snapshot
    const beforeStop = ws.observabilityFrames().length
    expect(beforeStop).toBe(1)
    handle?.stop() // disconnect
    setEntries([entry("a", "running")])
    handle?.tick() // must be a no-op after stop
    expect(ws.observabilityFrames()).toHaveLength(beforeStop)
  })

  test("stop() is idempotent", () => {
    const ws = new FakeServerWebSocket()
    const { port } = fakeRunLedger()
    const handle = attachObservabilitySink(ws, { runLedger: port, timer: noopTimer })
    handle?.tick()
    expect(() => {
      handle?.stop()
      handle?.stop()
    }).not.toThrow()
  })
})

describe("ADR-0420 observability-ws-sink — multi-connection isolation", () => {
  test("two connections ⇒ each gets its own independent snapshot", () => {
    const wsA = new FakeServerWebSocket()
    const wsB = new FakeServerWebSocket()
    const { port } = fakeRunLedger()
    const a = attachObservabilitySink(wsA, { runLedger: port, timer: noopTimer })
    const b = attachObservabilitySink(wsB, { runLedger: port, timer: noopTimer })
    a?.tick()
    b?.tick()
    expect(wsA.observabilityFrames()).toHaveLength(1)
    expect(wsB.observabilityFrames()).toHaveLength(1)
    expect(decodeObservabilityFrame(wsA.observabilityFrames()[0])?.kind).toBe(
      "observability.snapshot",
    )
    expect(decodeObservabilityFrame(wsB.observabilityFrames()[0])?.kind).toBe(
      "observability.snapshot",
    )
  })

  test("disconnecting one connection does not freeze the sibling", () => {
    const wsA = new FakeServerWebSocket()
    const wsB = new FakeServerWebSocket()
    const { port, setEntries } = fakeRunLedger()
    const a = attachObservabilitySink(wsA, { runLedger: port, timer: noopTimer })
    const b = attachObservabilitySink(wsB, { runLedger: port, timer: noopTimer })
    a?.tick()
    b?.tick()
    a?.stop() // A disconnects
    setEntries([entry("a", "running")])
    b?.tick() // B still live ⇒ gets the delta
    expect(wsA.observabilityFrames()).toHaveLength(1) // frozen
    expect(wsB.observabilityFrames()).toHaveLength(2) // snapshot + delta
  })
})

describe("ADR-0420 observability-ws-sink — NO-THROW", () => {
  test("throwing ws.send is swallowed; the emitter loop survives", () => {
    const ws = new FakeServerWebSocket()
    ws.throwOnSend = true
    const { port, setEntries } = fakeRunLedger()
    const handle = attachObservabilitySink(ws, { runLedger: port, timer: noopTimer })
    expect(() => handle?.tick()).not.toThrow() // snapshot throws inside send
    ws.throwOnSend = false
    setEntries([entry("a", "running")])
    // The emitter must still be alive — a later tick emits to the now-healthy
    // socket without crashing.
    expect(() => handle?.tick()).not.toThrow()
    // At least one frame got through once send stopped throwing.
    expect(ws.observabilityFrames().length).toBeGreaterThanOrEqual(1)
  })

  test("attachObservabilitySink itself never throws on a hostile socket", () => {
    const hostile = {
      send() {
        throw new Error("nope")
      },
    }
    const { port } = fakeRunLedger()
    expect(() =>
      attachObservabilitySink(hostile, { runLedger: port, timer: noopTimer })?.tick(),
    ).not.toThrow()
  })
})

describe("ADR-0420 observability-ws-sink — frame validity", () => {
  test("every emitted frame decodes to a valid ObservabilityMessage", () => {
    const ws = new FakeServerWebSocket()
    const { port, setEntries } = fakeRunLedger()
    const handle = attachObservabilitySink(ws, { runLedger: port, timer: noopTimer })
    handle?.tick()
    setEntries([entry("a", "running")])
    handle?.tick()
    setEntries([entry("a", "running"), entry("b", "waiting")])
    handle?.tick()
    const frames = ws.observabilityFrames()
    expect(frames.length).toBeGreaterThanOrEqual(2)
    for (const raw of frames) {
      const msg = decodeObservabilityFrame(raw)
      expect(msg).not.toBeNull()
      expect(isObservabilityMessage(msg as ObservabilityMessage)).toBe(true)
    }
  })

  test("snapshot frame carries the live run set", () => {
    const ws = new FakeServerWebSocket()
    const { port, setEntries } = fakeRunLedger()
    setEntries([entry("seed", "running")])
    const handle = attachObservabilitySink(ws, { runLedger: port, timer: noopTimer })
    handle?.tick()
    const msg = decodeObservabilityFrame(ws.observabilityFrames()[0])
    expect(msg?.kind).toBe("observability.snapshot")
    if (msg?.kind === "observability.snapshot") {
      expect(msg.runs.map((r) => r.id)).toEqual(["seed"])
    }
  })
})
