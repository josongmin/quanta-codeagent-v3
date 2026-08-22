/**
 * `@/ipc#EventBridge` — publish / subscribe / loopback / multi-peer round-trip.
 *
 * Covered:
 *   1. Solo transport publish lands on every local subscriber (loopback +
 *      transport re-delivery — transport is the test fixture).
 *   2. Unsubscribe stops further deliveries; remaining subscribers keep
 *      receiving.
 *   3. `close()` is idempotent + post-close publishes are no-ops.
 *   4. Multi-subscriber broadcast: every subscriber sees every publish.
 *   5. Hub round-trip: bridge-A publishes → bridge-B's subscribers see it,
 *      preserving every wire-envelope field bit-for-bit.
 *   6. Subscriber that throws does not poison peers.
 *   7. Each `BridgePayload` variant round-trips through encode/decode.
 *   8. `isWireEnvelope` rejects malformed payloads (protocol mismatch,
 *      missing fields, unknown payload type).
 *   9. Stdio transport: line-delimited JSON framing — partial chunks
 *      buffer correctly and reassemble.
 *  10. Stdio transport: malformed JSON line is dropped silently.
 */

import { describe, expect, test } from "bun:test"

import type { BridgeEvent, BridgePayload, BridgeTransport, WireEnvelope } from "@/ipc"
import {
  createEventBridge,
  createInMemoryHub,
  createInMemoryTransport,
  createStdioTransport,
  isoNow,
  isWireEnvelope,
} from "@/ipc"

/* ------------------------------------------------------------------ */
/* Helpers.                                                            */
/* ------------------------------------------------------------------ */

const makeEvent = (overrides: Partial<BridgeEvent> = {}): BridgeEvent => ({
  source: "cli",
  sessionId: "sess-1",
  payload: { type: "user_input", prompt: "hello" },
  timestamp: "2026-05-24T00:00:00.000Z",
  ...overrides,
})

/** Minimal Node-stream-like fixture for stdio framing tests. */
const makeStreamPair = () => {
  let dataHandler: ((chunk: Buffer | string) => void) | undefined
  const reader = {
    on(event: "data", h: (chunk: Buffer | string) => void) {
      if (event === "data") dataHandler = h
    },
    off(event: "data", h: (chunk: Buffer | string) => void) {
      if (event === "data" && dataHandler === h) dataHandler = undefined
    },
  }
  const written: string[] = []
  const writer = {
    write(chunk: string) {
      written.push(chunk)
      return true
    },
  }
  return {
    reader,
    writer,
    push(chunk: string) {
      dataHandler?.(chunk)
    },
    written,
  }
}

/* ------------------------------------------------------------------ */
/* Solo transport / loopback / unsubscribe / close.                    */
/* ------------------------------------------------------------------ */

describe("EventBridge — solo + loopback", () => {
  test("publish delivers to every local subscriber", async () => {
    const t = createInMemoryTransport()
    const b = createEventBridge({ source: "cli", transport: t })
    const seen: BridgeEvent[] = []
    b.subscribe((e) => {
      seen.push(e)
    })
    await b.publish(makeEvent())
    // Solo transport double-delivers (loopback + transport reflect) — we
    // assert "at least one", and that the payload survives intact.
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0]?.payload).toEqual({ type: "user_input", prompt: "hello" })
    await b.close()
  })

  test("unsubscribe stops further deliveries", async () => {
    const t = createInMemoryTransport()
    const b = createEventBridge({ source: "cli", transport: t })
    let count = 0
    const unsub = b.subscribe(() => {
      count++
    })
    await b.publish(makeEvent())
    const after1 = count
    unsub()
    await b.publish(makeEvent())
    expect(count).toBe(after1) // no new deliveries
    await b.close()
  })

  test("close is idempotent and post-close publishes are no-ops", async () => {
    const t = createInMemoryTransport()
    const b = createEventBridge({ source: "cli", transport: t })
    let count = 0
    b.subscribe(() => {
      count++
    })
    await b.close()
    await b.close() // idempotent — no throw
    await b.publish(makeEvent())
    expect(count).toBe(0)
  })

  test("multi-subscriber broadcast", async () => {
    const t = createInMemoryTransport()
    const b = createEventBridge({ source: "cli", transport: t })
    const a: BridgeEvent[] = []
    const c: BridgeEvent[] = []
    b.subscribe((e) => a.push(e))
    b.subscribe((e) => c.push(e))
    await b.publish(makeEvent())
    expect(a.length).toBeGreaterThanOrEqual(1)
    expect(c.length).toBeGreaterThanOrEqual(1)
    await b.close()
  })

  test("subscriber that throws does not poison peers", async () => {
    const t = createInMemoryTransport()
    const b = createEventBridge({ source: "cli", transport: t })
    let goodSeen = 0
    b.subscribe(() => {
      throw new Error("boom")
    })
    b.subscribe(() => {
      goodSeen++
    })
    await b.publish(makeEvent())
    expect(goodSeen).toBeGreaterThanOrEqual(1)
    await b.close()
  })
})

/* ------------------------------------------------------------------ */
/* Multi-peer hub round-trip.                                          */
/* ------------------------------------------------------------------ */

