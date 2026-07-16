/**
 * RED-first orchestration coverage for `attachToDaemon` (jun-09 adversarial
 * audit). The pure units (handshake / render / command builders) live in
 * `attach-pure.test.ts`; the e2e against a real daemon lives in
 * `attach-e2e.test.ts`. THIS file drives the socket/stdin ORCHESTRATION with a
 * fully in-memory fake `AttachSocket` so it can deterministically fire
 * `open` / `message` / `close` / `error` and assert lifecycle invariants that
 * the e2e can't easily provoke (daemon-initiated close, dead-socket sends, a
 * throwing approval prompter, the token-in-URL).
 *
 * Findings covered:
 *  #1 daemon-initiated socket close resolves `done` + stops the read loop
 *  #2 `session.closed` SessionEvent shuts the client down
 *  #3 post-handshake send failure surfaces (not silently swallowed)
 *  #5 approval-respond orchestration fail-safes to DENY (garbage AND throw)
 *  #6 token-in-URL is properly percent-encoded; no token ⇒ no `?token=`
 */

import { describe, expect, test } from "bun:test"
import { type AttachSocket, type AttachSocketCtor, attachToDaemon } from "@/apps/cli/attach"
import {
  encodeSessionTransportMessage,
  type SessionTransportMessage,
  tryDecodeSessionTransportMessage,
} from "@/ipc/session"
import type { SessionEvent } from "@/protocol/session"

/** Listener buckets the fake socket dispatches to. */
type Listeners = {
  message: Array<(event: { data: unknown }) => void>
  open: Array<() => void>
  close: Array<() => void>
  error: Array<() => void>
}

interface FakeSocket extends AttachSocket {
  /** Captured outbound frames (decoded back to transport messages). */
  readonly sent: SessionTransportMessage[]
  /** Drive an inbound frame (as the daemon would). */
  deliver(message: SessionTransportMessage): void
  /** Fire the lifecycle events the daemon/runtime triggers. */
  fireOpen(): void
  fireClose(): void
  fireError(): void
  /** Force the next (and subsequent) `send` calls to throw (dead socket). */
  killSendWith(err: Error): void
}

const makeFakeSocket = (opts?: { readyState?: number }): FakeSocket => {
  const listeners: Listeners = { message: [], open: [], close: [], error: [] }
  const sent: SessionTransportMessage[] = []
  let sendError: Error | undefined
  let readyState = opts?.readyState ?? 0 // CONNECTING by default

  const socket: FakeSocket = {
    get readyState() {
      return readyState
    },
    send(data: string) {
      if (sendError !== undefined) throw sendError
      // Decode the wire frame back so assertions read the structured message
      // (the transport encodes via `encodeSessionTransportMessage`, so we must
      // reverse with the matching decoder — a raw JSON.parse sees the envelope).
      const msg = tryDecodeSessionTransportMessage(data)
      if (msg !== undefined) sent.push(msg)
    },
    close() {
      readyState = 3 // CLOSED
    },
    addEventListener(type: "message" | "open" | "close" | "error", handler: never) {
      ;(listeners[type] as unknown[]).push(handler)
    },
    removeEventListener(type, handler) {
      const bucket = listeners[type]
      const idx = bucket.indexOf(handler as never)
      if (idx >= 0) bucket.splice(idx, 1)
    },
    sent,
    deliver(message) {
      const data = encodeSessionTransportMessage(message)
      for (const h of [...listeners.message]) h({ data })
    },
    fireOpen() {
      readyState = 1 // OPEN
      for (const h of [...listeners.open]) h()
    },
    fireClose() {
      readyState = 3
      for (const h of [...listeners.close]) h()
    },
    fireError() {
      for (const h of [...listeners.error]) h()
    },
    killSendWith(err) {
      sendError = err
      readyState = 3
    },
  }
  return socket
}

/** A snapshot transport message that settles the handshake to READY for `sid`. */
const snapshotMsg = (sid: string, seq = 1): SessionTransportMessage => ({
  kind: "snapshot",
  snapshot: {
    sessionId: sid,
    revision: 1,
    seq,
    state: { status: "idle", draftInput: "", permissionMode: "default", messageCount: 0 },
    capabilities: {
      approvals: "none",
      tools: false,
      memory: false,
      artifacts: false,
      subagents: false,
      automation: false,
      shellSnapshot: false,
      serverAutoContinues: false,
      transport: "websocket",
    },
    pendingApproval: null,
    openArtifacts: [],
  },
})

const eventMsg = (event: SessionEvent): SessionTransportMessage => ({ kind: "event", event })

