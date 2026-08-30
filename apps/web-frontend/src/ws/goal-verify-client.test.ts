import { describe, expect, it } from "vitest"
import { SessionClient, type WebSocketLike } from "./client"
import { requestGoalVerification } from "./session-hooks"

class FakeWebSocket implements WebSocketLike {
  readyState = 0
  sent: string[] = []
  onopen: ((ev: Event) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
  }
  open(): void {
    this.readyState = 1
    this.onopen?.(new Event("open"))
  }
  receive(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) })
  }
}

const harness = () => {
  let socket: FakeWebSocket | undefined
  class TestWebSocket extends FakeWebSocket {
    constructor(_url: string) {
      super()
      socket = this
    }
  }
  const client = new SessionClient({
    webSocketCtor: TestWebSocket as unknown as new (url: string) => WebSocketLike,
    setTimer: () => 1,
    clearTimer: () => undefined,
    log: () => undefined,
  })
  client.connect({ url: "ws://localhost/x" })
  if (socket === undefined) throw new Error("socket not created")
  return { client, socket }
}

describe("SessionClient goal verification", () => {
  it("sends request identity + viewed revision and decodes the result", async () => {
    const { client, socket } = harness()
    socket.open()
    const pending = requestGoalVerification(client, 11, {
      makeRequestId: () => "verify-11",
      timeoutMs: 500,
    })
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({
      kind: "goalVerify",
      requestId: "verify-11",
      expectedObjectiveRevision: 11,
    })
    socket.receive({
      kind: "goalVerifyResult",
      requestId: "unrelated",
      status: "completed",
      outcome: { kind: "verified", passed: 9, failed: 9, revision: 9 },
    })
    socket.receive({
      kind: "goalVerifyResult",
      requestId: "verify-11",
      status: "completed",
      outcome: { kind: "verified", passed: 1, failed: 0, revision: 12 },
    })
    await expect(pending).resolves.toEqual({
      kind: "result",
      frame: {
        requestId: "verify-11",
        status: "completed",
        outcome: { kind: "verified", passed: 1, failed: 0, revision: 12 },
      },
    })
  })

  it("closed socket returns undelivered immediately", async () => {
    const { client } = harness()
    await expect(
      requestGoalVerification(client, 1, { makeRequestId: () => "verify-drop" }),
    ).resolves.toEqual({ kind: "undelivered" })
  })

  it("malformed result is ignored until a valid correlated frame", async () => {
    const { client, socket } = harness()
    socket.open()
    const pending = requestGoalVerification(client, 2, {
      makeRequestId: () => "verify-2",
      timeoutMs: 500,
    })
    socket.receive({ kind: "goalVerifyResult", requestId: "verify-2", status: "completed" })
    socket.receive({
      kind: "goalVerifyResult",
      requestId: "verify-2",
      status: "refused",
      outcome: { kind: "rejected", reason: "stale-revision:3" },
    })
    await expect(pending).resolves.toMatchObject({
      kind: "result",
      frame: { status: "refused", outcome: { reason: "stale-revision:3" } },
    })
  })
})
