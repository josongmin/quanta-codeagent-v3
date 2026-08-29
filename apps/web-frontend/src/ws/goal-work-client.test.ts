/**
 * GOAL-08 rail 15 (web half) — the client can ASK the live session for one
 * user-requested goal turn, and ALWAYS learns the outcome: an accept or a named
 * refusal (the round-4 lesson — never "sent" then silently dropped).
 */

import { describe, expect, it } from "vitest"
import { SessionClient, type WebSocketLike } from "./client"

class FakeWebSocket implements WebSocketLike {
  readyState = 0
  sent: string[] = []
  onopen: ((ev: Event) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  readonly url: string
  constructor(url: string) {
    this.url = url
  }
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
  receive(data: unknown): void {
    this.onmessage?.({ data })
  }
}

const harness = () => {
  const fakes: FakeWebSocket[] = []
  class TestWebSocket extends FakeWebSocket {
    constructor(url: string) {
      super(url)
      fakes.push(this)
    }
  }
  const client = new SessionClient({
    webSocketCtor: TestWebSocket as unknown as new (url: string) => WebSocketLike,
    setTimer: () => 1,
    clearTimer: () => undefined,
    log: () => undefined,
  })
  client.connect({ url: "ws://localhost/x" })
  const socket = fakes[0] as FakeWebSocket
  return { client, socket }
}

const goalWorkFrames = (socket: FakeWebSocket): unknown[] =>
  socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((frame) => frame.kind === "goalWork")

describe("SessionClient — web /goal work", () => {
  it("sends the out-of-band goalWork frame on an open socket", () => {
    const { client, socket } = harness()
    socket.open()
    expect(client.sendGoalWork("fix the flake")).toBe(true)
    expect(goalWorkFrames(socket)).toEqual([{ kind: "goalWork", text: "fix the flake" }])
  })

  it("refuses to pretend when the socket is not open (no frame, false)", () => {
    const { client, socket } = harness()
    expect(client.sendGoalWork("fix the flake")).toBe(false)
    expect(goalWorkFrames(socket)).toEqual([])
  })

  it("routes the daemon's accept and its late refusal to subscribers, and unsubscribes", () => {
    const { client, socket } = harness()
    socket.open()
    const seen: unknown[] = []
    const off = client.onGoalWorkResult((result) => seen.push(result))
    socket.receive(JSON.stringify({ kind: "goalWorkResult", ok: true, status: "accepted" }))
    socket.receive(
      JSON.stringify({ kind: "goalWorkResult", ok: false, reason: "the goal is not active" }),
    )
    expect(seen).toEqual([
      { ok: true, status: "accepted" },
      { ok: false, reason: "the goal is not active" },
    ])
    off()
    socket.receive(JSON.stringify({ kind: "goalWorkResult", ok: true, status: "accepted" }))
    expect(seen).toHaveLength(2)
  })

  it("a malformed result frame is ignored (no throw, no bogus callback)", () => {
    const { client, socket } = harness()
    socket.open()
    const seen: unknown[] = []
    client.onGoalWorkResult((result) => seen.push(result))
    socket.receive(JSON.stringify({ kind: "goalWorkResult" }))
    socket.receive(JSON.stringify({ kind: "goalWorkResult", ok: false }))
    expect(seen).toEqual([])
  })

  it("a result frame WITHOUT the accepted status is not invented into one", () => {
    const { client, socket } = harness()
    socket.open()
    const seen: unknown[] = []
    client.onGoalWorkResult((result) => seen.push(result))
    socket.receive(JSON.stringify({ kind: "goalWorkResult", ok: true }))
    socket.receive(JSON.stringify({ kind: "goalWorkResult", ok: true, status: "queued" }))
    expect(seen).toEqual([])
  })

  it("a throwing subscriber never starves the others", () => {
    const { client, socket } = harness()
    socket.open()
    const seen: unknown[] = []
    client.onGoalWorkResult(() => {
      throw new Error("subscriber exploded")
    })
    client.onGoalWorkResult((result) => seen.push(result))
    socket.receive(JSON.stringify({ kind: "goalWorkResult", ok: true, status: "accepted" }))
    expect(seen).toEqual([{ ok: true, status: "accepted" }])
  })

  it("unsubscribing DURING dispatch does not disturb the walk", () => {
    const { client, socket } = harness()
    socket.open()
    const seen: string[] = []
    const off = client.onGoalWorkResult(() => {
      seen.push("first")
      off()
    })
    client.onGoalWorkResult(() => seen.push("second"))
    socket.receive(JSON.stringify({ kind: "goalWorkResult", ok: true, status: "accepted" }))
    expect(seen).toEqual(["first", "second"])
  })

  it("a send that THROWS is reported as false, not as a success", () => {
    const { client, socket } = harness()
    socket.open()
    socket.send = () => {
      throw new Error("socket exploded")
    }
    expect(client.sendGoalWork("fix the flake")).toBe(false)
  })
})