/** A stdin that never yields (parks the read loop) until explicitly returned. */
const parkedStdin = (): { stdin: AsyncIterable<string>; release: () => void } => {
  let release: () => void = () => undefined
  const stdin = (async function* () {
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })()
  return { stdin, release: () => release() }
}

const flush = async (): Promise<void> => {
  // Let microtasks + the handshake's 10ms poll tick settle.
  await new Promise((resolve) => setTimeout(resolve, 30))
}

/** Drive `attachToDaemon` with a fake socket to the READY state for `sid`. */
const attachReady = async (
  sid: string,
  overrides: {
    promptApproval?: (reason: string) => Promise<string>
    stdin?: AsyncIterable<string>
    write?: (chunk: string) => void
  } = {},
): Promise<{
  socket: FakeSocket
  session: Awaited<ReturnType<typeof attachToDaemon>>
  rendered: string[]
}> => {
  const socket = makeFakeSocket()
  // A real `function` (not an arrow) so `new Ctor(url)` works; returning an
  // object from a constructor makes that object the instance.
  const ctor = function (this: unknown, _url: string) {
    return socket
  } as unknown as AttachSocketCtor
  const rendered: string[] = []
  const park = parkedStdin()
  const session = await attachToDaemon({
    url: "ws://127.0.0.1:0/",
    stdin: overrides.stdin ?? park.stdin,
    write: overrides.write ?? ((chunk) => rendered.push(chunk)),
    promptApproval: overrides.promptApproval ?? (async () => "n"),
    webSocketCtor: ctor,
  })
  socket.fireOpen()
  socket.deliver(snapshotMsg(sid))
  await flush()
  return { socket, session, rendered }
}

describe("attachToDaemon — daemon-initiated close (finding #1)", () => {
  test("a socket 'close' event resolves done + stops the read loop (no hang)", async () => {
    // A stdin that yields forever IF the loop keeps pulling — a hung loop would
    // keep consuming. After the close, the loop must stop accepting lines.
    let pulls = 0
    const stdin = (async function* () {
      for (;;) {
        pulls++
        yield "ping"
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    })()
    const rendered: string[] = []
    const { socket, session } = await attachReady("daemon-1", {
      stdin,
      write: (c) => rendered.push(c),
    })

    // Daemon drops the socket.
    socket.fireClose()

    // `done` MUST resolve (no hang). If the bug is present this rejects via the race.
    await Promise.race([
      session.done,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("done() hung after close")), 500),
      ),
    ])

    // A clean "disconnected" banner is printed.
    expect(rendered.join("")).toMatch(/disconnect/i)

    // The read loop has CONVERGED — it must stop pulling. An in-flight generator
    // `await` can advance the counter at most once more as the loop unwinds (the
    // loop checks `closed` on the NEXT iteration), so we let any in-flight pull
    // land, then assert the count is frozen across a further flush (a hung loop
    // would keep ticking every ~5ms forever).
    await flush()
    const pullsAfterClose = pulls
    await flush()
    await flush()
    expect(pulls).toBe(pullsAfterClose)
  })

  test("a socket 'error' event also resolves done (no hang)", async () => {
    const { socket, session } = await attachReady("daemon-err")
    socket.fireError()
    await Promise.race([
      session.done,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("done() hung after error")), 500),
      ),
    ])
  })
})

describe("attachToDaemon — session.closed event (finding #2)", () => {
  test("a session.closed SessionEvent shuts the client down + prints the close banner", async () => {
    const rendered: string[] = []
    const { socket, session } = await attachReady("daemon-2", { write: (c) => rendered.push(c) })

    socket.deliver(
      eventMsg({
        eventId: "e-closed",
        seq: 9,
        revision: 1,
        emittedAt: "t",
        type: "session.closed",
      }),
    )

    await Promise.race([
      session.done,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("done() hung after session.closed")), 500),
      ),
    ])
    // The renderer's close banner is printed AND the client shut down.
    expect(rendered.join("")).toContain("session closed")
  })
})

