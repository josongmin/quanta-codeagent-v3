/**
 * S5b hellgate — version-skew lenient reject (jul-16 SDK ticket 01).
 *
 * PRE-EXISTING SILENT BUG (MASTER-PLAN §0): a frame whose `version` field does
 * not match SESSION_PROTOCOL_VERSION failed `tryDecodeSessionTransportMessage`
 * and was dropped on the floor by BOTH shared transports (stdio + websocket) —
 * every old/new peer combination degenerated to an unexplained hang.
 *
 *   RED (pre-fix):  a skewed `connect`/`command` frame produces NO reply; a
 *     foreign-version `rejected` frame is never delivered to handlers.
 *   GREEN (post-fix):
 *     server side — the receiving transport answers with a `rejected` frame
 *       whose envelope `version` ECHOES the peer's claimed version (stamping
 *       our own version would be self-defeating: the skewed peer's own
 *       `requireProtocolVersion` gate — codec.ts — would drop the reply, the
 *       exact hole we are closing) + reason `protocol_validation` (closed-4,
 *       old-decodable) + issue `bad_version`.
 *     client side — a `rejected` frame (ONLY that kind) is decoded leniently
 *       (version-exempt) and surfaced as a typed SessionProtocolVersionError.
 *
 * HONEST RESCUE POPULATION: peers shipped BEFORE this change have neither the
 * reply logic (old server → new client stays silent) nor the lenient decoder
 * (an old client can only read the reply thanks to the version echo + the
 * closed-4 reason reuse — and only when its frame carried a non-empty
 * sessionId). The lenient/typed surfacing applies from THIS build onward.
 *
 * red-on-injection: stamping the reply with SESSION_PROTOCOL_VERSION instead
 * of the echo turns the "old client can decode the reply" simulation red.
 */
import { describe, expect, test } from "bun:test"
import {
  createSessionStdioTransport,
  createSessionTransportClient,
  type SessionTransport,
  type SessionTransportHandler,
  type SessionTransportMessage,
  wrapWebSocketLikeAsSessionTransport,
} from "@/ipc/session"
import { SESSION_PROTOCOL_VERSION } from "@/protocol/session"

const OLD_VERSION = "session.v0-old"

/** stdio harness: raw line in via `push`, raw frames out via `written`. */
const makeStdioHarness = () => {
  let dataHandler: ((chunk: Buffer | string) => void) | undefined
  const written: string[] = []
  const transport = createSessionStdioTransport({
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
        written.push(chunk)
        return true
      },
    },
  })
  return {
    transport,
    written,
    push(line: string) {
      dataHandler?.(`${line}\n`)
    },
  }
}

/** websocket harness: raw string in via `emit`, raw frames out via `sent`. */
const makeSocketHarness = () => {
  const listeners = new Set<(event: { data: unknown }) => void>()
  const sent: string[] = []
  const socket = {
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
  }
  return {
    transport: wrapWebSocketLikeAsSessionTransport(socket),
    sent,
    emit(data: string) {
      for (const handler of [...listeners]) handler({ data })
    },
  }
}

const collect = (transport: SessionTransport): SessionTransportMessage[] => {
  const seen: SessionTransportMessage[] = []
  transport.onMessage(((message) => {
    seen.push(message)
  }) as SessionTransportHandler)
  return seen
}

/**
 * Simulation of the ALREADY-SHIPPED client's rejected-frame decode gate
 * (`decodeRejectedMessage`, codec.ts) parameterized by the version that client
 * was built with: version equality (`requireProtocolVersion`), the CLOSED-4
 * reason set, and a NON-EMPTY string sessionId. A reply readable by this
 * function is readable by a real old client — the load-bearing assertions of
 * the echo design ride on it.
 */
const oldClientCanDecodeRejected = (raw: string, oldClientVersion: string): boolean => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false
  const envelope = parsed as Record<string, unknown>
  if (envelope.kind !== "rejected") return false
  // The old peer's `requireProtocolVersion` — accepts ONLY its own version.
  if (envelope.version !== oldClientVersion) return false
  if (typeof envelope.sessionId !== "string" || envelope.sessionId.length === 0) return false
  if (envelope.target !== "connect" && envelope.target !== "command") return false
  return (
    envelope.reason === "duplicate_command" ||
    envelope.reason === "protocol_validation" ||
    envelope.reason === "revision_conflict" ||
    envelope.reason === "session_id_mismatch"
  )
}

const skewedConnectFrame = (sessionId = "session-1"): string =>
  JSON.stringify({ version: OLD_VERSION, kind: "connect", sessionId })

