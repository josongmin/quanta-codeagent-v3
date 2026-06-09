import { describe, expect, it } from "vitest"
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  SessionClient,
  type WebSocketLike,
} from "./client"
import { SESSION_PROTOCOL_VERSION } from "./envelope"

/**
 * Minimal in-memory WebSocket stub — covers the surface SessionClient
 * actually touches. We expose `_simulateOpen` etc. on the instance so
 * tests can drive lifecycle deterministically.
 */
class FakeWebSocket implements WebSocketLike {
  readyState = 0 // CONNECTING
  sent: string[] = []
  closedWith: { code?: number | undefined; reason?: string | undefined } | null = null
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
  /** Fire (and consume) the first scheduled timer whose delay === `ms`. */
  runTimerOfMs: (ms: number) => void
  /** Whether any pending timer is scheduled for delay `ms`. */
  hasTimerOfMs: (ms: number) => boolean
}

const parseSentFrame = (raw: string): Record<string, unknown> =>
  JSON.parse(raw) as Record<string, unknown>

const expectConnectFrame = (raw: string | undefined, sessionId: string): void => {
  expect(raw).toBeDefined()
  const parsed = parseSentFrame(raw ?? "")
  expect(parsed).toMatchObject({
    version: SESSION_PROTOCOL_VERSION,
    kind: "connect",
    sessionId,
  })
}

const encodeRejectedFrame = (sessionId?: string): string =>
  JSON.stringify({
    version: SESSION_PROTOCOL_VERSION,
    kind: "rejected",
    target: "connect",
    reason: "protocol_validation",
    issue: "handshake_required",
    ...(sessionId === undefined ? {} : { sessionId }),
  })

const encodeSnapshotFrame = (sessionId: string): string =>
  JSON.stringify({
    version: SESSION_PROTOCOL_VERSION,
    kind: "snapshot",
    payload: {
      sessionId,
      revision: 1,
      seq: 0,
      state: {
        status: "idle",
        draftInput: "",
        permissionMode: "default",
        messageCount: 0,
      },
      capabilities: {
        approvals: "none",
        tools: true,
        memory: false,
        artifacts: false,
        subagents: false,
        automation: false,
        shellSnapshot: false,
        transport: "websocket",
      },
      pendingApproval: null,
      openArtifacts: [],
    },
  })

const encodeObservabilityFrame = (): string =>
  JSON.stringify({
    version: "observability.v1",
    kind: "observability",
    payload: {
      kind: "observability.snapshot",
      runs: [],
      objective: null,
      approvals: [],
      emittedAt: 123,
    },
  })

const encodeEventFrame = (seq: number): string =>
  JSON.stringify({
    version: SESSION_PROTOCOL_VERSION,
    kind: "event",
    payload: {
      eventId: `e-${seq}`,
      seq,
      revision: 1,
      emittedAt: "2026-05-26T00:00:00.000Z",
      type: "turn.completed",
      outcomeReason: "ok",
    },
  })

const encodeSnapshotFrameAtSeq = (sessionId: string, seq: number): string =>
  JSON.stringify({
    version: SESSION_PROTOCOL_VERSION,
    kind: "snapshot",
    payload: {
      sessionId,
      revision: 1,
      seq,
      state: {
        status: "idle",
        draftInput: "",
        permissionMode: "default",
        messageCount: 0,
      },
      capabilities: {
        approvals: "none",
        tools: true,
        memory: false,
        artifacts: false,
        subagents: false,
        automation: false,
        shellSnapshot: false,
        transport: "websocket",
      },
      pendingApproval: null,
      openArtifacts: [],
    },
  })

const parseConnectResumeFromSeq = (raw: string | undefined): number | undefined => {
  const parsed = parseSentFrame(raw ?? "")
  return typeof parsed.resumeFromSeq === "number" ? parsed.resumeFromSeq : undefined
}

