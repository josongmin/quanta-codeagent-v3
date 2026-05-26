import { describe, expect, test } from "bun:test"
import {
  type BunServerWebSocketLike,
  createBunWebSocketAdapter,
} from "@/apps/web-daemon/ws-adapter"

const makeFakeBunSocket = () => {
  const sent: Array<string | Uint8Array> = []
  let closed: { code: number | undefined; reason: string | undefined } | undefined
  const socket: BunServerWebSocketLike = {
    send(data) {
      sent.push(data)
      return typeof data === "string" ? data.length : data.byteLength
    },
    close(code, reason) {
      closed = { code, reason }
    },
  }
  return { socket, sent, getClosed: () => closed }
}

describe("BunWebSocketAdapter", () => {
  test("addEventListener('message') receives string frames pushed via pushMessage", () => {
    const { socket } = makeFakeBunSocket()
    const adapter = createBunWebSocketAdapter(socket)
    const received: unknown[] = []
    adapter.socket.addEventListener("message", (event) => received.push(event.data))

    adapter.pushMessage("hello")
    adapter.pushMessage("world")

    expect(received).toEqual(["hello", "world"])
  })

  test("decodes Uint8Array frames as UTF-8 text", () => {
    const { socket } = makeFakeBunSocket()
    const adapter = createBunWebSocketAdapter(socket)
    const received: unknown[] = []
    adapter.socket.addEventListener("message", (event) => received.push(event.data))

    adapter.pushMessage(new TextEncoder().encode("∑hello"))
    expect(received).toEqual(["∑hello"])
  })

  test("drops non-UTF8 binary frames silently (text-only v1)", () => {
    const { socket } = makeFakeBunSocket()
    const adapter = createBunWebSocketAdapter(socket)
    const received: unknown[] = []
    adapter.socket.addEventListener("message", (event) => received.push(event.data))

    // Invalid UTF-8 lead byte sequence.
    adapter.pushMessage(new Uint8Array([0xff, 0xfe, 0xfd]))
    expect(received).toEqual([])
  })

  test("send() forwards to the underlying Bun socket", () => {
    const { socket, sent } = makeFakeBunSocket()
    const adapter = createBunWebSocketAdapter(socket)
    adapter.socket.send("ping")
    adapter.socket.send("pong")
    expect(sent).toEqual(["ping", "pong"])
  })

  test("close() invokes ws.close() exactly once even when called repeatedly", () => {
    let closeCalls = 0
    const socket: BunServerWebSocketLike = {
      send() {
        return 0
      },
      close() {
        closeCalls++
      },
    }
    const adapter = createBunWebSocketAdapter(socket)
    adapter.socket.close(1000, "ok")
    adapter.socket.close(1000, "ok")
    expect(closeCalls).toBe(1)
  })

  test("after close(), pushMessage and send are no-ops", () => {
    const { socket, sent } = makeFakeBunSocket()
    const adapter = createBunWebSocketAdapter(socket)
    const received: unknown[] = []
    adapter.socket.addEventListener("message", (event) => received.push(event.data))

    adapter.socket.close()
    adapter.pushMessage("after-close")
    adapter.socket.send("after-close")

    expect(received).toEqual([])
    expect(sent).toEqual([])
  })

  test("handleClose() (server-initiated close) does NOT call ws.close() — adapter only", () => {
    let closeCalls = 0
    const socket: BunServerWebSocketLike = {
      send() {
        return 0
      },
      close() {
        closeCalls++
      },
    }
    const adapter = createBunWebSocketAdapter(socket)
    adapter.handleClose()
    expect(closeCalls).toBe(0)
  })

  test("after handleClose(), pushMessage is a no-op (no double-delivery to peers)", () => {
    const { socket } = makeFakeBunSocket()
    const adapter = createBunWebSocketAdapter(socket)
    const received: unknown[] = []
    adapter.socket.addEventListener("message", (event) => received.push(event.data))

    adapter.handleClose()
    adapter.pushMessage("ghost")
    expect(received).toEqual([])
  })

  test("a throwing listener does not poison sibling listeners", () => {
    const { socket } = makeFakeBunSocket()
    const adapter = createBunWebSocketAdapter(socket)
    const received: unknown[] = []
    adapter.socket.addEventListener("message", () => {
      throw new Error("poison")
    })
    adapter.socket.addEventListener("message", (event) => received.push(event.data))

    adapter.pushMessage("survives")
    expect(received).toEqual(["survives"])
  })

  test("removeEventListener stops further delivery", () => {
    const { socket } = makeFakeBunSocket()
    const adapter = createBunWebSocketAdapter(socket)
    const received: unknown[] = []
    const handler = (event: { data: unknown }): void => {
      received.push(event.data)
    }
    adapter.socket.addEventListener("message", handler)
    adapter.pushMessage("one")
    adapter.socket.removeEventListener?.("message", handler)
    adapter.pushMessage("two")
    expect(received).toEqual(["one"])
  })
})
