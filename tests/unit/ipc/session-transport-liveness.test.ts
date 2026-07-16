import { describe, expect, test } from "bun:test"
import {
  createSessionStdioTransport,
  createSessionTransportClient,
  encodeSessionTransportMessage,
  type SessionTransport,
  type SessionTransportCloseInfo,
  type SessionTransportConnectionState,
  type SessionTransportMessage,
  wrapWebSocketLikeAsSessionTransport,
} from "@/ipc/session"

/**
 * S4 liveness hellgate — connection-death notification (jul-16 transport-unified
 * SDK, ticket 01 §2 S4; R1 audit HIGH-5).
 *
 * BEFORE S4: `SessionTransport` was send/onMessage/close only — when the peer
 * (daemon) died, the WS wrap kept listening for `message` on a dead socket and
 * the raw client had NO channel to hear about it. The CLI attach client papered
 * over this with raw socket listeners OUTSIDE the abstraction
 * (attach-client.ts "audit finding #1"), and every other consumer simply hung.
 *
 * These tests were written RED-first against that gap: the headline case below
 * (`daemon-side socket death → onConnectionState("closed")`) fails on the
 * pre-S4 code because neither `transport.onClose` nor
 * `client.onConnectionState` exists.
 */

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

type AnyListener = (event?: unknown) => void

/** The handler shape `SessionWebSocketLike` pins for `message`. The harness
 *  accepts every registration through this shape (what real WS typings do via
 *  overloads) and stores close/error listeners as the wider runtime shape. */
type SocketListener = (event: { data: unknown }) => void

/** A real-WebSocket-shaped fake: dispatches `message` AND `close`/`error` by
 *  event name, exactly like the WHATWG socket the attach client wraps. */
const makeLifecycleSocketHarness = () => {
  const messageListeners = new Set<SocketListener>()
  const closeListeners = new Set<AnyListener>()
  const errorListeners = new Set<AnyListener>()
  const sent: string[] = []
  let closeCalls = 0
  const socket = {
    send(data: string) {
      sent.push(data)
    },
    close() {
      closeCalls += 1
    },
    addEventListener(type: "message" | "close" | "error", handler: SocketListener) {
      if (type === "message") {
        messageListeners.add(handler)
      } else if (type === "close") {
        closeListeners.add(handler as AnyListener)
      } else if (type === "error") {
        errorListeners.add(handler as AnyListener)
      }
    },
    removeEventListener(type: "message" | "close" | "error", handler: SocketListener) {
      if (type === "message") {
        messageListeners.delete(handler)
      } else if (type === "close") {
        closeListeners.delete(handler as AnyListener)
      } else if (type === "error") {
        errorListeners.delete(handler as AnyListener)
      }
    },
  }
  return {
    socket,
    emitMessage(data: unknown) {
      for (const handler of [...messageListeners]) handler({ data })
    },
    emitClose(event: { code?: number; reason?: string } = {}) {
      for (const handler of [...closeListeners]) handler(event)
    },
    emitError(error?: unknown) {
      for (const handler of [...errorListeners]) handler(error)
    },
    counts() {
      return {
        message: messageListeners.size,
        close: closeListeners.size,
        error: errorListeners.size,
      }
    },
    sent,
    closeCalls: () => closeCalls,
  }
}

/** A message-ONLY socket (the shape every pre-S4 fixture had): registration of
 *  close/error must be a harmless no-op against it. */
const makeMessageOnlySocketHarness = () => {
  const listeners = new Set<(event: { data: unknown }) => void>()
  const sent: string[] = []
  return {
    socket: {
      send(data: string) {
        sent.push(data)
      },
      close() {
        return undefined
      },
      addEventListener(type: "message", handler: (event: { data: unknown }) => void) {
        if (type === "message") listeners.add(handler)
      },
      removeEventListener(type: "message", handler: (event: { data: unknown }) => void) {
        if (type === "message") listeners.delete(handler)
      },
    },
    emit(data: unknown) {
      for (const handler of [...listeners]) handler({ data })
    },
    sent,
  }
}

const makeStreamPair = (writeImpl?: (chunk: string) => unknown) => {
  let dataHandler: ((chunk: Buffer | string) => void) | undefined
  const written: string[] = []
  return {
    reader: {
      on(event: "data", handler: (chunk: Buffer | string) => void) {
        if (event === "data") dataHandler = handler
      },
      off(event: "data", handler: (chunk: Buffer | string) => void) {
        if (event === "data" && dataHandler === handler) dataHandler = undefined
      },
    },
    writer: {
      write(chunk: string) {
        if (writeImpl !== undefined) return writeImpl(chunk)
        written.push(chunk)
        return true
      },
    },
    push(chunk: string) {
      dataHandler?.(chunk)
    },
    /** True while the transport's `data` listener is attached. */
    get attached() {
      return dataHandler !== undefined
    },
    written,
  }
}

