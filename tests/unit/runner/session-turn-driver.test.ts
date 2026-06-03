/**
 * Behavioral contract for the hoisted turn driver (`@/runner/orchestrate`).
 *
 * The thin-surface hellgate only checks the driver EXISTS and is terminal-free;
 * this proves it actually BEHAVES like the loop it replaced — driving a fake
 * `RuntimeSession` and pinning the load-bearing details the byte-identical claim
 * rests on: append signature, the approval-resolution loop, both verbatim error
 * strings, and the normalized result shape.
 */
import { describe, expect, test } from "bun:test"
import type { AgentOutcome } from "@/agent"
import { driveSessionTurn } from "@/runner/orchestrate"
import type { RuntimeSession, SessionDispatchResult } from "@/sdk/runtime"

const OUTCOME: AgentOutcome = { reason: "completed" } as AgentOutcome

interface Recorder {
  appends: Array<{ text: string; opts: unknown }>
  responds: Array<{ id: string; decision: string }>
}

/** A scripted fake session: `turns` is the queue of dispatch results
 *  `session.turn.run` yields in order. Records appends + approval responses. */
const fakeSession = (turns: SessionDispatchResult[], rec: Recorder): RuntimeSession => {
  let i = 0
  return {
    input: {
      append: async (text: string, opts: unknown) => {
        rec.appends.push({ text, opts })
      },
    },
    turn: {
      run: async () => {
        const t = turns[i++]
        if (t === undefined) throw new Error("fake session: turn queue exhausted")
        return t
      },
    },
    approval: {
      respond: async (id: string, decision: string) => {
        rec.responds.push({ id, decision })
      },
    },
  } as unknown as RuntimeSession
}

const turnPayload = (approvalReq?: { approvalId: string; reason: string }): SessionDispatchResult =>
  ({
    turn: {
      messages: [],
      outcome: OUTCOME,
      ...(approvalReq !== undefined ? { approvalRequest: approvalReq } : {}),
    },
  }) as unknown as SessionDispatchResult

describe("driveSessionTurn — behavioral contract", () => {
  test("no-approval turn: appends once (no image opts) and returns normalized result", async () => {
    const rec: Recorder = { appends: [], responds: [] }
    const result = await driveSessionTurn({
      session: fakeSession([turnPayload()], rec),
      resolveApproval: async () => "approve",
      text: "hello",
      turnSignal: new AbortController().signal,
    })
    expect(rec.appends).toHaveLength(1)
    expect(rec.appends[0]?.text).toBe("hello")
    // no images ⇒ the second arg is undefined (not an empty {images:[]})
    expect(rec.appends[0]?.opts).toBeUndefined()
    expect(rec.responds).toHaveLength(0)
    expect(result.messages).toEqual([])
    expect(result.outcome).toBe(OUTCOME)
    expect(result.outcomeReason).toBe("completed")
  })

  test("approval loop: resolves, responds, and re-runs until no approvalRequest", async () => {
    const rec: Recorder = { appends: [], responds: [] }
    let asked = 0
    const result = await driveSessionTurn({
      session: fakeSession(
        [turnPayload({ approvalId: "ap1", reason: "needs_it" }), turnPayload()],
        rec,
      ),
      resolveApproval: async () => {
        asked += 1
        return "approve"
      },
      text: "do it",
      turnSignal: new AbortController().signal,
    })
    expect(asked).toBe(1)
    expect(rec.responds).toEqual([{ id: "ap1", decision: "approve" }])
    expect(result.outcomeReason).toBe("completed")
  })

  test("deny throws the verbatim approval-denied error (fails closed)", async () => {
    const rec: Recorder = { appends: [], responds: [] }
    const run = driveSessionTurn({
      session: fakeSession(
        [turnPayload({ approvalId: "ap1", reason: "terminal.x" }), turnPayload()],
        rec,
      ),
      resolveApproval: async () => "deny",
      text: "x",
      turnSignal: new AbortController().signal,
    })
    await expect(run).rejects.toThrow("runtime session approval denied (terminal.x)")
    // it DID respond deny before throwing
    expect(rec.responds).toEqual([{ id: "ap1", decision: "deny" }])
  })

  test("missing turn payload throws the verbatim error", async () => {
    const rec: Recorder = { appends: [], responds: [] }
    const run = driveSessionTurn({
      session: fakeSession([{ turn: undefined } as SessionDispatchResult], rec),
      resolveApproval: async () => "approve",
      text: "x",
      turnSignal: new AbortController().signal,
    })
    await expect(run).rejects.toThrow("runtime session turn completed without a turn payload")
  })

  test("beforeTurn host hook fires BEFORE append", async () => {
    const order: string[] = []
    await driveSessionTurn({
      session: {
        input: {
          append: async () => {
            order.push("append")
          },
        },
        turn: { run: async () => turnPayload() },
        approval: { respond: async () => undefined },
      } as unknown as RuntimeSession,
      resolveApproval: async () => "approve",
      text: "x",
      turnSignal: new AbortController().signal,
      beforeTurn: () => order.push("beforeTurn"),
    })
    expect(order).toEqual(["beforeTurn", "append"])
  })

  test("passes images through as { images } when present", async () => {
    const rec: Recorder = { appends: [], responds: [] }
    const img = { type: "image", source: {} } as never
    await driveSessionTurn({
      session: fakeSession([turnPayload()], rec),
      resolveApproval: async () => "approve",
      text: "look",
      images: [img],
      turnSignal: new AbortController().signal,
    })
    expect(rec.appends[0]?.opts).toEqual({ images: [img] })
  })
})
