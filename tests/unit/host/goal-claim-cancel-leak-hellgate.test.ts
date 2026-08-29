/**
 * GOAL-08 round 4 (adversarial, kernel lens) — a goal claim placed by the
 * kernel must be released on EVERY path where the turn-runner never took it.
 *
 * Attack: `turn.cancel` lands in the commit window (after the claim, before
 * host start). The pre-aborted arm of runTurn RETURNS (it does not throw), so a
 * catch-only release leaked the claim: every later goal turn was refused
 * (`goal_attempt_claim_refused`) and the next PLAIN user turn took the orphan
 * claim and was charged as an autonomous attempt. Ground truth before the fix:
 * slot "claimed" after the aborted turn, autonomousTurnsStarted 1 after the
 * user turn. Fix: release keyed by attemptId in the dispatch `finally`.
 */

import { describe, expect, test } from "bun:test"
import { buildInteractiveTurnAssembler } from "@/host/runtime"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { createObjectiveAttemptSlot, createObjectiveAuthority } from "@/objective"
import type { PermissionContext } from "@/permission"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import type { AgentEvent, StreamPort } from "@/stream"
import { ToolRegistry } from "@/tool"

class FastLLM implements LLMPort {
  readonly model = "fast"
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "ok" } satisfies StreamEvent
    yield { type: "usage", inputTokens: 1, outputTokens: 1, model: "fast" } as never
    yield { type: "message_stop", stop_reason: "end_turn" } satisfies StreamEvent
  }
}
class NullStream implements StreamPort {
  emit(_event: AgentEvent): void {}
}

const harness = async () => {
  const authority = createObjectiveAuthority({ now: () => 1 })
  const slot = createObjectiveAttemptSlot()
  const { runtimeContext } = await createRuntimeFromAgentConfigBase({
    base: {
      llm: new FastLLM(),
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
  const submit = session.turn.submitGoalContinuation
  if (submit === undefined) throw new Error("submitGoalContinuation missing")
  const goalTurn = async (text: string) => {
    const domain = authority.readDomain(session.sessionId)
    return submit({
      text,
      expectedSessionRevision: (await session.snapshot()).revision,
      objectiveId: domain.state?.objective.objectiveId ?? "",
      objectiveRevision: domain.revision,
      validateCurrent: () => true,
    })
  }
  return { authority, slot, session, goalTurn }
}

describe("GOAL-08 round 4 — a cancelled-in-window goal turn never leaks its claim", () => {
  test("cancel on turn.started: slot empty after, next goal turn RUNS, plain user turn stays unattributed", async () => {
    const { authority, slot, session, goalTurn } = await harness()
    let cancelled = 0
    const unsub = session.subscribe((event) => {
      // `turn.started` is published from notifyCommitted — INSIDE the window
      // between the kernel claim and host start.
      if (cancelled === 0 && event.type === "turn.started") {
        cancelled += 1
        void session.turn.cancel().catch(() => undefined)
      }
    })
    const first = await goalTurn("first goal turn")
    unsub()
    expect(first.events.some((e) => e.type === "turn.aborted")).toBe(true)
    expect(slot.status().kind).toBe("empty")
    expect(authority.get(session.sessionId)?.attempts.autonomousTurnsStarted).toBe(0)

    // The next goal turn must run and be attributed — not `goal_attempt_claim_refused`.
    const second = await goalTurn("second goal turn")
    expect(second.events.some((e) => e.type === "turn.completed")).toBe(true)
    expect(authority.get(session.sessionId)?.attempts.autonomousTurnsStarted).toBe(1)
    expect(slot.status().kind).toBe("empty")

    // A plain user turn is never charged as a goal attempt.
    await session.input.append("plain user")
    await session.turn.run()
    const o = authority.get(session.sessionId)
    expect(o?.attempts.autonomousTurnsStarted).toBe(1)
    expect(authority.readDomain(session.sessionId).progressReceipts).toHaveLength(1)
  }, 20_000)

  test("paired control: without the cancel the first goal turn is attributed exactly once", async () => {
    const { authority, slot, session, goalTurn } = await harness()
    await goalTurn("first goal turn")
    expect(authority.get(session.sessionId)?.attempts.autonomousTurnsStarted).toBe(1)
    expect(slot.status().kind).toBe("empty")
  }, 20_000)

  test("the finally-release is keyed by attemptId: a refused kernel claim never clobbers a FOREIGN claim already in the slot", async () => {
    const { authority, slot, session, goalTurn } = await harness()
    const objectiveId = authority.get(session.sessionId)?.objectiveId ?? ""
    // Another claimer (a surface-side claim) holds the slot.
    expect(
      slot.claim({
        threadId: session.sessionId,
        objectiveId,
        startedRevision: authority.readDomain(session.sessionId).revision,
        attemptId: "foreign-claim",
        provenance: "user-requested-goal-work",
        executionMode: "foreground",
      }),
    ).toBe(true)
    await expect(goalTurn("goal turn")).rejects.toThrow(/goal_attempt_claim_refused/)
    const status = slot.status()
    expect(status.kind).toBe("claimed")
    if (status.kind === "claimed") expect(status.attempt.attemptId).toBe("foreign-claim")
  }, 20_000)
})
