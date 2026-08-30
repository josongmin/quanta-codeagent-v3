/**
 * ★ HELLGATE — `SessionClient.send()` reports whether the frame actually left.
 *
 * MEASURED DEFECT: `send()` drops a command on a closed socket and on a
 * pre-handshake socket, logs a warning, and returns `void`. `useSendObjectiveMutate`
 * then returns `true` on the strength of having a session id, so `/goal pause`
 * would report "sent" for a frame that never left the browser — and the operator
 * would sit waiting for a state change that no one asked for.
 *
 * A boolean here is the whole fix: every existing caller ignores the return
 * value, so widening it is compatible, and no objective-specific transport has
 * to be invented to carry the truth.
 */

import { describe, expect, it } from "vitest"
import { SessionClient, type WebSocketLike } from "./client"
import { SESSION_PROTOCOL_VERSION } from "./envelope"
import type { SessionCommand } from "../types/protocol"

class FakeWebSocket implements WebSocketLike {
  readyState = 0
  sent: string[] = []
  onopen: ((ev: Event) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  /** Set to make `send` throw, the third way a frame fails to leave. */
  throwOnSend = false
  constructor(
    readonly url: string,
    readonly protocols?: string | readonly string[],
  ) {}
  send(data: string): void {
    if (this.throwOnSend) throw new Error("send exploded")
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
  }
  _open(): void {
    this.readyState = 1
    this.onopen?.(new Event("open"))
  }
  _message(data: unknown): void {
    this.onmessage?.({ data })
  }
}

const rejectedFrame = JSON.stringify({
  version: SESSION_PROTOCOL_VERSION,
  kind: "rejected",
  target: "connect",
  reason: "protocol_validation",
  issue: "handshake_required",
  sessionId: "srv-1",
})

const snapshotFrame = JSON.stringify({
  version: SESSION_PROTOCOL_VERSION,
  kind: "snapshot",
  payload: {
    sessionId: "srv-1",
    revision: 1,
    seq: 0,
    state: { status: "idle", draftInput: "", permissionMode: "default", messageCount: 0 },
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

const harness = () => {
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
    setTimer: () => 1,
    clearTimer: () => undefined,
    log: () => undefined,
  })
  return { client, fakes }
}

const COMMAND = {
  sessionId: "srv-1",
  commandId: "cmd-1",
  issuedAt: "2026-08-30T00:00:00.000Z",
  type: "session.objective.mutate",
  mutation: { kind: "setExplicitStatus", status: "paused" },
} as unknown as SessionCommand

describe("SessionClient.send — the return value is the truth about the frame", () => {
  it("a never-connected client reports FALSE and sends nothing", () => {
    const { client, fakes } = harness()

    expect(client.send(COMMAND)).toBe(false)
    expect(fakes).toHaveLength(0)
  })

  it("an open socket whose handshake has not settled reports FALSE", () => {
    const { client, fakes } = harness()
    client.connect({ url: "ws://localhost/x" })
    fakes[0]?._open()
    const beforeHandshake = fakes[0]?.sent.length ?? 0

    expect(client.send(COMMAND)).toBe(false)
    // The connect frame is the only thing on the wire — the command is not.
    expect(fakes[0]?.sent).toHaveLength(beforeHandshake)
  })

  it("a closed socket reports FALSE", () => {
    const { client, fakes } = harness()
    client.connect({ url: "ws://localhost/x" })
    fakes[0]?._open()
    fakes[0]?._message(rejectedFrame)
    fakes[0]?._message(snapshotFrame)
    const sentWhileOpen = fakes[0]?.sent.length ?? 0
    fakes[0]?.close()

    expect(client.send(COMMAND)).toBe(false)
    expect(fakes[0]?.sent).toHaveLength(sentWhileOpen)
  })

  it("a socket whose send() throws reports FALSE — never a lie about delivery", () => {
    const { client, fakes } = harness()
    client.connect({ url: "ws://localhost/x" })
    fakes[0]?._open()
    fakes[0]?._message(rejectedFrame)
    fakes[0]?._message(snapshotFrame)
    const fake = fakes[0]
    if (fake === undefined) throw new Error("no socket")
    fake.throwOnSend = true

    expect(client.send(COMMAND)).toBe(false)
  })

  it("PAIRED CONTROL — a connected socket reports TRUE and the frame is on the wire", () => {
    const { client, fakes } = harness()
    client.connect({ url: "ws://localhost/x" })
    fakes[0]?._open()
    fakes[0]?._message(rejectedFrame)
    fakes[0]?._message(snapshotFrame)
    const before = fakes[0]?.sent.length ?? 0

    expect(client.send(COMMAND)).toBe(true)

    expect(fakes[0]?.sent).toHaveLength(before + 1)
    const frame = JSON.parse(fakes[0]?.sent.at(-1) ?? "{}") as Record<string, unknown>
    expect(frame).toMatchObject({ kind: "command" })
  })

  it("a throwing send does not take the client down", () => {
    const { client, fakes } = harness()
    client.connect({ url: "ws://localhost/x" })
    fakes[0]?._open()
    fakes[0]?._message(rejectedFrame)
    fakes[0]?._message(snapshotFrame)
    const fake = fakes[0]
    if (fake === undefined) throw new Error("no socket")
    fake.throwOnSend = true

    expect(() => client.send(COMMAND)).not.toThrow()
    fake.throwOnSend = false
    expect(client.send(COMMAND)).toBe(true)
  })
})
