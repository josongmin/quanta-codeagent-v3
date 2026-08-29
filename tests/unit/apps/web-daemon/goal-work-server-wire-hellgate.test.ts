/**
 * GOAL-08 rail 15 (web half) — SERVER WIRE hellgate: a `goalWork` frame must
 * reach the composed handler through the REAL `message` handler and must be
 * CONSUMED (never forwarded to the session bridge — it is not a
 * `SessionCommand`), the ack must be written back on the REQUESTING socket, and
 * with no handler composed the frame must fall through byte-identically.
 *
 * Mirrors the control-request server wire hellgate: same spy adapter, same
 * `buildWebSocketHandlers` front door — no bespoke pipeline copy.
 */

import { describe, expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import type { WebGoalWorkHandler } from "@/apps/web-daemon/goal-work-compose"
import type { WebDaemonServerConfig } from "@/apps/web-daemon/server"
import type { WSData } from "@/apps/web-daemon/server/ws-data"
import { buildWebSocketHandlers } from "@/apps/web-daemon/server/ws-handlers"

const frame = (text: string): string => JSON.stringify({ kind: "goalWork", text })

const spyAdapter = () => {
  const pushed: (string | Uint8Array | ArrayBuffer)[] = []
  return {
    adapter: {
      socket: {} as never,
      pushMessage: (raw: string | Uint8Array | ArrayBuffer) => pushed.push(raw),
      handleClose: () => {},
    },
    pushed,
  }
}

type GoalWorkReply = Parameters<Parameters<WebGoalWorkHandler["request"]>[1]>[0]

const spyHandler = (...results: GoalWorkReply[]) => {
  const requests: string[] = []
  const handler: WebGoalWorkHandler = {
    request: (text, reply) => {
      requests.push(text)
      for (const result of results) reply(result)
    },
    settled: async () => undefined,
  }
  return { handler, requests }
}

const fakeWs = (adapter: unknown, opts: { registered?: boolean; sendThrows?: boolean } = {}) => {
  const sent: string[] = []
  return {
    ws: {
      data: { adapter, registered: opts.registered ?? true },
      send: (raw: string) => {
        if (opts.sendThrows === true) throw new Error("socket exploded")
        sent.push(raw)
      },
    } as unknown as ServerWebSocket<WSData>,
    sent,
  }
}

const buildHandlers = (goalWork: WebGoalWorkHandler | undefined) =>
  buildWebSocketHandlers({
    config: {
      supportedReadModels: { session: { status: "supported", version: "session.v1" } },
      ...(goalWork !== undefined ? { goalWork } : {}),
    } as unknown as WebDaemonServerConfig,
    registry: {
      add: () => {},
      has: () => false,
      size: () => 0,
      evict: async () => {},
      closeAll: async () => {},
    },
    sharedSession: {} as never,
    followerApproval: undefined,
  })

describe("GOAL-08 rail 15 — web goal-work server wire", () => {
  test("WIRED: the frame reaches the handler, is CONSUMED, and the ack lands on this socket", () => {
    const { adapter, pushed } = spyAdapter()
    const { handler, requests } = spyHandler({ ok: true, status: "accepted" })
    const { ws, sent } = fakeWs(adapter)
    buildHandlers(handler).message(ws, frame("fix the flake"))
    expect(requests).toEqual(["fix the flake"])
    expect(pushed).toEqual([]) // never reaches the bridge / kernel reducer
    expect(sent.map((raw) => JSON.parse(raw))).toEqual([
      { kind: "goalWorkResult", ok: true, status: "accepted" },
    ])
  })

  test("BOTH frames cross the socket: the accept AND a LATE refusal (round-4 lesson, at the wire)", () => {
    const { adapter, pushed } = spyAdapter()
    const { handler } = spyHandler(
      { ok: true, status: "accepted" },
      { ok: false, reason: "goal work turn refused: invalid_turn_submit_provenance" },
    )
    const { ws, sent } = fakeWs(adapter)
    buildHandlers(handler).message(ws, frame("fix the flake"))
    expect(pushed).toEqual([])
    expect(sent.map((raw) => JSON.parse(raw))).toEqual([
      { kind: "goalWorkResult", ok: true, status: "accepted" },
      {
        kind: "goalWorkResult",
        ok: false,
        reason: "goal work turn refused: invalid_turn_submit_provenance",
      },
    ])
  })

  test("a typed refusal is answered on the socket (never a silent drop)", () => {
    const { adapter, pushed } = spyAdapter()
    const { handler } = spyHandler({ ok: false, reason: "the goal is not active" })
    const { ws, sent } = fakeWs(adapter)
    buildHandlers(handler).message(ws, frame("anything"))
    expect(pushed).toEqual([])
    expect(sent.map((raw) => JSON.parse(raw))).toEqual([
      { kind: "goalWorkResult", ok: false, reason: "the goal is not active" },
    ])
  })

  test("NOT COMPOSED: the frame falls through to the adapter, byte-identical", () => {
    const { adapter, pushed } = spyAdapter()
    const { ws, sent } = fakeWs(adapter)
    const raw = frame("fix the flake")
    buildHandlers(undefined).message(ws, raw)
    expect(pushed).toEqual([raw])
    expect(sent).toEqual([])
  })

  test("NON-MATCH: a foreign frame is forwarded even when the handler is wired (no frame stealing)", () => {
    const { adapter, pushed } = spyAdapter()
    const { handler, requests } = spyHandler({ ok: true, status: "accepted" })
    const { ws } = fakeWs(adapter)
    const raw = JSON.stringify({ kind: "somethingElse", text: "fix the flake" })
    buildHandlers(handler).message(ws, raw)
    expect(requests).toEqual([])
    expect(pushed).toEqual([raw])
  })

  test("a handler that THROWS cannot take the daemon down: the frame is consumed and answered", () => {
    const { adapter, pushed } = spyAdapter()
    const handler: WebGoalWorkHandler = {
      request: () => {
        throw new Error("authority exploded")
      },
      settled: async () => undefined,
    }
    const { ws, sent } = fakeWs(adapter)
    // A throw out of Bun's `message` handler kills the whole daemon process.
    expect(() => buildHandlers(handler).message(ws, frame("fix the flake"))).not.toThrow()
    expect(pushed).toEqual([])
    const answered = sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)
    expect(answered).toHaveLength(1)
    expect(answered[0]).toMatchObject({ kind: "goalWorkResult", ok: false })
    expect(String(answered[0]?.reason)).toContain("authority exploded")
  })

  test("a send that throws (dead socket) does not escape the message handler either", () => {
    const { adapter } = spyAdapter()
    const { handler } = spyHandler({ ok: true, status: "accepted" })
    const { ws } = fakeWs(adapter, { sendThrows: true })
    expect(() => buildHandlers(handler).message(ws, frame("x"))).not.toThrow()
  })

  test("a connection that is NOT yet a registered session is told to retry — no billed turn", () => {
    const { adapter, pushed } = spyAdapter()
    const { handler, requests } = spyHandler({ ok: true, status: "accepted" })
    const { ws, sent } = fakeWs(adapter, { registered: false })
    buildHandlers(handler).message(ws, frame("fix the flake"))
    expect(requests).toEqual([]) // the verb never ran
    expect(pushed).toEqual([]) // still consumed (not forwarded as an unknown frame)
    expect(sent.map((raw) => JSON.parse(raw))).toEqual([
      {
        kind: "goalWorkResult",
        ok: false,
        reason: "the session is not ready yet — retry after the connect handshake",
      },
    ])
  })

  test("a client requestId is echoed on every result frame for that request", () => {
    const { adapter } = spyAdapter()
    const { handler } = spyHandler(
      { ok: true, status: "accepted" },
      { ok: false, reason: "goal work turn refused: conflict" },
    )
    const { ws, sent } = fakeWs(adapter)
    buildHandlers(handler).message(
      ws,
      JSON.stringify({ kind: "goalWork", text: "fix the flake", requestId: "req-7" }),
    )
    expect(sent.map((raw) => JSON.parse(raw))).toEqual([
      { kind: "goalWorkResult", requestId: "req-7", ok: true, status: "accepted" },
      {
        kind: "goalWorkResult",
        requestId: "req-7",
        ok: false,
        reason: "goal work turn refused: conflict",
      },
    ])
  })
})
