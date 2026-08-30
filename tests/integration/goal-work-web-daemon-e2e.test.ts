/**
 * GOAL-08 rail 15 (web half) — a web client's `/goal work` runs a REAL turn
 * that is attributed as USER-REQUESTED: it charges the user turn budget and
 * mints a receipt, but never the autonomous hard-cap counter. Refusals are
 * TYPED and reach the client on the same socket (never "queued then silently
 * dropped" — the round-4 CLI lesson).
 *
 * Runs through the production composition: the daemon goal-work handler over a
 * real runtime facade (real objective authority + attempt slot + host adapter +
 * kernel claim), driven by the raw WS frame consumer.
 */

import { describe, expect, test } from "bun:test"
import { composeWebGoalWork } from "@/apps/web-daemon/goal-work-compose"
import { consumeGoalWorkFrame } from "@/apps/web-daemon/server/ws-handlers"
import { buildInteractiveTurnAssembler } from "@/host/runtime"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { createObjectiveAttemptSlot, createObjectiveAuthority } from "@/objective"
import type { PermissionContext } from "@/permission"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import type { AgentEvent, StreamPort } from "@/stream"
import { ToolRegistry } from "@/tool"

class EchoLLM implements LLMPort {
  readonly model = "echo"
  readonly seen: string[] = []
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.seen.push(JSON.stringify(input.messages))
    yield { type: "text_delta", delta: "ok" } satisfies StreamEvent
    yield { type: "usage", inputTokens: 4, outputTokens: 2, model: "echo" } as never
    yield { type: "message_stop", stop_reason: "end_turn" } satisfies StreamEvent
  }
}
class NullStream implements StreamPort {
  emit(_event: AgentEvent): void {}
}

const fakeWs = () => {
  const sent: string[] = []
  return {
    ws: { send: (data: string) => sent.push(data) } as never,
    replies: () => sent.map((raw) => JSON.parse(raw) as Record<string, unknown>),
  }
}

const harness = async () => {
  const authority = createObjectiveAuthority({ now: () => 1 })
  const slot = createObjectiveAttemptSlot()
  const llm = new EchoLLM()
  const { runtimeContext } = await createRuntimeFromAgentConfigBase({
    base: {
      llm,
      registry: new ToolRegistry([]),
      stream: new NullStream(),
      permission: { mode: "acceptEdits" } as PermissionContext,
      messages: [],
      system: "test",
      cwd: "/tmp",
      maxTurns: 8,
      signal: new AbortController().signal,
      objective: authority,
      objectiveAttemptSlot: slot,
    },
    turnAssembler: buildInteractiveTurnAssembler({}, {}),
    history: [],
    state: undefined,
    idMeta: undefined,
    shutdown: async () => undefined,
  })
  const runtime = await runtimeContext.createRuntimeFacade({
    history: [],
    state: undefined,
    idMeta: undefined,
    shutdown: async () => undefined,
    mcpClients: [],
  })
  const session = await runtime.createSession({ cwd: "/tmp", permissionMode: "acceptEdits" })
  const composed = composeWebGoalWork({
    session,
    runtime: { objectiveAuthority: authority, objectiveAttemptSlot: slot },
  })
  if (composed === undefined) throw new Error("goal work handler not composed")
  return { authority, slot, session, llm, goalWork: composed }
}

const frame = (text: string): string => JSON.stringify({ kind: "goalWork", text })

describe("GOAL-08 rail 15 — web goal work", () => {
  test("active goal: the frame is consumed, the turn RUNS with user provenance, the counter stays 0", async () => {
    const { authority, slot, session, llm, goalWork } = await harness()
    authority.create(session.sessionId, { goal: "ship", successCriteria: ["c"] })
    const { ws, replies } = fakeWs()
    expect(consumeGoalWorkFrame(ws, { goalWork }, frame("fix the flake"))).toBe(true)
    await goalWork.settled()
    const o = authority.get(session.sessionId)
    expect(o?.budget.turnsUsed).toBe(1)
    expect(o?.attempts.autonomousTurnsStarted).toBe(0)
    const receipts = authority.readDomain(session.sessionId).progressReceipts ?? []
    expect(receipts).toHaveLength(1)
    expect(llm.seen.some((m) => m.includes("fix the flake"))).toBe(true)
    // The attempt was claimed (the receipt proves it) and RELEASED by settle.
    expect(slot.status().kind).toBe("empty")
    expect(replies()).toEqual([{ kind: "goalWorkResult", ok: true, status: "accepted" }])
  }, 20_000)

  test("no active goal ⇒ typed refusal on the same socket, no turn", async () => {
    const { authority, session, llm, goalWork } = await harness()
    const { ws, replies } = fakeWs()
    expect(consumeGoalWorkFrame(ws, { goalWork }, frame("anything"))).toBe(true)
    await goalWork.settled()
    expect(llm.seen).toEqual([])
    expect(authority.readDomain(session.sessionId).progressReceipts ?? []).toHaveLength(0)
    expect(replies()).toHaveLength(1)
    expect(replies()[0]).toMatchObject({ kind: "goalWorkResult", ok: false })
    expect(String(replies()[0]?.reason)).toContain("not active")
  })

  test("fail-stopped attempt slot ⇒ typed refusal BEFORE any turn (parity with the CLI)", async () => {
    const { authority, slot, session, llm, goalWork } = await harness()
    authority.create(session.sessionId, { goal: "ship", successCriteria: ["c"] })
    slot.failStop("disk full", authority.get(session.sessionId)?.objectiveId)
    const { ws, replies } = fakeWs()
    expect(consumeGoalWorkFrame(ws, { goalWork }, frame("anything"))).toBe(true)
    await goalWork.settled()
    expect(llm.seen).toEqual([])
    expect(replies()).toHaveLength(1)
    expect(replies()[0]).toMatchObject({ kind: "goalWorkResult", ok: false })
    expect(String(replies()[0]?.reason)).toContain("fail-stopped")
  })

  test("over-long text ⇒ typed refusal (bounded like every other web mutation)", async () => {
    const { authority, session, llm, goalWork } = await harness()
    authority.create(session.sessionId, { goal: "ship", successCriteria: ["c"] })
    const { ws, replies } = fakeWs()
    expect(consumeGoalWorkFrame(ws, { goalWork }, frame("x".repeat(4001)))).toBe(true)
    await goalWork.settled()
    expect(llm.seen).toEqual([])
    expect(replies()).toHaveLength(1)
    expect(replies()[0]).toMatchObject({ kind: "goalWorkResult", ok: false })
    expect(String(replies()[0]?.reason)).toContain("too long")
  })

  // REVERSED (2026-08-30): the not-composed case used to fall through
  // "byte-identically", which was a silent drop — the adapter cannot decode a
  // `goalWork` frame, and the client has no timeout. A frame this daemon owns is
  // answered; only a FOREIGN frame falls through.
  test("no handler composed ⇒ answered; a foreign frame ⇒ NOT consumed (falls through)", async () => {
    const { goalWork } = await harness()
    const { ws: notComposed, replies: notComposedReplies } = fakeWs()
    expect(consumeGoalWorkFrame(notComposed, {}, frame("x"))).toBe(true)
    expect(notComposedReplies()).toHaveLength(1)
    expect(notComposedReplies()[0]).toMatchObject({ kind: "goalWorkResult", ok: false })

    const { ws: foreign, replies: foreignReplies } = fakeWs()
    expect(consumeGoalWorkFrame(foreign, { goalWork }, JSON.stringify({ kind: "connect" }))).toBe(
      false,
    )
    expect(foreignReplies()).toEqual([])
  })
})