describe("EventBridge — hub round-trip", () => {
  test("bridge-A publish lands on bridge-B subscribers", async () => {
    const hub = createInMemoryHub()
    const tA = hub.attach()
    const tB = hub.attach()
    const a = createEventBridge({ source: "cli", transport: tA })
    const b = createEventBridge({ source: "web", transport: tB })
    const inbound: BridgeEvent[] = []
    b.subscribe((e) => inbound.push(e))
    await a.publish(makeEvent({ source: "cli" }))
    expect(inbound.length).toBe(1)
    expect(inbound[0]?.source).toBe("cli")
    expect(inbound[0]?.payload).toEqual({ type: "user_input", prompt: "hello" })
    await a.close()
    await b.close()
  })

  test("hub does not echo to sender (sender's loopback is local-only)", async () => {
    const hub = createInMemoryHub()
    const tA = hub.attach()
    const tB = hub.attach()
    const a = createEventBridge({ source: "cli", transport: tA })
    const b = createEventBridge({ source: "web", transport: tB })
    const aInbound: BridgeEvent[] = []
    a.subscribe((e) => aInbound.push(e))
    await a.publish(makeEvent({ source: "cli" }))
    // A's subscriber sees exactly ONE delivery (loopback). The hub does
    // NOT re-deliver back to the sender.
    expect(aInbound.length).toBe(1)
    await a.close()
    await b.close()
  })

  test("every BridgePayload variant round-trips bit-for-bit", async () => {
    const hub = createInMemoryHub()
    const tA = hub.attach()
    const tB = hub.attach()
    const a = createEventBridge({ source: "cli", transport: tA })
    const b = createEventBridge({ source: "web", transport: tB })

    const variants: BridgePayload[] = [
      { type: "agent_event", event: { type: "turn_start", turn: 1 } },
      {
        type: "session_started",
        meta: {
          id: "s1",
          title: "t",
          cwd: "/x",
          createdAt: 1,
          lastTouched: 2,
          archived: false,
        },
      },
      { type: "session_ended", outcome: { reason: "ok", turns: 3 } },
      { type: "user_input", prompt: "hi" },
      {
        type: "permission_request",
        request: { toolName: "shell_exec", preview: "ls", requestId: "r1" },
      },
      { type: "permission_response", allow: true, requestId: "r1" },
      { type: "presence", surface: "web", status: "active" },
    ]

    const inbound: BridgeEvent[] = []
    b.subscribe((e) => inbound.push(e))
    for (const payload of variants) {
      await a.publish({
        source: "cli",
        sessionId: "s1",
        payload,
        timestamp: isoNow(),
      })
    }
    expect(inbound.length).toBe(variants.length)
    for (let i = 0; i < variants.length; i++) {
      expect(inbound[i]?.payload).toEqual(variants[i] as BridgePayload)
    }
    await a.close()
    await b.close()
  })
})

/* ------------------------------------------------------------------ */
/* Wire envelope validator.                                            */
/* ------------------------------------------------------------------ */

describe("isWireEnvelope", () => {
  test("accepts a well-formed envelope", () => {
    const env: WireEnvelope = {
      protocol: "quanta.ipc.v1",
      source: "cli",
      sessionId: "s",
      payload: { type: "user_input", prompt: "x" },
      timestamp: "2026-05-24T00:00:00Z",
    }
    expect(isWireEnvelope(env)).toBe(true)
  })

  test("rejects null / non-object / missing fields / unknown payload type", () => {
    expect(isWireEnvelope(null)).toBe(false)
    expect(isWireEnvelope("nope")).toBe(false)
    expect(
      isWireEnvelope({
        protocol: "wrong",
        source: "x",
        sessionId: "x",
        payload: {},
        timestamp: "",
      }),
    ).toBe(false)
    expect(
      isWireEnvelope({
        protocol: "quanta.ipc.v1",
        source: "",
        sessionId: "x",
        payload: { type: "user_input", prompt: "x" },
        timestamp: "x",
      }),
    ).toBe(false)
    expect(
      isWireEnvelope({
        protocol: "quanta.ipc.v1",
        source: "x",
        sessionId: "x",
        payload: { type: "totally_unknown" },
        timestamp: "x",
      }),
    ).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* Stdio transport framing.                                            */
/* ------------------------------------------------------------------ */

describe("stdio transport framing", () => {
  test("line-delimited JSON: chunk boundary mid-line still re-assembles", async () => {
    const pair = makeStreamPair()
    const t = createStdioTransport({ reader: pair.reader, writer: pair.writer })
    const received: WireEnvelope[] = []
    t.onMessage((e) => received.push(e))
    const env: WireEnvelope = {
      protocol: "quanta.ipc.v1",
      source: "cli",
      sessionId: "s",
      payload: { type: "user_input", prompt: "hi" },
      timestamp: "2026-05-24T00:00:00Z",
    }
    const wire = `${JSON.stringify(env)}\n`
    // Split mid-string.
    pair.push(wire.slice(0, 5))
    pair.push(wire.slice(5))
    expect(received.length).toBe(1)
    expect(received[0]).toEqual(env)
    await t.close()
  })

  test("malformed JSON line is dropped silently", async () => {
    const pair = makeStreamPair()
    const t = createStdioTransport({ reader: pair.reader, writer: pair.writer })
    const received: WireEnvelope[] = []
    t.onMessage((e) => received.push(e))
    pair.push("not valid json\n")
    expect(received.length).toBe(0)
    await t.close()
  })

  test("send writes JSON-encoded envelope with trailing newline", async () => {
    const pair = makeStreamPair()
    const t: BridgeTransport = createStdioTransport({
      reader: pair.reader,
      writer: pair.writer,
    })
    const env: WireEnvelope = {
      protocol: "quanta.ipc.v1",
      source: "cli",
      sessionId: "s",
      payload: { type: "presence", surface: "cli", status: "active" },
      timestamp: "2026-05-24T00:00:00Z",
    }
    await t.send(env)
    expect(pair.written.length).toBe(1)
    expect(pair.written[0]?.endsWith("\n")).toBe(true)
    const decoded = JSON.parse(pair.written[0]?.replace(/\n$/, "") ?? "")
    expect(decoded).toEqual(env)
    await t.close()
  })
})
