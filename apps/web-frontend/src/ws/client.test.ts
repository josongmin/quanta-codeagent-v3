import { describe, expect, it } from "vitest"
import { SessionClient, type WebSocketLike } from "./client"
import { SESSION_PROTOCOL_VERSION } from "./envelope"

/**
 * Minimal in-memory WebSocket stub — covers the surface SessionClient
 * actually touches. We expose `_simulateOpen` etc. on the instance so
 * tests can drive lifecycle deterministically.
 */
class FakeWebSocket implements WebSocketLike {
  readyState = 0 // CONNECTING
  sent: string[] = []
  closedWith: { code?: number; reason?: string } | null = null
  onopen: ((ev: Event) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  readonly url: string
  readonly protocols: string | readonly string[] | undefined

  constructor(url: string, protocols?: string | readonly string[]) {
    this.url = url
    this.protocols = protocols
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason }
    this.readyState = 3
  }

  _simulateOpen(): void {
    this.readyState = 1
    this.onopen?.(new Event("open"))
  }

  _simulateClose(code: number, reason: string): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }

  _simulateMessage(data: unknown): void {
    this.onmessage?.({ data })
  }
}

interface Harness {
  client: SessionClient
  fakes: FakeWebSocket[]
  timers: Array<{ cb: () => void; ms: number; handle: number }>
  runNextTimer: () => void
}

const buildHarness = (): Harness => {
  const fakes: FakeWebSocket[] = []
  const timers: Array<{ cb: () => void; ms: number; handle: number }> = []
  let nextHandle = 1

  const client = new SessionClient({
    webSocketCtor: ((url: string, protocols?: string | readonly string[]) => {
      const fake = new FakeWebSocket(url, protocols)
      fakes.push(fake)
      return fake
    }) as unknown as new (
      url: string,
      protocols?: string | readonly string[],
    ) => WebSocketLike,
    setTimer: (cb, ms) => {
      const handle = nextHandle
      nextHandle += 1
      timers.push({ cb, ms, handle })
      return handle
    },
    clearTimer: (handle) => {
      const idx = timers.findIndex((t) => t.handle === handle)
      if (idx >= 0) timers.splice(idx, 1)
    },
    log: () => {
      // Silence logs during tests — failure assertions are explicit.
    },
  })

  return {
    client,
    fakes,
    timers,
    runNextTimer: () => {
      const t = timers.shift()
      if (t !== undefined) t.cb()
    },
  }
}

describe("SessionClient", () => {
  it("constructs a WebSocket on connect() and transitions to connected on open", () => {
    const h = buildHarness()
    const states: string[] = []
    h.client.onConnectionChange((s) => states.push(s.kind))

    h.client.connect({ url: "ws://localhost/test" })
    expect(h.fakes).toHaveLength(1)
    expect(h.fakes[0]?.url).toBe("ws://localhost/test")

    h.fakes[0]?._simulateOpen()
    expect(states).toContain("connecting")
    expect(states).toContain("connected")
  })

  it("appends ?token query when an auth token is provided", () => {
    const h = buildHarness()
    h.client.connect({
      url: "ws://localhost/test",
      auth: { token: "abc 123" },
    })
    expect(h.fakes[0]?.url).toBe("ws://localhost/test?token=abc%20123")
  })

  it("appends &token (not ?token) when the URL already has a query string", () => {
    const h = buildHarness()
    h.client.connect({
      url: "ws://localhost/test?x=1",
      auth: { token: "t" },
    })
    expect(h.fakes[0]?.url).toBe("ws://localhost/test?x=1&token=t")
  })

  it("schedules a reconnect via the injected timer after an unexpected close", () => {
    const h = buildHarness()
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    h.fakes[0]?._simulateClose(1006, "abnormal")

    expect(h.timers).toHaveLength(1)
    expect(h.timers[0]?.ms).toBe(500) // base backoff
    expect(h.client.state.kind).toBe("disconnected")

    h.runNextTimer()
    // A second socket should now have been constructed for the reconnect.
    expect(h.fakes).toHaveLength(2)
  })

  it("does NOT reconnect after disconnect() (intentional close)", () => {
    const h = buildHarness()
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    h.client.disconnect()
    h.fakes[0]?._simulateClose(1000, "client_disconnect")

    expect(h.timers).toHaveLength(0)
    expect(h.client.state.kind).toBe("closed")
  })

  it("encodes a sent command into a versioned wire envelope", () => {
    const h = buildHarness()
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()

    h.client.send({
      sessionId: "s1",
      commandId: "c1",
      issuedAt: "2026-05-26T00:00:00.000Z",
      type: "turn.run",
    })

    expect(h.fakes[0]?.sent).toHaveLength(1)
    const sentRaw = h.fakes[0]?.sent[0] ?? ""
    const parsed = JSON.parse(sentRaw) as Record<string, unknown>
    expect(parsed.version).toBe(SESSION_PROTOCOL_VERSION)
    expect(parsed.kind).toBe("command")
  })

  it("dispatches decoded events to type-specific subscribers", () => {
    const h = buildHarness()
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()

    const seen: string[] = []
    h.client.on("turn.completed", (ev) => seen.push(ev.outcomeReason))

    h.fakes[0]?._simulateMessage(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        kind: "event",
        payload: {
          eventId: "e1",
          seq: 1,
          revision: 1,
          emittedAt: "2026-05-26T00:00:00.000Z",
          type: "turn.completed",
          outcomeReason: "ok",
        },
      }),
    )

    expect(seen).toEqual(["ok"])
  })

  it("drops unrecognised frames without throwing", () => {
    const h = buildHarness()
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    expect(() => h.fakes[0]?._simulateMessage("not json")).not.toThrow()
    expect(() => h.fakes[0]?._simulateMessage(123)).not.toThrow()
  })

  it("drops send() calls when the socket is not open (no throw)", () => {
    const h = buildHarness()
    expect(() =>
      h.client.send({
        sessionId: "s",
        commandId: "c",
        issuedAt: "x",
        type: "turn.run",
      }),
    ).not.toThrow()
    // No socket was created (connect not called) — nothing to assert on `sent`.
    expect(h.fakes).toHaveLength(0)
  })

  it("increments the attempt counter on each consecutive close", () => {
    const h = buildHarness()
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateClose(1006, "fail1")
    expect(h.client.state.kind).toBe("disconnected")
    if (h.client.state.kind === "disconnected") {
      expect(h.client.state.attempt).toBe(1)
      expect(h.client.state.retryInMs).toBe(500)
    }
    h.runNextTimer()
    h.fakes[1]?._simulateClose(1006, "fail2")
    if (h.client.state.kind === "disconnected") {
      expect(h.client.state.attempt).toBe(2)
      expect(h.client.state.retryInMs).toBe(1000)
    }
  })
})