const skewedCommandFrame = (commandId = "cmd-old-1", sessionId = "session-1"): string =>
  JSON.stringify({
    version: OLD_VERSION,
    kind: "command",
    payload: {
      sessionId,
      commandId,
      issuedAt: "2026-07-16T00:00:00.000Z",
      type: "turn.run",
    },
  })

describe("S5b / server side: skewed frames get a version-echo rejected reply", () => {
  test("stdio: a version-skewed CONNECT frame is answered with rejected(bad_version), not silently dropped", () => {
    const h = makeStdioHarness()
    const seen = collect(h.transport)

    h.push(skewedConnectFrame())

    // Not delivered as a message (it is undecodable for us)…
    expect(seen).toEqual([])
    // …but no longer silent: exactly one reply frame went back.
    expect(h.written).toHaveLength(1)
    const reply = JSON.parse(h.written[0] ?? "{}")
    expect(reply.kind).toBe("rejected")
    expect(reply.target).toBe("connect")
    expect(reply.reason).toBe("protocol_validation")
    expect(reply.issue).toBe("bad_version")
    expect(reply.sessionId).toBe("session-1")
    // THE ECHO — the reply speaks the PEER'S claimed version, not ours.
    expect(reply.version).toBe(OLD_VERSION)
    expect(reply.version).not.toBe(SESSION_PROTOCOL_VERSION)
  })

  test("websocket: a version-skewed COMMAND frame is answered with rejected carrying the commandId", () => {
    const h = makeSocketHarness()
    const seen = collect(h.transport)

    h.emit(skewedCommandFrame("cmd-old-42"))

    expect(seen).toEqual([])
    expect(h.sent).toHaveLength(1)
    const reply = JSON.parse(h.sent[0] ?? "{}")
    expect(reply).toEqual({
      version: OLD_VERSION,
      kind: "rejected",
      sessionId: "session-1",
      target: "command",
      reason: "protocol_validation",
      issue: "bad_version",
      commandId: "cmd-old-42",
    })
  })

  test("ALREADY-SHIPPED old client CAN decode the reply — version echo + closed-4 reason (red-on-injection: stamp our version and this dies)", () => {
    const h = makeStdioHarness()
    h.push(skewedCommandFrame())
    expect(h.written).toHaveLength(1)
    const raw = h.written[0]?.trimEnd() ?? ""
    // The old peer's own decode gate accepts the reply…
    expect(oldClientCanDecodeRejected(raw, OLD_VERSION)).toBe(true)
    // …and would NOT accept a reply stamped with OUR version (the paired
    // control that makes the echo load-bearing rather than incidental).
    expect(
      oldClientCanDecodeRejected(raw.replace(OLD_VERSION, SESSION_PROTOCOL_VERSION), OLD_VERSION),
    ).toBe(false)
  })

  test("loop guard: a version-skewed REJECTED frame gets NO reply (no reject ping-pong)", () => {
    const h = makeStdioHarness()
    h.push(
      JSON.stringify({
        version: OLD_VERSION,
        kind: "rejected",
        sessionId: "session-1",
        target: "command",
        reason: "protocol_validation",
        issue: "bad_version",
      }),
    )
    expect(h.written).toHaveLength(0)
  })

  test("unaddressable / non-client-initiated skewed kinds get NO reply (heartbeat, event, snapshot)", () => {
    const h = makeStdioHarness()
    h.push(JSON.stringify({ version: OLD_VERSION, kind: "heartbeat", phase: "ping" }))
    h.push(JSON.stringify({ version: OLD_VERSION, kind: "event", payload: { seq: 1 } }))
    h.push(JSON.stringify({ version: OLD_VERSION, kind: "snapshot", payload: { seq: 1 } }))
    expect(h.written).toHaveLength(0)
  })

  test("SELF-AUDIT: discovery-sentinel skew (EMPTY sessionId) — reply still sent; lenient client reads it, strict old decoder refuses (honest rescue boundary)", () => {
    // An old attach-style client may claim an EMPTY sessionId on its bootstrap
    // connect. The echo reply must still go out (a NEW lenient client decodes
    // it — empty sessionId tolerated in lenient mode), while the ALREADY-
    // SHIPPED strict decoder refuses an empty sessionId — that boundary is the
    // documented, deliberate limit of the rescue population.
    const server = makeStdioHarness()
    server.push(skewedConnectFrame(""))
    expect(server.written).toHaveLength(1)
    const raw = server.written[0]?.trimEnd() ?? ""
    expect(JSON.parse(raw).sessionId).toBe("")
    expect(JSON.parse(raw).version).toBe(OLD_VERSION)
    // Old strict decoder: refuses (empty sessionId) — rescue boundary.
    expect(oldClientCanDecodeRejected(raw, OLD_VERSION)).toBe(false)
    // New lenient client: delivered.
    const clientSide = makeStdioHarness()
    const seen = collect(clientSide.transport)
    clientSide.push(raw)
    expect(seen).toEqual([
      {
        kind: "rejected",
        sessionId: "",
        target: "connect",
        reason: "protocol_validation",
        issue: "bad_version",
      },
    ])
  })

  test("SELF-AUDIT: the transport is NOT wedged by a skew reply — valid frames keep flowing afterward", () => {
    const h = makeStdioHarness()
    const seen = collect(h.transport)
    h.push(skewedCommandFrame("cmd-skew"))
    expect(h.written).toHaveLength(1)
    // A valid, same-version frame right after the reply still decodes + delivers.
    h.push(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        kind: "heartbeat",
        phase: "ping",
      }),
    )
    expect(seen).toEqual([{ kind: "heartbeat", phase: "ping" }])
    // And no spurious extra replies were emitted for the valid frame.
    expect(h.written).toHaveLength(1)
  })

  test("plain garbage stays silently dropped (unchanged): bad JSON / unknown kind / missing version", () => {
    const h = makeStdioHarness()
    const seen = collect(h.transport)
    h.push("this is not json")
    h.push(JSON.stringify({ version: SESSION_PROTOCOL_VERSION, kind: "nonsense" }))
    // No version field at all — there is no claimed version to echo; honest drop.
    h.push(JSON.stringify({ kind: "connect", sessionId: "session-1" }))
    expect(seen).toEqual([])
    expect(h.written).toHaveLength(0)
  })
})