const buildHarness = (): Harness => {
  const fakes: FakeWebSocket[] = []
  const timers: Array<{ cb: () => void; ms: number; handle: number }> = []
  let nextHandle = 1

  class TestWebSocket extends FakeWebSocket {
    constructor(url: string, protocols?: string | readonly string[]) {
      super(url, protocols)
      fakes.push(this)
    }
  }

  const client = new SessionClient({
    webSocketCtor: TestWebSocket as unknown as new (
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
    runTimerOfMs: (ms) => {
      const idx = timers.findIndex((t) => t.ms === ms)
      if (idx < 0) throw new Error(`no pending timer for ms=${ms}`)
      const [t] = timers.splice(idx, 1)
      t?.cb()
    },
    hasTimerOfMs: (ms) => timers.some((t) => t.ms === ms),
  }
}

/** Parse a sent frame and return its `kind` (or undefined if unparseable). */
const sentKind = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined
  try {
    return (JSON.parse(raw) as { kind?: string }).kind
  } catch {
    return undefined
  }
}

/** Drive a fresh client to the `connected` state (open → reject → snapshot). */
const connectToReady = (h: Harness): void => {
  h.client.connect({ url: "ws://localhost/x" })
  h.fakes[0]?._simulateOpen()
  h.fakes[0]?._simulateMessage(encodeRejectedFrame("srv-1"))
  h.fakes[0]?._simulateMessage(encodeSnapshotFrame("srv-1"))
}

describe("SessionClient", () => {
  it("constructs a WebSocket on connect() and sends the handshake connect frame on open", () => {
    const h = buildHarness()
    const states: string[] = []
    h.client.onConnectionChange((s) => states.push(s.kind))

    h.client.connect({ url: "ws://localhost/test" })
    expect(h.fakes).toHaveLength(1)
    expect(h.fakes[0]?.url).toBe("ws://localhost/test")

    h.fakes[0]?._simulateOpen()
    expect(states).toEqual(["closed", "connecting"])
    expectConnectFrame(h.fakes[0]?.sent[0], "ui-session")
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
    h.fakes[0]?._simulateMessage(encodeRejectedFrame("s1"))
    h.fakes[0]?._simulateMessage(encodeSnapshotFrame("s1"))

    h.client.send({
      sessionId: "s1",
      commandId: "c1",
      issuedAt: "2026-05-26T00:00:00.000Z",
      type: "turn.run",
    })

    expect(h.fakes[0]?.sent).toHaveLength(3)
    expectConnectFrame(h.fakes[0]?.sent[0], "ui-session")
    expectConnectFrame(h.fakes[0]?.sent[1], "s1")
    const sentRaw = h.fakes[0]?.sent[2] ?? ""
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

  it("learns the canonical sessionId from a rejected handshake reply and replays connect", () => {
    const h = buildHarness()
    const learnedIds: string[] = []

    h.client.onSessionId((sessionId) => learnedIds.push(sessionId))
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    h.fakes[0]?._simulateMessage(encodeRejectedFrame("srv-1"))

    expect(h.client.sessionId).toBe("srv-1")
    expect(learnedIds).toEqual(["srv-1"])
    expect(h.fakes[0]?.sent).toHaveLength(2)
    expectConnectFrame(h.fakes[0]?.sent[0], "ui-session")
    expectConnectFrame(h.fakes[0]?.sent[1], "srv-1")
  })

  it("transitions to connected only after the snapshot handshake completes", () => {
    const h = buildHarness()
    const states: string[] = []

    h.client.onConnectionChange((s) => states.push(s.kind))
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    h.fakes[0]?._simulateMessage(encodeRejectedFrame("srv-1"))
    h.fakes[0]?._simulateMessage(encodeSnapshotFrame("srv-1"))

    expect(states).toEqual(["closed", "connecting", "connected"])
    expect(h.client.state.kind).toBe("connected")
  })

  it("dispatches decoded snapshots to snapshot subscribers", () => {
    const h = buildHarness()
    const seen: string[] = []

    h.client.onSnapshot((snapshot) => {
      seen.push(snapshot.state.status)
    })
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    h.fakes[0]?._simulateMessage(encodeRejectedFrame("srv-1"))
    h.fakes[0]?._simulateMessage(encodeSnapshotFrame("srv-1"))

    expect(seen).toEqual(["idle"])
  })

  it("dispatches observability frames to observability subscribers", () => {
    const h = buildHarness()
    const seen: string[] = []

    h.client.onObservability((message) => {
      seen.push(message.kind)
    })
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    h.fakes[0]?._simulateMessage(encodeObservabilityFrame())

    expect(seen).toEqual(["observability.snapshot"])
  })

  it("replays the last observability frame to late subscribers", () => {
    const h = buildHarness()
    const seen: string[] = []

    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    h.fakes[0]?._simulateMessage(encodeObservabilityFrame())
    h.client.onObservability((message) => {
      seen.push(message.kind)
    })

    expect(seen).toEqual(["observability.snapshot"])
  })

  it("keeps the last observability snapshot across reconnects until a fresh frame arrives", () => {
    const h = buildHarness()
    const seen: string[] = []

    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    h.fakes[0]?._simulateMessage(encodeObservabilityFrame())
    h.fakes[0]?._simulateClose(1006, "abnormal")
    h.runNextTimer()
    h.fakes[1]?._simulateOpen()
    h.client.onObservability((message) => {
      seen.push(message.kind)
    })

    expect(seen).toEqual(["observability.snapshot"])
  })

  it("reuses the learned canonical sessionId on the next socket open after reconnect", () => {
    const h = buildHarness()

    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    h.fakes[0]?._simulateMessage(encodeRejectedFrame("srv-1"))
    h.fakes[0]?._simulateClose(1006, "abnormal")
    h.runNextTimer()

    expect(h.fakes).toHaveLength(2)
    h.fakes[1]?._simulateOpen()
    expectConnectFrame(h.fakes[1]?.sent[0], "srv-1")
  })

  it("ignores rejected frames that do not carry a canonical sessionId", () => {
    const h = buildHarness()
    const learnedIds: string[] = []

    h.client.onSessionId((sessionId) => learnedIds.push(sessionId))
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    h.fakes[0]?._simulateMessage(encodeRejectedFrame())

    expect(h.client.sessionId).toBeNull()
    expect(learnedIds).toEqual([])
    expect(h.fakes[0]?.sent).toHaveLength(1)
    expectConnectFrame(h.fakes[0]?.sent[0], "ui-session")
  })

  it("omits resumeFromSeq on the FIRST connect handshake (byte-identical to legacy)", () => {
    const h = buildHarness()
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    // No events have been seen — the bootstrap connect frame must NOT carry a
    // resumeFromSeq (omitted ⇒ daemon sends a full snapshot, same as today).
    expect(parseConnectResumeFromSeq(h.fakes[0]?.sent[0])).toBeUndefined()
  })

  it("tracks the highest seq seen across events and snapshots", () => {
    const h = buildHarness()
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    h.fakes[0]?._simulateMessage(encodeRejectedFrame("srv-1"))
    h.fakes[0]?._simulateMessage(encodeSnapshotFrameAtSeq("srv-1", 5))
    h.fakes[0]?._simulateMessage(encodeEventFrame(7))
    h.fakes[0]?._simulateMessage(encodeEventFrame(9))
    // An out-of-order lower seq must NOT lower the tracked high-water mark.
    h.fakes[0]?._simulateMessage(encodeEventFrame(8))

    expect(h.client.lastSeq).toBe(9)
  })

  it("re-sends connect{resumeFromSeq:lastSeq} on RECONNECT after events were seen", () => {
    const h = buildHarness()
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    h.fakes[0]?._simulateMessage(encodeRejectedFrame("srv-1"))
    h.fakes[0]?._simulateMessage(encodeSnapshotFrameAtSeq("srv-1", 5))
    h.fakes[0]?._simulateMessage(encodeEventFrame(7))
    h.fakes[0]?._simulateMessage(encodeEventFrame(9))

    // Drop the socket and let the reconnect timer fire.
    h.fakes[0]?._simulateClose(1006, "abnormal")
    h.runNextTimer()
    expect(h.fakes).toHaveLength(2)
    h.fakes[1]?._simulateOpen()

    // The reconnect handshake re-uses the canonical session id AND carries the
    // last-seen seq so the daemon replays only events seq>9.
    expectConnectFrame(h.fakes[1]?.sent[0], "srv-1")
    expect(parseConnectResumeFromSeq(h.fakes[1]?.sent[0])).toBe(9)
  })

  it("RESUME-STUCK: an observability frame during events-only resume settles to connected (not stuck in connecting)", () => {
    const h = buildHarness()
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    h.fakes[0]?._simulateMessage(encodeRejectedFrame("srv-1"))
    h.fakes[0]?._simulateMessage(encodeSnapshotFrameAtSeq("srv-1", 5)) // arm a resume cursor
    h.fakes[0]?._simulateMessage(encodeEventFrame(7))

    // Drop the socket and reconnect ⇒ a RESUME handshake (#resuming = true).
    h.fakes[0]?._simulateClose(1006, "abnormal")
    h.runNextTimer()
    h.fakes[1]?._simulateOpen()
    expect(h.client.state.kind).toBe("connecting")

    // The daemon replays an OBSERVABILITY frame BEFORE any event frame. This
    // still proves the resume handshake settled, so the client must flip to
    // `connected` (composer unfreezes) — not stay stuck in `connecting`.
    h.fakes[1]?._simulateMessage(encodeObservabilityFrame())
    expect(h.client.state.kind).toBe("connected")
  })

  it("resumes with resumeFromSeq:0 when the only seen seq is the bootstrap seq 0", () => {
    const h = buildHarness()
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    h.fakes[0]?._simulateMessage(encodeRejectedFrame("srv-1"))
    // The bootstrap snapshot lands at seq 0 — a REAL cursor, not "nothing seen".
    h.fakes[0]?._simulateMessage(encodeSnapshotFrameAtSeq("srv-1", 0))
    expect(h.client.lastSeq).toBe(0)

    // Reconnect: the resume gate is `lastSeq !== null`, NOT truthiness — so seq 0
    // must still be carried (dropping it would replay from scratch / double-render).
    h.fakes[0]?._simulateClose(1006, "abnormal")
    h.runNextTimer()
    h.fakes[1]?._simulateOpen()

    expectConnectFrame(h.fakes[1]?.sent[0], "srv-1")
    expect(parseConnectResumeFromSeq(h.fakes[1]?.sent[0])).toBe(0)
  })

  it("a low-seq snapshot does NOT lower the tracked high-water seq (monotonic resume cursor)", () => {
    const h = buildHarness()
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    h.fakes[0]?._simulateMessage(encodeRejectedFrame("srv-1"))
    // Events drive the cursor to 9.
    h.fakes[0]?._simulateMessage(encodeEventFrame(7))
    h.fakes[0]?._simulateMessage(encodeEventFrame(9))
    expect(h.client.lastSeq).toBe(9)

    // A late/stale SNAPSHOT carrying a LOWER seq (4) must not lower the cursor —
    // otherwise the next reconnect would resume from 4 and re-deliver 5..9.
    h.fakes[0]?._simulateMessage(encodeSnapshotFrameAtSeq("srv-1", 4))
    expect(h.client.lastSeq).toBe(9)
  })

  it("reconnect without any seen events omits resumeFromSeq (clean full snapshot)", () => {
    const h = buildHarness()
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    h.fakes[0]?._simulateMessage(encodeRejectedFrame("srv-1"))
    // Learned the session id but received no events/snapshots → no seq to resume.
    h.fakes[0]?._simulateClose(1006, "abnormal")
    h.runNextTimer()
    h.fakes[1]?._simulateOpen()

    expectConnectFrame(h.fakes[1]?.sent[0], "srv-1")
    expect(parseConnectResumeFromSeq(h.fakes[1]?.sent[0])).toBeUndefined()
  })

  it("reaches connected on a resume that replays EVENTS only (no snapshot)", () => {
    const h = buildHarness()
    // First connect: full handshake → snapshot drives `connected` and a seq.
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    h.fakes[0]?._simulateMessage(encodeRejectedFrame("srv-1"))
    h.fakes[0]?._simulateMessage(encodeSnapshotFrameAtSeq("srv-1", 5))
    h.fakes[0]?._simulateMessage(encodeEventFrame(7))
    expect(h.client.state.kind).toBe("connected")

    // Drop the socket; the reconnect handshake carries resumeFromSeq.
    h.fakes[0]?._simulateClose(1006, "abnormal")
    h.runNextTimer()
    expect(h.fakes).toHaveLength(2)
    h.fakes[1]?._simulateOpen()
    // After re-open the client is back in `connecting` (handshake pending).
    expect(h.client.state.kind).toBe("connecting")

    // The daemon replays MISSED EVENTS with NO snapshot (events-only resume).
    h.fakes[1]?._simulateMessage(encodeEventFrame(8))

    // The first resumed event proves the handshake settled → `connected`.
    // Without this the composer stays frozen and `send()` drops commands.
    expect(h.client.state.kind).toBe("connected")

    // And sending now actually puts a command on the wire (composer unfrozen).
    const beforeSend = h.fakes[1]?.sent.length ?? 0
    h.client.send({
      sessionId: "srv-1",
      commandId: "c-resume",
      issuedAt: "2026-05-26T00:00:00.000Z",
      type: "turn.run",
    })
    const after = h.fakes[1]?.sent ?? []
    expect(after.length).toBe(beforeSend + 1)
    expect(sentKind(after[after.length - 1])).toBe("command")
  })

  it("surfaces command rejections to rejection subscribers", () => {
    const h = buildHarness()
    const seen: string[] = []

    h.client.onRejected((frame) => {
      seen.push(`${frame.target}:${frame.reason}:${frame.issue ?? ""}`)
    })
    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    h.fakes[0]?._simulateMessage(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        kind: "rejected",
        target: "command",
        reason: "protocol_validation",
        issue: "session_id_mismatch",
        sessionId: "srv-1",
        commandId: "cmd-1",
      }),
    )

    expect(seen).toEqual(["command:protocol_validation:session_id_mismatch"])
  })

  /* ---------------- Heartbeat / keepalive ----------------------- */

  it("sends a heartbeat ping on the keepalive timer once connected", () => {
    const h = buildHarness()
    connectToReady(h)
    const beforePing = h.fakes[0]?.sent.length ?? 0

    // The keepalive timer fires — the client must put a heartbeat ping on the
    // wire to keep an idle socket warm past a proxy's idle timeout.
    h.runTimerOfMs(HEARTBEAT_INTERVAL_MS)

    const newest = h.fakes[0]?.sent.slice(beforePing) ?? []
    expect(newest.map(sentKind)).toContain("heartbeat")
    const ping = newest.find((raw) => sentKind(raw) === "heartbeat")
    expect((JSON.parse(ping ?? "{}") as { phase?: string }).phase).toBe("ping")
  })

  it("reconnects when no pong (or any frame) arrives within the liveness deadline", () => {
    const h = buildHarness()
    connectToReady(h)

    // Fire the ping → the client arms a liveness deadline.
    h.runTimerOfMs(HEARTBEAT_INTERVAL_MS)
    expect(h.hasTimerOfMs(HEARTBEAT_TIMEOUT_MS)).toBe(true)

    // No pong / no frame arrives before the deadline → the socket is dead.
    // Firing the deadline must drop the socket and schedule a reconnect.
    h.runTimerOfMs(HEARTBEAT_TIMEOUT_MS)
    expect(h.client.state.kind).toBe("disconnected")
    // The reconnect backoff timer is now scheduled (base 500ms).
    expect(h.hasTimerOfMs(500)).toBe(true)
  })

  it("a pong before the deadline keeps the socket alive AND is consumed (not mis-routed)", () => {
    const h = buildHarness()
    // Register the per-kind handlers a pong must NEVER reach: a heartbeat is
    // connection-level bookkeeping, its ONLY effect is the liveness reset.
    const events: string[] = []
    const snapshots: string[] = []
    const observability: string[] = []
    const canvas: string[] = []
    h.client.onAny((ev) => events.push(ev.type))
    h.client.onSnapshot((s) => snapshots.push(s.sessionId))
    h.client.onObservability((m) => observability.push(m.kind))
    h.client.onCanvas((m) => canvas.push(m.kind))
    connectToReady(h)
    // connectToReady delivers a snapshot → drain that expected fanout so the
    // post-pong assertions measure ONLY what the pong did.
    snapshots.length = 0
    h.runTimerOfMs(HEARTBEAT_INTERVAL_MS)
    expect(h.hasTimerOfMs(HEARTBEAT_TIMEOUT_MS)).toBe(true)

    // A pong arrives → liveness deadline is cleared, the socket stays connected.
    h.fakes[0]?._simulateMessage(
      JSON.stringify({ version: SESSION_PROTOCOL_VERSION, kind: "heartbeat", phase: "pong" }),
    )
    expect(h.hasTimerOfMs(HEARTBEAT_TIMEOUT_MS)).toBe(false)
    expect(h.client.state.kind).toBe("connected")
    // The pong was CONSUMED as bookkeeping — it must not fan out as an event,
    // snapshot, observability, or canvas message.
    expect(events).toEqual([])
    expect(snapshots).toEqual([])
    expect(observability).toEqual([])
    expect(canvas).toEqual([])
  })

  it("any inbound frame (not just a pong) resets the liveness deadline", () => {
    const h = buildHarness()
    connectToReady(h)
    h.runTimerOfMs(HEARTBEAT_INTERVAL_MS)
    expect(h.hasTimerOfMs(HEARTBEAT_TIMEOUT_MS)).toBe(true)

    // A normal event frame proves the socket is alive — the deadline clears.
    h.fakes[0]?._simulateMessage(encodeEventFrame(3))
    expect(h.hasTimerOfMs(HEARTBEAT_TIMEOUT_MS)).toBe(false)
    expect(h.client.state.kind).toBe("connected")
  })

  it("a binary (non-text) inbound frame resets the liveness deadline (ANY frame keeps alive)", () => {
    const h = buildHarness()
    connectToReady(h)
    // Fire the ping → arm the liveness deadline.
    h.runTimerOfMs(HEARTBEAT_INTERVAL_MS)
    expect(h.hasTimerOfMs(HEARTBEAT_TIMEOUT_MS)).toBe(true)

    // A binary frame (e.g. an ArrayBuffer the client can't decode) is STILL
    // proof the socket carries traffic — it must reset the deadline, not be
    // dropped before liveness is acknowledged. The invariant is "ANY inbound
    // frame keeps alive", binary or text.
    h.fakes[0]?._simulateMessage(new ArrayBuffer(8))
    expect(h.hasTimerOfMs(HEARTBEAT_TIMEOUT_MS)).toBe(false)
    expect(h.client.state.kind).toBe("connected")
  })

  /* ---------------- Canvas channel ------------------------------ */

  it("dispatches a decoded tool.diff canvas frame to onCanvas subscribers", () => {
    const h = buildHarness()
    const seen: string[] = []
    h.client.onCanvas((msg) => seen.push(msg.kind))
    connectToReady(h)

    h.fakes[0]?._simulateMessage(
      JSON.stringify({
        version: "canvas.v1",
        kind: "canvas",
        payload: {
          kind: "tool.diff",
          toolCallId: "tc-1",
          lines: [{ type: "added", content: "x", lineNumber: 1 }],
          additions: 1,
          deletions: 0,
          emittedAt: 1,
        },
      }),
    )

    expect(seen).toEqual(["tool.diff"])
  })

  it("dispatches a decoded context.usage canvas frame to onCanvas subscribers", () => {
    const h = buildHarness()
    const usageTotals: number[] = []
    h.client.onCanvas((msg) => {
      if (msg.kind === "context.usage") usageTotals.push(msg.total)
    })
    connectToReady(h)

    h.fakes[0]?._simulateMessage(
      JSON.stringify({
        version: "canvas.v1",
        kind: "canvas",
        payload: {
          kind: "context.usage",
          segments: [{ id: "system", tokens: 10 }],
          total: 10,
          max: 100,
          emittedAt: 2,
        },
      }),
    )

    expect(usageTotals).toEqual([10])
  })

  it("replays the last canvas frame to a late onCanvas subscriber", () => {
    const h = buildHarness()
    const seen: string[] = []

    h.client.connect({ url: "ws://localhost/x" })
    h.fakes[0]?._simulateOpen()
    // A canvas frame arrives BEFORE any subscriber is attached.
    h.fakes[0]?._simulateMessage(
      JSON.stringify({
        version: "canvas.v1",
        kind: "canvas",
        payload: {
          kind: "context.usage",
          segments: [{ id: "system", tokens: 10 }],
          total: 10,
          max: 100,
          emittedAt: 9,
        },
      }),
    )
    // A freshly-mounted panel subscribes late — it must render the last frame
    // immediately (mirrors onObservability replay), not wait for the next one.
    h.client.onCanvas((msg) => seen.push(msg.kind))

    expect(seen).toEqual(["context.usage"])
  })

  it("does NOT log a canvas frame as an unrecognised dropped frame", () => {
    const warnings: string[] = []
    const fakes: FakeWebSocket[] = []
    class TestWebSocket extends FakeWebSocket {
      constructor(url: string, protocols?: string | readonly string[]) {
        super(url, protocols)
        fakes.push(this)
      }
    }
    const client = new SessionClient({
      webSocketCtor: TestWebSocket as unknown as new (
        url: string,
        protocols?: string | readonly string[],
      ) => WebSocketLike,
      setTimer: () => 0,
      clearTimer: () => undefined,
      log: (level, msg) => {
        if (level === "warn") warnings.push(msg)
      },
    })
    client.connect({ url: "ws://localhost/x" })
    fakes[0]?._simulateOpen()
    fakes[0]?._simulateMessage(
      JSON.stringify({
        version: "canvas.v1",
        kind: "canvas",
        payload: { kind: "context.usage", segments: [], total: 1, max: 10, emittedAt: 1 },
      }),
    )

    expect(warnings.filter((w) => w.includes("unrecognised"))).toEqual([])
  })
})
