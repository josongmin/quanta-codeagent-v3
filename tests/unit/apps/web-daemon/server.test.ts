import { afterEach, describe, expect, test } from "bun:test"
import { main } from "@/apps/web-daemon"
import type { WebDaemonHandle } from "@/apps/web-daemon/types"
import type { SessionTransportMessage } from "@/ipc/session"
import { encodeSessionTransportMessage, tryDecodeSessionTransportMessage } from "@/ipc/session"
import { createStubRuntimeFactory } from "./fixture"

const handles: WebDaemonHandle[] = []

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop()
    if (h !== undefined) await h.stop().catch(() => undefined)
  }
})

const waitForOpen = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve()
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(new Error("ws error")), { once: true })
  })

const waitForMessage = (
  ws: WebSocket,
  predicate: (msg: SessionTransportMessage) => boolean,
  timeoutMs = 1500,
): Promise<SessionTransportMessage> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage)
      reject(new Error("waitForMessage: timed out"))
    }, timeoutMs)
    const onMessage = (event: MessageEvent): void => {
      if (typeof event.data !== "string") return
      const msg = tryDecodeSessionTransportMessage(event.data)
      if (msg === undefined) return
      if (!predicate(msg)) return
      clearTimeout(timer)
      ws.removeEventListener("message", onMessage)
      resolve(msg)
    }
    ws.addEventListener("message", onMessage)
  })

describe("web daemon end-to-end", () => {
  test("client connect handshake receives snapshot frame for the runtime session", async () => {
    const { factory, bag } = createStubRuntimeFactory()
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)

    // Wait one microtask so the server-side `open()` finishes wiring the
    // RuntimeSession before we issue the connect.
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(bag.sessionsCreated).toBe(1)

    // The stub session id is deterministic — see fixture.ts.
    const connect: SessionTransportMessage = {
      kind: "connect",
      sessionId: "stub-session-1",
    }
    ws.send(encodeSessionTransportMessage(connect))

    const snapshotMsg = await waitForMessage(ws, (m) => m.kind === "snapshot")
    expect(snapshotMsg.kind).toBe("snapshot")
    if (snapshotMsg.kind !== "snapshot") throw new Error("type narrow")
    expect(snapshotMsg.snapshot.sessionId).toBe("stub-session-1")
    expect(snapshotMsg.snapshot.revision).toBe(1)

    ws.close()
    // Give Bun's close callback a moment to fire so the eviction loop runs.
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  test("session id mismatch on connect is rejected (close+protocol_validation)", async () => {
    const { factory } = createStubRuntimeFactory()
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)
    await new Promise((resolve) => setTimeout(resolve, 25))

    const connect: SessionTransportMessage = {
      kind: "connect",
      sessionId: "wrong-session",
    }
    ws.send(encodeSessionTransportMessage(connect))

    const rejected = await waitForMessage(ws, (m) => m.kind === "rejected")
    if (rejected.kind !== "rejected") throw new Error("type narrow")
    expect(rejected.target).toBe("connect")
    expect(rejected.reason).toBe("session_id_mismatch")

    ws.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  test("/health reports the live session count and uptime", async () => {
    const { factory } = createStubRuntimeFactory()
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const r1 = await fetch(`http://127.0.0.1:${handle.port}/health`)
    const body1 = (await r1.json()) as { status: string; sessions: number; uptime_ms: number }
    expect(body1.sessions).toBe(0)

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)
    // Wait for server-side open() to finish.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const r2 = await fetch(`http://127.0.0.1:${handle.port}/health`)
    const body2 = (await r2.json()) as { status: string; sessions: number; uptime_ms: number }
    expect(body2.sessions).toBe(1)

    ws.close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const r3 = await fetch(`http://127.0.0.1:${handle.port}/health`)
    const body3 = (await r3.json()) as { status: string; sessions: number; uptime_ms: number }
    expect(body3.sessions).toBe(0)
  })

  test("handle.stop() closes the runtime and the per-session count goes back to 0", async () => {
    const { factory, bag } = createStubRuntimeFactory()
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)
    // Wait for server-side open() to finish wiring.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(bag.sessionsCreated).toBe(1)
    expect(handle.activeSessions()).toBe(1)

    await handle.stop()
    // Don't push to handles[] — already stopped.
    // Either path (server-close eviction OR closeAll()) MUST result in
    // exactly one session.close() — the registry guards against double-drop.
    expect(bag.sessionsClosed).toBe(1)
    expect(bag.runtimeClosed).toBe(true)
    expect(handle.activeSessions()).toBe(0)

    // Second stop is idempotent (no extra session.close, no throw).
    await handle.stop()
    expect(bag.sessionsClosed).toBe(1)
  })
})
