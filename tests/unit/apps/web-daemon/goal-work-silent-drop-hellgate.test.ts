/**
 * ★ HELLGATE — a `goalWork` frame is never accepted and then silently dropped.
 *
 * MEASURED DEFECT (2026-08-30, two audit rounds + probes): `consumeGoalWorkFrame`
 * swears in its own docblock that "every outcome — including a refusal — is
 * answered on the REQUESTING socket: a request that cannot be claimed is never
 * accepted and then silently dropped". Two paths broke that promise:
 *
 *  1. No goal handler composed (`QUANTA_GOAL=0`, or no objective authority) ⇒
 *     `return false` and the frame falls through to the session bridge. There it
 *     carries no transport `kind`, so `tryDecodeSessionTransportMessage` returns
 *     `undefined` and it lands on the floor — and because the frame has no
 *     recognizable version either, the lenient reject path mints nothing. No
 *     answer of any kind.
 *  2. Blank/whitespace `text` ⇒ `peekGoalWork` returns `null`, so even WITH the
 *     handler present the frame takes the same fall-through to the same floor.
 *
 * The client half makes this worse rather than saving it: `sendGoalWork` returns
 * `true` on a successful socket write and has no timeout, and its JSDoc tells the
 * caller "a refusal names its reason — no silent drop". So a UI built on it hangs
 * forever on both paths.
 *
 * The fall-through is only correct for a frame this daemon does NOT own. `kind:
 * "goalWork"` is unambiguously ours, so the two paths above are refusals, and a
 * refusal is a thing you say.
 */

import { describe, expect, test } from "bun:test"
import type { WebGoalWorkHandler } from "@/apps/web-daemon/goal-work-compose"
import { consumeGoalWorkFrame } from "@/apps/web-daemon/server/ws-handlers"
import { tryDecodeSessionTransportMessage } from "@/ipc/session"

const socket = () => {
  const sent: string[] = []
  return {
    sent,
    // `ServerWebSocket.send` answers with the byte count, so the fake does too.
    ws: {
      send: (text: string): number => {
        sent.push(text)
        return text.length
      },
    },
  }
}

const results = (sent: readonly string[]) =>
  sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)

const FRAME = JSON.stringify({ kind: "goalWork", text: "fix the flake" })
const BLANK = JSON.stringify({ kind: "goalWork", text: "   " })

const handlerSpy = () => {
  const calls: string[] = []
  const handler: WebGoalWorkHandler = {
    request: (text, reply) => {
      calls.push(text)
      reply({ ok: true, status: "accepted" })
    },
    settled: async () => undefined,
  }
  return { calls, handler }
}

describe("goalWork — a frame this daemon owns is always answered", () => {
  test("no goal handler composed ⇒ CONSUMED with a refusal that names the missing piece", () => {
    const { sent, ws } = socket()

    const consumed = consumeGoalWorkFrame(ws, {}, FRAME)

    // Consumed: it must not ALSO reach the bridge, which would drop it.
    expect(consumed).toBe(true)
    expect(sent).toHaveLength(1)
    const [answer] = results(sent)
    expect(answer?.kind).toBe("goalWorkResult")
    expect(answer?.ok).toBe(false)
    expect(String(answer?.reason)).toMatch(/goal|objective/i)
    expect(String(answer?.reason)).not.toBe("not wired")
  })

  test("blank text WITH a handler ⇒ answered, and the handler is never dispatched", () => {
    const { sent, ws } = socket()
    const { calls, handler } = handlerSpy()

    const consumed = consumeGoalWorkFrame(ws, { goalWork: handler }, BLANK)

    expect(consumed).toBe(true)
    expect(calls).toEqual([])
    expect(sent).toHaveLength(1)
    const [answer] = results(sent)
    expect(answer?.ok).toBe(false)
    expect(String(answer?.reason)).toMatch(/empty|blank/i)
  })

  test("ANTI-VACUITY — the fall-through really was a floor-drop, not the bridge's job", () => {
    // If the bridge could decode these, "consume and answer" would be
    // over-correction. It cannot: both are undecodable transport frames, so
    // before this packet nothing on the wire ever answered them.
    expect(tryDecodeSessionTransportMessage(FRAME)).toBeUndefined()
    expect(tryDecodeSessionTransportMessage(BLANK)).toBeUndefined()
  })

  test("PAIRED CONTROL — a frame this daemon does NOT own still falls through untouched", () => {
    const { sent, ws } = socket()
    const { handler } = handlerSpy()

    const consumed = consumeGoalWorkFrame(
      ws,
      { goalWork: handler },
      JSON.stringify({ kind: "connect", sessionId: "s-1" }),
    )

    expect(consumed).toBe(false)
    expect(sent).toEqual([])
  })

  test("PAIRED CONTROL — a well-formed request still dispatches and is accepted", () => {
    const { sent, ws } = socket()
    const { calls, handler } = handlerSpy()

    expect(consumeGoalWorkFrame(ws, { goalWork: handler }, FRAME)).toBe(true)

    expect(calls).toEqual(["fix the flake"])
    expect(results(sent)[0]).toMatchObject({ kind: "goalWorkResult", ok: true })
  })
})

describe("goalWork — a client correlation id survives the round trip", () => {
  test("the requestId the client sends is echoed on the refusal, not only on the accept", () => {
    const { sent, ws } = socket()

    consumeGoalWorkFrame(
      ws,
      {},
      JSON.stringify({ kind: "goalWork", text: "fix the flake", requestId: "req-7" }),
    )

    expect(results(sent)[0]).toMatchObject({ requestId: "req-7", ok: false })
  })

  test("a blank request still carries its id back, so the caller can settle it", () => {
    const { sent, ws } = socket()
    const { handler } = handlerSpy()

    consumeGoalWorkFrame(
      ws,
      { goalWork: handler },
      JSON.stringify({ kind: "goalWork", text: "  ", requestId: "req-8" }),
    )

    expect(results(sent)[0]).toMatchObject({ requestId: "req-8", ok: false })
  })
})
