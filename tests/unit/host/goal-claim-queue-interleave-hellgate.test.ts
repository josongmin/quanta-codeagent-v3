/**
 * GOAL-08 (round 3, adversarial) — a goal claim must bind to THE goal turn.
 *
 * Attack: a plain user turn is already queued behind a running turn; the wake
 * controller then claims + enqueues its goal turn. If the claim is made BEFORE
 * the serialized dispatch, the queued USER turn starts first and the turn-
 * runner's `take()` hands it the goal claim: the user's own turn is charged as
 * an autonomous attempt (hard-cap counter, receipt with autonomous provenance)
 * and the real goal turn dies on a revision conflict. The claim has to happen
 * inside the kernel's serialized dispatch, after the reducer guards, right
 * before that same turn runs — so a queued user turn can never take it.
 */

import { describe, expect, test } from "bun:test"
import { buildInteractiveTurnAssembler } from "@/host/runtime"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { createObjectiveAttemptSlot, createObjectiveAuthority } from "@/objective"
import type { PermissionContext } from "@/permission"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import type { AgentEvent, StreamPort } from "@/stream"
import { ToolRegistry } from "@/tool"

class GatedLLM implements LLMPort {
  readonly model = "gated"
  readonly seen: string[] = []
  private gate: Promise<void> = Promise.resolve()
  private open: () => void = () => {}
  /** Resolves when the NEXT stream() call has entered (deterministic sync point). */
  entered: Promise<void> = Promise.resolve()
  private markEntered: () => void = () => {}
  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve
    })
    this.entered = new Promise<void>((resolve) => {
      this.markEntered = resolve
    })
  }
  releaseGate(): void {
    this.open()
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.seen.push(JSON.stringify(input.messages))
    this.markEntered()
    await this.gate
    yield { type: "text_delta", delta: "ok" } satisfies StreamEvent
    yield { type: "usage", inputTokens: 1, outputTokens: 1, model: "gated" } as never
    yield { type: "message_stop", stop_reason: "end_turn" } satisfies StreamEvent
  }
}
class NullStream implements StreamPort {
  emit(_event: AgentEvent): void {}
}

const harness = async () => {
  const authority = createObjectiveAuthority({ now: () => 1 })
  const slot = createObjectiveAttemptSlot()
  const llm = new GatedLLM()
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
  authority.create(session.sessionId, { goal: "ship", successCriteria: ["c"] })
  return { authority, slot, llm, session }
}

describe("GOAL-08 round 3 — a queued user turn cannot take the goal claim", () => {
  test("running X + queued user A + goal B: A stays unattributed, B is the only attributed turn", async () => {
    const { authority, slot, llm, session } = await harness()
    const submit = session.turn.submitGoalContinuation
    if (submit === undefined) throw new Error("submitGoalContinuation missing")

    // X: a running user turn (LLM gated open later).
    llm.hold()
    await session.input.append("X")
    const x = session.turn.run()
    await llm.entered // X is inside the LLM call (past its turn-runner take)
    // A: a plain user turn queued behind X (enqueue chains on the tail + X's
    // in-flight window, so the order X → A.append → A.run → B is fixed).
    const aAppend = session.input.append("A", {}, { enqueue: true })
    const a = session.turn.run({}, { enqueue: true })
    // B: the goal turn, claimed + queued behind A.
    const domain = authority.readDomain(session.sessionId)
    const b = submit({
      text: "B goal",
      expectedSessionRevision: (await session.snapshot()).revision,
      objectiveId: domain.state?.objective.objectiveId ?? "",
      objectiveRevision: domain.revision,
      validateCurrent: () => true,
    })
    llm.releaseGate()
    await x
    await aAppend
    await a
    const bOutcome = await b.then(
      () => "ran",
      (e: unknown) => `refused:${(e as Error).message}`,
    )

    // B's expectedSessionRevision was read while X ran; A moved it ⇒ B is
    // refused with a typed revision conflict, and NOTHING may be attributed:
    // the user's turn A must never have taken B's claim.
    expect(bOutcome).toMatch(/^refused:.*revision/i)
    expect(authority.get(session.sessionId)?.attempts.autonomousTurnsStarted).toBe(0)
    expect(authority.readDomain(session.sessionId).progressReceipts ?? []).toHaveLength(0)
    expect(slot.status().kind).toBe("empty")

    // Two-sided: a goal turn submitted at a CURRENT revision is attributed —
    // the claim mechanism is live, it just binds to the right turn.
    const fresh = authority.readDomain(session.sessionId)
    await submit({
      text: "C goal",
      expectedSessionRevision: (await session.snapshot()).revision,
      objectiveId: fresh.state?.objective.objectiveId ?? "",
      objectiveRevision: fresh.revision,
      validateCurrent: () => true,
    })
    expect(authority.get(session.sessionId)?.attempts.autonomousTurnsStarted).toBe(1)
    expect(authority.readDomain(session.sessionId).progressReceipts ?? []).toHaveLength(1)
    expect(llm.seen.some((m) => m.includes("C goal"))).toBe(true)
    expect(llm.seen.some((m) => m.includes("B goal"))).toBe(false)
  }, 20_000)
})
