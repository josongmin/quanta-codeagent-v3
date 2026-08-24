import { describe, expect, test } from "bun:test"
import { createBunWebSocketAdapter, type WebSocketCtor, type WebSocketLike } from "@/realtime"
import { nth } from "../../_helpers/expect-present"

/**
 * T07 hellgate — realtime close-path idempotency + sibling-listener isolation.
 *
 * Proves the audit L6 C1 / H7 / H8 fixes:
 *   - C1: a SECOND `close()` entering while the first is mid-flight (status
 *     "closing") must NOT strand the first close promise. Both resolve.
 *   - H7: a throwing `prevOnClose` (chained socket close handler) must not
 *     swallow the `resolve()` — the close promise still settles.
 *   - H8: a throwing inbound subscriber must not starve its siblings — every
 *     other handler still receives the message.
 */

const WS_CONNECTING = 0
const WS_OPEN = 1
const WS_CLOSING = 2
const WS_CLOSED = 3

class FakeWebSocket implements WebSocketLike {
  readyState: number = WS_CONNECTING
  onopen: ((this: WebSocketLike, ev: unknown) => void) | null = null
  onmessage: ((this: WebSocketLike, ev: { data: unknown }) => void) | null = null
  onclose: ((this: WebSocketLike, ev: { code: number; reason: string }) => void) | null = null
  onerror: ((this: WebSocketLike, ev: unknown) => void) | null = null
  closeCalls = 0

  constructor(
    readonly url: string,
    readonly protocols?: readonly string[],
  ) {}

  send(): void {}

  close(code?: number, reason?: string): void {
    this.closeCalls += 1
    if (this.readyState === WS_CLOSED) return
    this.readyState = WS_CLOSING
    queueMicrotask(() => {
      this.readyState = WS_CLOSED
      this.onclose?.call(this, { code: code ?? 1000, reason: reason ?? "" })
    })
  }

  triggerOpen(): void {
    this.readyState = WS_OPEN
    this.onopen?.call(this, {})
  }
  triggerMessage(data: unknown): void {
    this.onmessage?.call(this, { data })
  }
}

const buildAdapter = (): {
  adapter: ReturnType<typeof createBunWebSocketAdapter>
  sockets: FakeWebSocket[]
} => {
  const sockets: FakeWebSocket[] = []
  const ctor: WebSocketCtor = (url, protocols) => {
    const ws = new FakeWebSocket(url, protocols)
    sockets.push(ws)
    return ws
  }
  return { adapter: createBunWebSocketAdapter({ webSocketCtor: ctor }), sockets }
}

const openAdapter = async (): Promise<{
  adapter: ReturnType<typeof createBunWebSocketAdapter>
  socket: FakeWebSocket
}> => {
  const { adapter, sockets } = buildAdapter()
  const connectP = adapter.connect({ endpoint: "wss://x" })
  sockets[0]?.triggerOpen()
  await connectP
  return { adapter, socket: nth(sockets, 0, "sockets") }
}

describe("T07 realtime close hellgate", () => {
  test("C1: concurrent close() — BOTH promises resolve (first not stranded)", async () => {
    const { adapter } = await openAdapter()

    // Fire two close() calls back-to-back. The second enters while status is
    // "closing". Pre-fix, the second's already-closed/closing path resolved
    // only ITSELF and left the first close promise hung forever.
    const first = adapter.close()
    const second = adapter.close()

    const settle = await Promise.race([
      Promise.all([first, second]).then(() => "both-settled" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 200)),
    ])

    expect(settle).toBe("both-settled")
    const [r1, r2] = await Promise.all([first, second])
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(adapter.status()).toBe("closed")
  })

  test("C1: second close() entering on an already-CLOSED socket still resolves the first", async () => {
    // Targets the exact guard gap: the second close() observes status === "closing"
    // (guard didn't cover it) AND the socket already at readyState CLOSED, so the
    // old already-closed path resolved only ITSELF and stranded the first promise.
    const sockets: FakeWebSocket[] = []
    const ctor: WebSocketCtor = (url, protocols) => {
      const ws = new (class extends FakeWebSocket {
        override close(code?: number, reason?: string): void {
          this.closeCalls += 1
          if (this.readyState === WS_CLOSED) return
          // Synchronous transition to CLOSED so a re-entrant close() sees CLOSED.
          this.readyState = WS_CLOSED
          this.onclose?.call(this, { code: code ?? 1000, reason: reason ?? "" })
        }
      })(url, protocols)
      sockets.push(ws)
      return ws
    }
    const adapter = createBunWebSocketAdapter({ webSocketCtor: ctor })
    const connectP = adapter.connect({ endpoint: "wss://x" })
    sockets[0]?.triggerOpen()
    await connectP

    const first = adapter.close()
    const second = adapter.close()
    const settle = await Promise.race([
      Promise.all([first, second]).then(() => "both" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 200)),
    ])
    expect(settle).toBe("both")
    expect((await first).ok).toBe(true)
    expect((await second).ok).toBe(true)
  })

  test("C1: third close() after closed is a clean idempotent ok", async () => {
    const { adapter } = await openAdapter()
    await adapter.close()
    const again = await adapter.close()
    expect(again.ok).toBe(true)
    expect(adapter.status()).toBe("closed")
  })

  test("H7: throwing prevOnClose does not strand the close promise", async () => {
    const { adapter, socket } = await openAdapter()
    // Install a hostile onclose handler that the adapter must chain to.
    socket.onclose = (): void => {
      throw new Error("hostile prevOnClose")
    }
    const closeP = adapter.close()
    const settle = await Promise.race([
      closeP.then((r) => (r.ok ? "ok" : "err")),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 200)),
    ])
    expect(settle).toBe("ok")
    expect(adapter.status()).toBe("closed")
  })

  test("H8: a throwing inbound subscriber does not starve siblings", async () => {
    const { adapter, socket } = await openAdapter()
    const received: string[] = []
    adapter.onMessage(() => {
      throw new Error("hostile subscriber")
    })
    adapter.onMessage((msg) => {
      if (msg.kind === "text") received.push(msg.data)
    })
    adapter.onMessage((msg) => {
      if (msg.kind === "text") received.push(`b:${msg.data}`)
    })

    // Dispatch must NOT throw out, and BOTH well-behaved siblings must run.
    expect(() => socket.triggerMessage("hello")).not.toThrow()
    expect(received).toEqual(["hello", "b:hello"])
  })
})