/** A minimal legacy transport WITHOUT `onClose` — its very compilability proves
 *  the S4 extension is additive-optional; the client tests prove the fallback
 *  "closed" path for it. */
const makeLegacyTransport = () => {
  const handlers = new Set<(message: SessionTransportMessage) => void | Promise<void>>()
  const sent: SessionTransportMessage[] = []
  let closed = false
  const transport: SessionTransport = {
    async send(message) {
      if (closed) return
      sent.push(message)
    },
    onMessage(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    async close() {
      closed = true
      handlers.clear()
    },
  }
  return { transport, sent, isClosed: () => closed }
}

const HEARTBEAT_PING: SessionTransportMessage = { kind: "heartbeat", phase: "ping" }

const subscribeClose = (transport: SessionTransport): SessionTransportCloseInfo[] => {
  const infos: SessionTransportCloseInfo[] = []
  expect(typeof transport.onClose).toBe("function")
  transport.onClose?.((info) => infos.push(info))
  return infos
}

// ---------------------------------------------------------------------------
// headline RED case
// ---------------------------------------------------------------------------

describe("S4 liveness — connection death must be heard (R1 HIGH-5)", () => {
  test("HELLGATE: daemon-side socket death surfaces on the raw client as onConnectionState('closed')", async () => {
    const harness = makeLifecycleSocketHarness()
    const transport = wrapWebSocketLikeAsSessionTransport(harness.socket)
    const client = createSessionTransportClient({ transport, sessionId: "session-1" })

    const states: SessionTransportConnectionState[] = []
    client.onConnectionState((state) => states.push(state))

    await client.connect()
    expect(states).toEqual([{ status: "connected" }])

    // The daemon process is killed → the WS stack fires `close` on the socket.
    // Pre-S4 the wrap listened only for `message`, so the client heard NOTHING.
    harness.emitClose({ code: 1006, reason: "daemon died" })

    expect(states).toHaveLength(2)
    const terminal = states[1]
    if (terminal?.status !== "closed") {
      throw new Error(`expected terminal 'closed' state, got ${JSON.stringify(terminal)}`)
    }
    expect(terminal.reason).toContain("socket_close")
    expect(terminal.reason).toContain("code=1006")
    expect(terminal.reason).toContain("daemon died")
  })
})

// ---------------------------------------------------------------------------
// WS wrap
// ---------------------------------------------------------------------------

describe("S4 WS wrap onClose", () => {
  test("socket `close` event fires onClose exactly once with a descriptive reason (double event → single fire)", () => {
    const harness = makeLifecycleSocketHarness()
    const transport = wrapWebSocketLikeAsSessionTransport(harness.socket)
    const infos = subscribeClose(transport)

    harness.emitClose({ code: 1001, reason: "going away" })
    harness.emitClose({ code: 1001, reason: "going away" })

    expect(infos).toHaveLength(1)
    expect(infos[0]?.reason).toContain("socket_close")
    expect(infos[0]?.reason).toContain("code=1001")
    expect(infos[0]?.reason).toContain("going away")
  })

  test("socket `error` event fires onClose with an error-flavored reason", () => {
    const harness = makeLifecycleSocketHarness()
    const transport = wrapWebSocketLikeAsSessionTransport(harness.socket)
    const infos = subscribeClose(transport)

    harness.emitError(new Error("ECONNRESET"))

    expect(infos).toHaveLength(1)
    expect(infos[0]?.reason).toContain("socket_error")
    expect(infos[0]?.reason).toContain("ECONNRESET")
  })

  test("error-then-close (the typical real WS death sequence) notifies exactly once — first reason wins", () => {
    const harness = makeLifecycleSocketHarness()
    const transport = wrapWebSocketLikeAsSessionTransport(harness.socket)
    const infos = subscribeClose(transport)

    harness.emitError(new Error("ECONNRESET"))
    harness.emitClose({ code: 1006 })

    expect(infos).toHaveLength(1)
    expect(infos[0]?.reason).toContain("socket_error")
  })

  test("owner-initiated close() notifies onClose('local_close'), closes the socket, and is idempotent", async () => {
    const harness = makeLifecycleSocketHarness()
    const transport = wrapWebSocketLikeAsSessionTransport(harness.socket)
    const infos = subscribeClose(transport)

    await transport.close()
    expect(infos).toEqual([{ reason: "local_close" }])
    expect(harness.closeCalls()).toBe(1)

    await transport.close()
    expect(infos).toHaveLength(1)
    expect(harness.closeCalls()).toBe(1)
  })

  test("a handler subscribed AFTER the socket died is invoked immediately (no missed death notice)", () => {
    const harness = makeLifecycleSocketHarness()
    const transport = wrapWebSocketLikeAsSessionTransport(harness.socket)

    harness.emitClose({ code: 1006 })

    const infos = subscribeClose(transport)
    expect(infos).toHaveLength(1)
    expect(infos[0]?.reason).toContain("socket_close")
  })

  test("an unsubscribed onClose handler is NOT invoked", () => {
    const harness = makeLifecycleSocketHarness()
    const transport = wrapWebSocketLikeAsSessionTransport(harness.socket)
    const infos: SessionTransportCloseInfo[] = []
    const unsubscribe = transport.onClose?.((info) => infos.push(info))
    expect(typeof unsubscribe).toBe("function")
    unsubscribe?.()

    harness.emitClose({ code: 1006 })
    expect(infos).toHaveLength(0)
  })

  test("a throwing onClose handler does not poison sibling subscribers", () => {
    const harness = makeLifecycleSocketHarness()
    const transport = wrapWebSocketLikeAsSessionTransport(harness.socket)
    const infos: SessionTransportCloseInfo[] = []
    transport.onClose?.(() => {
      throw new Error("bad subscriber")
    })
    transport.onClose?.((info) => infos.push(info))

    harness.emitClose({})
    expect(infos).toHaveLength(1)
  })

  test("teardown detaches message/close/error listeners from the socket (no listener leak) — death path", () => {
    const harness = makeLifecycleSocketHarness()
    wrapWebSocketLikeAsSessionTransport(harness.socket)
    expect(harness.counts()).toEqual({ message: 1, close: 1, error: 1 })

    harness.emitClose({})
    expect(harness.counts()).toEqual({ message: 0, close: 0, error: 0 })
  })

  test("teardown detaches message/close/error listeners from the socket (no listener leak) — local close path", async () => {
    const harness = makeLifecycleSocketHarness()
    const transport = wrapWebSocketLikeAsSessionTransport(harness.socket)
    expect(harness.counts()).toEqual({ message: 1, close: 1, error: 1 })

    await transport.close()
    expect(harness.counts()).toEqual({ message: 0, close: 0, error: 0 })
  })

  test("send() after socket death is a silent no-op (no frames pushed at a dead socket)", async () => {
    const harness = makeLifecycleSocketHarness()
    const transport = wrapWebSocketLikeAsSessionTransport(harness.socket)

    harness.emitClose({})
    await transport.send(HEARTBEAT_PING)

    expect(harness.sent).toHaveLength(0)
  })

  test("a message-only socket (pre-S4 fixture shape) still works: frames flow, close() notifies local_close", async () => {
    const harness = makeMessageOnlySocketHarness()
    const transport = wrapWebSocketLikeAsSessionTransport(harness.socket)
    const infos = subscribeClose(transport)

    const seen: SessionTransportMessage[] = []
    transport.onMessage((message) => {
      seen.push(message)
    })
    harness.emit(encodeSessionTransportMessage(HEARTBEAT_PING))
    expect(seen).toEqual([HEARTBEAT_PING])

    await transport.close()
    expect(infos).toEqual([{ reason: "local_close" }])
  })
})

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

describe("S4 stdio transport onClose", () => {
  test("close() fires onClose('local_close') exactly once — idempotent", async () => {
    const pair = makeStreamPair()
    const transport = createSessionStdioTransport({ reader: pair.reader, writer: pair.writer })
    const infos = subscribeClose(transport)

    await transport.close()
    await transport.close()

    expect(infos).toEqual([{ reason: "local_close" }])
    expect(pair.attached).toBe(false)
  })

  test("a throwing writer tears the transport down, fires onClose('writer_error …'), and rethrows to the sender", async () => {
    const pair = makeStreamPair(() => {
      throw new Error("EPIPE: broken pipe")
    })
    const transport = createSessionStdioTransport({ reader: pair.reader, writer: pair.writer })
    const infos = subscribeClose(transport)
    const seen: SessionTransportMessage[] = []
    transport.onMessage((message) => {
      seen.push(message)
    })

    // The send REJECTS (caller-visible behavior preserved) …
    expect(transport.send(HEARTBEAT_PING)).rejects.toThrow("EPIPE")
    // … and the liveness channel heard about the death, once.
    expect(infos).toHaveLength(1)
    expect(infos[0]?.reason).toContain("writer_error")
    expect(infos[0]?.reason).toContain("EPIPE")

    // Transport is dead: inbound frames are dropped, close() does not re-fire.
    pair.push(`${encodeSessionTransportMessage(HEARTBEAT_PING)}\n`)
    expect(seen).toHaveLength(0)
    await transport.close()
    expect(infos).toHaveLength(1)
  })

  test("the frame-cap DoS teardown reports itself via onClose (reason frame_too_large)", () => {
    const pair = makeStreamPair()
    const transport = createSessionStdioTransport({ reader: pair.reader, writer: pair.writer })
    const infos = subscribeClose(transport)

    pair.push("x".repeat(32 * 1024 * 1024 + 1)) // one past MAX_FRAME_CHARS, no newline

    expect(infos).toHaveLength(1)
    expect(infos[0]?.reason).toContain("frame_too_large")
    expect(pair.attached).toBe(false)
  })

  test("a late onClose subscriber after teardown is invoked immediately", async () => {
    const pair = makeStreamPair()
    const transport = createSessionStdioTransport({ reader: pair.reader, writer: pair.writer })
    await transport.close()

    const infos = subscribeClose(transport)
    expect(infos).toEqual([{ reason: "local_close" }])
  })

  test("reader lifecycle events are NOT wired here (EOF semantics = ticket 02 scope) — transport stays alive", () => {
    // A rich reader that ALSO exposes end/error channels: the session stdio
    // transport deliberately subscribes to `data` only (the port is data-only so
    // existing fixtures stay assignable). Firing lifecycle events must be inert
    // — pinning today's seam so ticket 02 flips it consciously, not by drift.
    const lifecycleHandlers = new Map<string, (arg?: unknown) => void>()
    let dataHandler: ((chunk: Buffer | string) => void) | undefined
    const reader = {
      on(event: string, handler: (...args: never[]) => void) {
        if (event === "data") dataHandler = handler as (chunk: Buffer | string) => void
        else lifecycleHandlers.set(event, handler as (arg?: unknown) => void)
      },
      off(event: string, handler: (...args: never[]) => void) {
        if (event === "data" && dataHandler === handler) dataHandler = undefined
      },
    }
    const transport = createSessionStdioTransport({
      reader,
      writer: { write: () => true },
    })
    const infos: SessionTransportCloseInfo[] = []
    transport.onClose?.((info) => infos.push(info))

    // No lifecycle subscription happened at all …
    expect(lifecycleHandlers.size).toBe(0)
    // … and the transport still decodes data afterwards.
    const seen: SessionTransportMessage[] = []
    transport.onMessage((message) => {
      seen.push(message)
    })
    dataHandler?.(`${encodeSessionTransportMessage(HEARTBEAT_PING)}\n`)
    expect(seen).toEqual([HEARTBEAT_PING])
    expect(infos).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// raw client onConnectionState
// ---------------------------------------------------------------------------

describe("S4 raw client onConnectionState", () => {
  test("connect() success notifies 'connected' (transport-level submitted — not a server ack)", async () => {
    const harness = makeLifecycleSocketHarness()
    const client = createSessionTransportClient({
      transport: wrapWebSocketLikeAsSessionTransport(harness.socket),
      sessionId: "session-1",
    })
    const states: SessionTransportConnectionState[] = []
    client.onConnectionState((state) => states.push(state))

    await client.connect()

    expect(states).toEqual([{ status: "connected" }])
    expect(harness.sent).toHaveLength(1)
  })

  test("a stdio writer death mid-command surfaces as 'closed' with the writer_error reason", async () => {
    const pair = makeStreamPair(() => {
      throw new Error("EPIPE: broken pipe")
    })
    const client = createSessionTransportClient({
      transport: createSessionStdioTransport({ reader: pair.reader, writer: pair.writer }),
      sessionId: "session-1",
    })
    const states: SessionTransportConnectionState[] = []
    client.onConnectionState((state) => states.push(state))

    expect(client.connect()).rejects.toThrow("EPIPE")

    expect(states).toHaveLength(1)
    const terminal = states[0]
    if (terminal?.status !== "closed") {
      throw new Error(`expected 'closed', got ${JSON.stringify(terminal)}`)
    }
    expect(terminal.reason).toContain("writer_error")
  })

  test("client.close() notifies 'closed' (local_close) exactly once — transport onClose and fallback don't double-fire", async () => {
    const harness = makeLifecycleSocketHarness()
    const client = createSessionTransportClient({
      transport: wrapWebSocketLikeAsSessionTransport(harness.socket),
      sessionId: "session-1",
    })
    const states: SessionTransportConnectionState[] = []
    client.onConnectionState((state) => states.push(state))

    await client.close()
    await client.close()

    expect(states).toEqual([{ status: "closed", reason: "local_close" }])
  })

  test("a transport WITHOUT onClose (legacy shape) still yields 'closed' on client.close() — fallback channel", async () => {
    const legacy = makeLegacyTransport()
    const client = createSessionTransportClient({
      transport: legacy.transport,
      sessionId: "session-1",
    })
    const states: SessionTransportConnectionState[] = []
    client.onConnectionState((state) => states.push(state))

    await client.connect()
    await client.close()

    expect(states).toEqual([{ status: "connected" }, { status: "closed", reason: "local_close" }])
    expect(legacy.isClosed()).toBe(true)
  })

  test("a late onConnectionState subscriber after death receives the terminal 'closed' immediately", async () => {
    const harness = makeLifecycleSocketHarness()
    const client = createSessionTransportClient({
      transport: wrapWebSocketLikeAsSessionTransport(harness.socket),
      sessionId: "session-1",
    })
    harness.emitClose({ code: 1006 })

    const states: SessionTransportConnectionState[] = []
    client.onConnectionState((state) => states.push(state))

    expect(states).toHaveLength(1)
    expect(states[0]?.status).toBe("closed")
  })

  test("an unsubscribed onConnectionState handler stops receiving", async () => {
    const harness = makeLifecycleSocketHarness()
    const client = createSessionTransportClient({
      transport: wrapWebSocketLikeAsSessionTransport(harness.socket),
      sessionId: "session-1",
    })
    const states: SessionTransportConnectionState[] = []
    const unsubscribe = client.onConnectionState((state) => states.push(state))
    unsubscribe()

    await client.connect()
    harness.emitClose({})

    expect(states).toHaveLength(0)
  })

  test("a throwing state handler does not poison sibling subscribers", async () => {
    const harness = makeLifecycleSocketHarness()
    const client = createSessionTransportClient({
      transport: wrapWebSocketLikeAsSessionTransport(harness.socket),
      sessionId: "session-1",
    })
    const states: SessionTransportConnectionState[] = []
    client.onConnectionState(() => {
      throw new Error("bad subscriber")
    })
    client.onConnectionState((state) => states.push(state))

    await client.connect()
    expect(states).toEqual([{ status: "connected" }])
  })

  test("no 'connected' after death — connect() on a dead transport must not lie", async () => {
    const harness = makeLifecycleSocketHarness()
    const client = createSessionTransportClient({
      transport: wrapWebSocketLikeAsSessionTransport(harness.socket),
      sessionId: "session-1",
    })
    const states: SessionTransportConnectionState[] = []
    client.onConnectionState((state) => states.push(state))

    harness.emitClose({ code: 1006 })
    expect(states).toHaveLength(1)
    expect(states[0]?.status).toBe("closed")

    await client.connect()
    expect(states).toHaveLength(1) // still just the terminal 'closed'
  })

  test("'connected' payload RESERVES resume ('replayed' | 'snapshot_fallback') but never sets it today (05 owns stamping — R2 F5)", async () => {
    // Type-level reservation: both literals are accepted by the payload type.
    const replayed: SessionTransportConnectionState = { status: "connected", resume: "replayed" }
    const fallback: SessionTransportConnectionState = {
      status: "connected",
      resume: "snapshot_fallback",
    }
    expect(replayed.status).toBe("connected")
    expect(fallback.status).toBe("connected")

    // Runtime honesty: the raw client NEVER stamps the reserved field itself.
    const harness = makeLifecycleSocketHarness()
    const client = createSessionTransportClient({
      transport: wrapWebSocketLikeAsSessionTransport(harness.socket),
      sessionId: "session-1",
    })
    const states: SessionTransportConnectionState[] = []
    client.onConnectionState((state) => states.push(state))
    await client.connect()

    expect(states[0]?.status).toBe("connected")
    expect(Object.hasOwn(states[0] as object, "resume")).toBe(false)
  })
})
