import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "@/apps/web-daemon"
import { HEARTBEAT_INTERVAL_MS, replyToHeartbeat } from "@/apps/web-daemon/server"
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
    expect(bag.attachTransportCalls).toBe(1)

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

  test("answers a client heartbeat ping with a heartbeat pong (keepalive)", async () => {
    const { factory } = createStubRuntimeFactory()
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)
    await new Promise((resolve) => setTimeout(resolve, 25))

    // A bare ping (no handshake needed — keepalive is connection-level, not
    // session-level) must come back as a pong so a live socket stays warm.
    ws.send(encodeSessionTransportMessage({ kind: "heartbeat", phase: "ping" }))

    const pong = await waitForMessage(ws, (m) => m.kind === "heartbeat")
    if (pong.kind !== "heartbeat") throw new Error("type narrow")
    expect(pong.phase).toBe("pong")

    ws.close()
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
    expect(rejected.sessionId).toBe("stub-session-1")
    expect(rejected.target).toBe("connect")
    expect(rejected.reason).toBe("session_id_mismatch")

    ws.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  test("empty-session bootstrap connect is rejected with the canonical session id", async () => {
    const { factory } = createStubRuntimeFactory()
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)
    await new Promise((resolve) => setTimeout(resolve, 25))

    const connect: SessionTransportMessage = {
      kind: "connect",
      sessionId: "",
    }
    ws.send(encodeSessionTransportMessage(connect))

    const rejected = await waitForMessage(
      ws,
      (m) => m.kind === "rejected" && m.target === "connect",
    )
    if (rejected.kind !== "rejected") throw new Error("type narrow")
    expect(rejected.sessionId).toBe("stub-session-1")
    expect(rejected.target).toBe("connect")
    expect(rejected.reason).toBe("session_id_mismatch")

    ws.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  test("back-to-back input.append + turn.run is serialized through the runtime transport", async () => {
    const { factory } = createStubRuntimeFactory()
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)
    await new Promise((resolve) => setTimeout(resolve, 25))

    ws.send(
      encodeSessionTransportMessage({
        kind: "connect",
        sessionId: "stub-session-1",
      }),
    )
    await waitForMessage(ws, (m) => m.kind === "snapshot")

    const issuedAt = new Date().toISOString()
    ws.send(
      encodeSessionTransportMessage({
        kind: "command",
        command: {
          sessionId: "stub-session-1",
          commandId: "cmd-append",
          issuedAt,
          type: "input.append",
          text: "hello",
        },
      }),
    )
    ws.send(
      encodeSessionTransportMessage({
        kind: "command",
        command: {
          sessionId: "stub-session-1",
          commandId: "cmd-run",
          issuedAt,
          type: "turn.run",
        },
      }),
    )

    const started = await waitForMessage(
      ws,
      (m) => m.kind === "event" && m.event.type === "turn.started",
      2000,
    )
    expect(started.kind).toBe("event")
    if (started.kind !== "event") throw new Error("type narrow")
    expect(started.event.type).toBe("turn.started")
    if (started.event.type !== "turn.started") throw new Error("type narrow")
    expect(started.event.prompt).toBe("hello")

    ws.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  test("turn.run streams assistant delta events before completion", async () => {
    const { factory } = createStubRuntimeFactory()
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)
    await new Promise((resolve) => setTimeout(resolve, 25))

    ws.send(
      encodeSessionTransportMessage({
        kind: "connect",
        sessionId: "stub-session-1",
      }),
    )
    await waitForMessage(ws, (m) => m.kind === "snapshot")

    const issuedAt = new Date().toISOString()
    ws.send(
      encodeSessionTransportMessage({
        kind: "command",
        command: {
          sessionId: "stub-session-1",
          commandId: "cmd-append",
          issuedAt,
          type: "input.append",
          text: "hello",
        },
      }),
    )
    ws.send(
      encodeSessionTransportMessage({
        kind: "command",
        command: {
          sessionId: "stub-session-1",
          commandId: "cmd-run",
          issuedAt,
          type: "turn.run",
        },
      }),
    )

    const delta = await waitForMessage(
      ws,
      (m) => m.kind === "event" && m.event.type === "turn.output.delta",
      2000,
    )
    if (delta.kind !== "event" || delta.event.type !== "turn.output.delta") {
      throw new Error("type narrow")
    }
    expect(delta.event.delta.length).toBeGreaterThan(0)

    const completed = await waitForMessage(
      ws,
      (m) => m.kind === "event" && m.event.type === "turn.completed",
      2000,
    )
    if (completed.kind !== "event" || completed.event.type !== "turn.completed") {
      throw new Error("type narrow")
    }
    expect(completed.event.assistantText).toBe("stub: hello")

    const finalState = await waitForMessage(
      ws,
      (m) =>
        m.kind === "event" &&
        m.event.type === "session.state.updated" &&
        m.event.state.status === "idle" &&
        m.event.state.lastAssistantText === "stub: hello",
      2000,
    )
    if (finalState.kind !== "event" || finalState.event.type !== "session.state.updated") {
      throw new Error("type narrow")
    }
    expect(finalState.event.state.streamingAssistantText).toBeUndefined()

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

  test("/threads + /threads/:id/events expose persisted threads for transcript hydration", async () => {
    // Isolate the SQLite file to a tmp dir so the test doesn't read/write the
    // user's real `~/.quanta/web-daemon/threads.db`.
    const tmpDbDir = mkdtempSync(join(tmpdir(), "quanta-web-db-"))
    const prevDir = process.env.QUANTA_WEB_DB_DIR
    process.env.QUANTA_WEB_DB_DIR = tmpDbDir
    try {
      const { factory } = createStubRuntimeFactory()
      const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
      handles.push(handle)

      const r1 = await fetch(`http://127.0.0.1:${handle.port}/threads`)
      expect(r1.status).toBe(200)
      const body1 = (await r1.json()) as {
        threads: Array<{ id: string; eventCount: number }>
      }
      expect(body1.threads.length).toBeGreaterThanOrEqual(1)
      expect(body1.threads.some((t) => t.id === "stub-session-1")).toBe(true)

      const eventsUrl = `http://127.0.0.1:${handle.port}/threads/${encodeURIComponent("stub-session-1")}/events`
      const r2 = await fetch(eventsUrl)
      expect(r2.status).toBe(200)
      const body2 = (await r2.json()) as { threadId: string; events: unknown[] }
      expect(body2.threadId).toBe("stub-session-1")
      expect(Array.isArray(body2.events)).toBe(true)

      // Unknown thread id returns 200 + empty list (the store is forgiving;
      // the client treats no-events as nothing-to-replay).
      const r3 = await fetch(`http://127.0.0.1:${handle.port}/threads/no-such-thread/events`)
      expect(r3.status).toBe(200)
      const body3 = (await r3.json()) as { events: unknown[] }
      expect(body3.events).toEqual([])
    } finally {
      if (prevDir === undefined) {
        delete process.env.QUANTA_WEB_DB_DIR
      } else {
        process.env.QUANTA_WEB_DB_DIR = prevDir
      }
      rmSync(tmpDbDir, { recursive: true, force: true })
    }
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

  test("daemon attaches transports with a bounded replayWindow (reconnect-replay bound)", async () => {
    const { factory, bag } = createStubRuntimeFactory()
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)
    await new Promise((resolve) => setTimeout(resolve, 25))

    // The daemon must pass an explicit, bounded replayWindow so a reconnecting
    // client's resume replay is capped (no unbounded history) and resumes older
    // than the window fall back to a full snapshot. Pin the EXACT documented
    // bound (`WEB_DAEMON_REPLAY_WINDOW = 128`) so a drift in either direction is
    // caught — a bare `>0` lets the contract silently change.
    expect(bag.attachTransportCalls).toBe(1)
    expect(bag.lastAttachReplayWindow).toBe(128)

    ws.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  test("reconnect caught-up to the live seq replays NOTHING (no snapshot, no events)", async () => {
    const { factory } = createStubRuntimeFactory()
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    // First client: connect, then advance the session seq via input.append so
    // the live snapshot moves to seq 1.
    const wsA = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(wsA)
    await new Promise((resolve) => setTimeout(resolve, 25))
    wsA.send(encodeSessionTransportMessage({ kind: "connect", sessionId: "stub-session-1" }))
    await waitForMessage(wsA, (m) => m.kind === "snapshot")

    wsA.send(
      encodeSessionTransportMessage({
        kind: "command",
        command: {
          sessionId: "stub-session-1",
          commandId: "cmd-append",
          issuedAt: new Date().toISOString(),
          type: "input.append",
          text: "hello",
        },
      }),
    )
    const appended = await waitForMessage(
      wsA,
      (m) => m.kind === "event" && m.event.type === "session.state.updated",
      2000,
    )
    if (appended.kind !== "event") throw new Error("type narrow")
    const liveSeq = appended.event.seq // 1 — the live high-water mark

    // Reconnecting transport that already saw everything up to `liveSeq`: it
    // must receive NEITHER a snapshot NOR any replayed events (nothing missed).
    const wsB = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(wsB)
    await new Promise((resolve) => setTimeout(resolve, 25))

    const framesB: SessionTransportMessage[] = []
    wsB.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return
      const m = tryDecodeSessionTransportMessage(event.data)
      if (m !== undefined) framesB.push(m)
    })

    wsB.send(
      encodeSessionTransportMessage({
        kind: "connect",
        sessionId: "stub-session-1",
        resumeFromSeq: liveSeq,
      }),
    )
    // Let any replay settle (there should be none).
    await new Promise((resolve) => setTimeout(resolve, 75))

    expect(framesB.some((m) => m.kind === "snapshot")).toBe(false)
    expect(framesB.filter((m) => m.kind === "event")).toHaveLength(0)

    wsA.close()
    wsB.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  test("reconnect with resumeFromSeq BEHIND the live snapshot falls back to a full snapshot", async () => {
    const { factory } = createStubRuntimeFactory()
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    // Advance the live snapshot to seq 1 via an append on the first client.
    const wsA = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(wsA)
    await new Promise((resolve) => setTimeout(resolve, 25))
    wsA.send(encodeSessionTransportMessage({ kind: "connect", sessionId: "stub-session-1" }))
    await waitForMessage(wsA, (m) => m.kind === "snapshot")
    wsA.send(
      encodeSessionTransportMessage({
        kind: "command",
        command: {
          sessionId: "stub-session-1",
          commandId: "cmd-append",
          issuedAt: new Date().toISOString(),
          type: "input.append",
          text: "hello",
        },
      }),
    )
    await waitForMessage(
      wsA,
      (m) => m.kind === "event" && m.event.type === "session.state.updated",
      2000,
    )

    // Reconnect from seq 0 — older than the live snapshot (seq 1). The bridge's
    // planSessionReplay fallback must send a fresh full snapshot so the client
    // resets cleanly rather than missing the gap.
    const wsB = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(wsB)
    await new Promise((resolve) => setTimeout(resolve, 25))
    wsB.send(
      encodeSessionTransportMessage({
        kind: "connect",
        sessionId: "stub-session-1",
        resumeFromSeq: 0,
      }),
    )
    const snapB = await waitForMessage(wsB, (m) => m.kind === "snapshot", 2000)
    if (snapB.kind !== "snapshot") throw new Error("type narrow")
    expect(snapB.snapshot.sessionId).toBe("stub-session-1")
    // The fallback snapshot reflects the live seq, not the stale resume cursor.
    expect(snapB.snapshot.seq).toBeGreaterThanOrEqual(1)

    wsA.close()
    wsB.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  test("reconnect WITHOUT resumeFromSeq receives a full snapshot (byte-identical legacy path)", async () => {
    const { factory } = createStubRuntimeFactory()
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)
    await new Promise((resolve) => setTimeout(resolve, 25))

    ws.send(encodeSessionTransportMessage({ kind: "connect", sessionId: "stub-session-1" }))
    const snapshotMsg = await waitForMessage(ws, (m) => m.kind === "snapshot")
    expect(snapshotMsg.kind).toBe("snapshot")

    ws.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
})

describe("replyToHeartbeat (pure heartbeat short-circuit)", () => {
  // Finding #5a — give the heartbeat try/catch direct teeth. The e2e pong test
  // above stays green even if the try/catch is removed, so the NO-THROW guard
  // is unprotected. Inject a throwing `ws` and assert the helper still consumes
  // the ping (returns true) WITHOUT propagating the send failure.
  test("a ping is consumed (returns true) and NO-THROW even when ws.send throws", () => {
    const ws = {
      send: () => {
        throw new Error("socket closing")
      },
    }
    let consumed: boolean | undefined
    expect(() => {
      consumed = replyToHeartbeat(ws, { kind: "heartbeat", phase: "ping" })
    }).not.toThrow()
    expect(consumed).toBe(true)
  })

  test("a ping is answered with exactly one pong frame on a healthy socket", () => {
    const sent: string[] = []
    const ws = {
      send: (data: string | Uint8Array) => {
        sent.push(typeof data === "string" ? data : new TextDecoder().decode(data))
      },
    }
    expect(replyToHeartbeat(ws, { kind: "heartbeat", phase: "ping" })).toBe(true)
    expect(sent).toHaveLength(1)
    const decoded = tryDecodeSessionTransportMessage(sent[0] ?? "")
    expect(decoded).toEqual({ kind: "heartbeat", phase: "pong" })
  })

  test("a pong is terminal — consumed (returns true) with NO reply", () => {
    const sent: string[] = []
    const ws = { send: (d: string | Uint8Array) => void sent.push(String(d)) }
    // Our own reply / a peer pong must not be echoed back (no ping-pong loop).
    expect(replyToHeartbeat(ws, { kind: "heartbeat", phase: "pong" })).toBe(true)
    expect(sent).toHaveLength(0)
  })

  test("a non-heartbeat frame is NOT consumed (returns false → falls through to the bridge)", () => {
    const sent: string[] = []
    const ws = { send: (d: string | Uint8Array) => void sent.push(String(d)) }
    expect(replyToHeartbeat(ws, { kind: "connect", sessionId: "s" })).toBe(false)
    expect(replyToHeartbeat(ws, undefined)).toBe(false)
    expect(sent).toHaveLength(0)
  })
})

describe("HEARTBEAT_INTERVAL_MS contract", () => {
  // Finding #5b — the daemon's keepalive interval is hand-duplicated with the
  // frontend literal (apps/web-frontend/src/ws/client.ts) and never asserted
  // equal. Pin the documented value here so a drift in the daemon const is
  // caught. NOTE: the frontend mirror MUST equal this same 25000; a shared
  // const is not feasible without crossing the bun/vite build boundary
  // (server.ts pulls in `bun`/node:os/SQLite the Vite bundle can't load), so
  // the contract is pinned on each side against the documented literal.
  test("equals the documented 25000 keepalive interval", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(25_000)
  })
})