describe("attachToDaemon — approval-respond orchestration fail-safe (finding #5)", () => {
  const approvalEvent = (approvalId: string): SessionTransportMessage =>
    eventMsg({
      eventId: `e-${approvalId}`,
      seq: 5,
      revision: 1,
      emittedAt: "t",
      type: "approval.requested",
      approval: { approvalId, reason: "run rm -rf /", requestedAt: "t" },
    })

  const lastApprovalRespond = (socket: FakeSocket) => {
    for (let i = socket.sent.length - 1; i >= 0; i--) {
      const m = socket.sent[i]
      if (m?.kind === "command" && m.command.type === "approval.respond") return m.command
    }
    return undefined
  }

  test("a prompter returning GARBAGE ⇒ a deny respond carrying the right approvalId", async () => {
    const { socket } = await attachReady("appr-1", {
      promptApproval: async () => "definitely maybe", // non-empty garbage
    })
    socket.deliver(approvalEvent("ap-garbage"))
    await flush()

    const respond = lastApprovalRespond(socket)
    expect(respond).toBeDefined()
    if (respond?.type !== "approval.respond") throw new Error("narrow")
    expect(respond.decision).toBe("deny")
    expect(respond.approvalId).toBe("ap-garbage")
    expect(respond.sessionId).toBe("appr-1")
  })

  test("a prompter that THROWS ⇒ a deny respond (fail-safe, never approve, never hang)", async () => {
    const { socket } = await attachReady("appr-2", {
      promptApproval: async () => {
        throw new Error("tty exploded")
      },
    })
    socket.deliver(approvalEvent("ap-throw"))
    await flush()

    const respond = lastApprovalRespond(socket)
    expect(respond).toBeDefined()
    if (respond?.type !== "approval.respond") throw new Error("narrow")
    expect(respond.decision).toBe("deny")
    expect(respond.approvalId).toBe("ap-throw")
  })

  test("a prompter answering 'y' ⇒ an approve respond (the happy path still approves)", async () => {
    const { socket } = await attachReady("appr-3", { promptApproval: async () => "y" })
    socket.deliver(approvalEvent("ap-yes"))
    await flush()

    const respond = lastApprovalRespond(socket)
    expect(respond).toBeDefined()
    if (respond?.type !== "approval.respond") throw new Error("narrow")
    expect(respond.decision).toBe("approve")
    expect(respond.approvalId).toBe("ap-yes")
  })
})

describe("attachToDaemon — dead-socket send surfacing (finding #3)", () => {
  test("a typed line that fails to send on a dead socket surfaces an error (not silence)", async () => {
    // Controllable stdin: push one line AFTER the socket dies.
    let pushLine: ((line: string) => void) | undefined
    const stdin = (async function* () {
      const queue: string[] = []
      let resolveNext: (() => void) | undefined
      pushLine = (line) => {
        queue.push(line)
        resolveNext?.()
      }
      for (;;) {
        if (queue.length > 0) {
          const next = queue.shift()
          if (next !== undefined) yield next
          continue
        }
        await new Promise<void>((resolve) => {
          resolveNext = resolve
        })
      }
    })()

    const rendered: string[] = []
    const { socket } = await attachReady("dead-1", { stdin, write: (c) => rendered.push(c) })

    // Socket dies mid-session (send now throws) but NO close event was fired —
    // this models the window the read loop can still pull a line.
    socket.killSendWith(new Error("ECONNRESET"))

    expect(pushLine).toBeDefined()
    pushLine?.("this should not vanish silently")
    await flush()

    // Defense-in-depth: the user must SEE a failure, not silence.
    expect(rendered.join("")).toMatch(/disconnect|send fail|error|lost/i)
  })
})

describe("attachToDaemon — token-in-URL encoding (finding #6)", () => {
  test("a token with special chars is percent-encoded into ?token=", async () => {
    let capturedUrl: string | undefined
    const socket = makeFakeSocket()
    const ctor = function (this: unknown, url: string) {
      capturedUrl = url
      return socket
    } as unknown as AttachSocketCtor

    const park = parkedStdin()
    const session = await attachToDaemon({
      url: "ws://127.0.0.1:0/",
      token: "a b&c",
      stdin: park.stdin,
      write: () => undefined,
      promptApproval: async () => "n",
      webSocketCtor: ctor,
    })
    expect(capturedUrl).toBe("ws://127.0.0.1:0/?token=a%20b%26c")
    await session.close()
  })

  test("no token ⇒ no ?token= appended (byte-identical URL)", async () => {
    let capturedUrl: string | undefined
    const socket = makeFakeSocket()
    const ctor = function (this: unknown, url: string) {
      capturedUrl = url
      return socket
    } as unknown as AttachSocketCtor

    const park = parkedStdin()
    const session = await attachToDaemon({
      url: "ws://127.0.0.1:0/",
      stdin: park.stdin,
      write: () => undefined,
      promptApproval: async () => "n",
      webSocketCtor: ctor,
    })
    expect(capturedUrl).toBe("ws://127.0.0.1:0/")
    expect(capturedUrl).not.toContain("token=")
    await session.close()
  })
})