describe("S5b / client side: lenient rejected decode + typed error", () => {
  test("a FOREIGN-version rejected frame is delivered to handlers (version-exempt decode, rejected-only)", () => {
    // The skew reply arrives stamped with the version WE claimed — which for a
    // future/foreign server reply may not equal ours. rejected frames must not
    // be dropped for version alone; every other kind still is (previous test).
    const h = makeSocketHarness()
    const seen = collect(h.transport)
    h.emit(
      JSON.stringify({
        version: "session.v9-future",
        kind: "rejected",
        sessionId: "session-1",
        target: "command",
        reason: "protocol_validation",
        issue: "bad_version",
        commandId: "cmd-9",
      }),
    )
    expect(seen).toEqual([
      {
        kind: "rejected",
        sessionId: "session-1",
        target: "command",
        reason: "protocol_validation",
        issue: "bad_version",
        commandId: "cmd-9",
      },
    ])
  })

  test("wire ROUNDTRIP over one stdio pair: skewed command out → echo reject back → typed SessionProtocolVersionError surfaced", async () => {
    // Full loop on the REAL codec path: a (simulated old) peer writes a skewed
    // command into the server transport; the server's echo reply is fed back
    // into a NEW client transport, whose transport-client surfaces the typed
    // error. This is the "lenient client ↔ new server" acceptance roundtrip.
    const server = makeStdioHarness()
    server.push(skewedCommandFrame("cmd-rt-1"))
    expect(server.written).toHaveLength(1)
    const replyLine = server.written[0] ?? ""

    const clientSide = makeStdioHarness()
    const typed: unknown[] = []
    const rejectedMessages: SessionTransportMessage[] = []
    const client = createSessionTransportClient({
      transport: clientSide.transport,
      sessionId: "session-1",
      onRejected: ({ message, error }) => {
        rejectedMessages.push(message)
        typed.push(error)
      },
    })
    clientSide.push(replyLine.trimEnd())

    expect(rejectedMessages).toHaveLength(1)
    expect(typed).toHaveLength(1)
    const error = typed[0] as Error & { commandId?: string }
    expect(error.name).toBe("SessionProtocolVersionError")
    expect(error.commandId).toBe("cmd-rt-1")
    await client.close()
  })

  test("NEW client ↔ NEW server control: a same-version rejected frame does NOT surface a version error", async () => {
    const h = makeSocketHarness()
    const typed: Error[] = []
    const client = createSessionTransportClient({
      transport: h.transport,
      sessionId: "session-1",
      onRejected: ({ error }) => {
        typed.push(error)
      },
    })
    h.emit(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        kind: "rejected",
        sessionId: "session-1",
        target: "command",
        reason: "duplicate_command",
        commandId: "dup-1",
      }),
    )
    expect(typed).toHaveLength(1)
    expect(typed[0]?.name).toBe("SessionDuplicateCommandError")
    await client.close()
  })
})