// ── WS-B (jul-10 uiux structural) — one stdin owner for attach ────────────────

describe("HELLGATE WS-B — attach approval rides the read loop (UUX-3-02/3-03)", () => {
  const approvalEvent = (approvalId: string, seq = 5): SessionTransportMessage =>
    eventMsg({
      eventId: `e-${approvalId}`,
      seq,
      revision: 1,
      emittedAt: "t",
      type: "approval.requested",
      approval: { approvalId, reason: "run git push", requestedAt: "t" },
    })

  const lastApprovalRespond = (socket: FakeSocket) => {
    for (let i = socket.sent.length - 1; i >= 0; i--) {
      const m = socket.sent[i]
      if (m?.kind === "command" && m.command.type === "approval.respond") return m.command
    }
    return undefined
  }

  const pushableStdin = (): { stdin: AsyncIterable<string>; push: (l: string) => void } => {
    const q: string[] = []
    let notify: (() => void) | undefined
    const stdin = (async function* () {
      for (;;) {
        const next = q.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        await new Promise<void>((resolve) => {
          notify = resolve
        })
      }
    })()
    return {
      stdin,
      push: (l: string) => {
        q.push(l)
        notify?.()
      },
    }
  }

  test("UUX-3-02: a pending approval CLAIMS the next stdin line — it answers the prompt, never becomes session input", async () => {
    // Mirror attach-cmd's production wiring: channel-backed prompt + claim seam.
    const { createMidTurnApprovalChannel } = await import(
      "@/apps/cli/repl/mid-turn-approval-channel"
    )
    const channel = createMidTurnApprovalChannel()
    channel.active = true
    const lines = pushableStdin()
    const socket = makeFakeSocket()
    const ctor = function (this: unknown, _url: string) {
      return socket
    } as unknown as AttachSocketCtor
    const session = await attachToDaemon({
      url: "ws://127.0.0.1:0/",
      stdin: lines.stdin,
      write: () => undefined,
      promptApproval: async (reason) => {
        void reason
        const r = await channel.awaitLine()
        return r.kind === "line" ? r.line : "n"
      },
      claimApprovalLine: (line) => channel.tryResolve(line),
      webSocketCtor: ctor,
    })
    socket.fireOpen()
    socket.deliver(snapshotMsg("claim-1"))
    await flush()

    socket.deliver(approvalEvent("ap-claim"))
    await flush() // prompt is now awaiting the channel
    lines.push("y")
    await flush()

    const respond = lastApprovalRespond(socket)
    expect(respond).toBeDefined()
    if (respond?.type !== "approval.respond") throw new Error("narrow")
    expect(respond.decision).toBe("approve")
    expect(respond.approvalId).toBe("ap-claim")
    // The "y" line must NOT have been sent as session input.
    const inputs = socket.sent.filter(
      (m) => m.kind === "command" && m.command.type === "input.append",
    )
    expect(inputs).toEqual([])
    // A line typed AFTER the approval settled routes as normal session input.
    lines.push("hello agent")
    await flush()
    const later = socket.sent.filter(
      (m) => m.kind === "command" && m.command.type === "input.append",
    )
    expect(later.length).toBe(1)
    await session.close()
  })

  test("UUX-3-03: a PRE-HANDSHAKE approval is not dropped — it waits for readiness and then prompts", async () => {
    const socket = makeFakeSocket()
    const ctor = function (this: unknown, _url: string) {
      return socket
    } as unknown as AttachSocketCtor
    const park = parkedStdin()
    let prompted = 0
    const session = await attachToDaemon({
      url: "ws://127.0.0.1:0/",
      stdin: park.stdin,
      write: () => undefined,
      promptApproval: async () => {
        prompted += 1
        return "y"
      },
      webSocketCtor: ctor,
    })
    socket.fireOpen()
    // Approval arrives BEFORE the snapshot settles the handshake — the old
    // code silently returned (sid undefined) and the ask vanished.
    socket.deliver(approvalEvent("ap-early", 1))
    await flush()
    expect(prompted).toBe(0) // still waiting for readiness — not dropped, not asked yet
    socket.deliver(snapshotMsg("early-1"))
    await flush()
    expect(prompted).toBe(1)
    const respond = lastApprovalRespond(socket)
    expect(respond).toBeDefined()
    if (respond?.type !== "approval.respond") throw new Error("narrow")
    expect(respond.approvalId).toBe("ap-early")
    expect(respond.sessionId).toBe("early-1") // the CANONICAL id, resolved after the wait
    await session.close()
  })
})
