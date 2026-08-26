/**
 * GOAL-08 — END-TO-END attribution on the daemon/SDK path: a goal turn
 * submitted through the RuntimeSession host verb is claimed on the REAL
 * session-host adapter, begun by the host turn-runner (durable start), and
 * settled with measured usage — budget, receipts and the autonomous hard-cap
 * counter move exactly once. User-requested goal work moves the turn budget
 * but never the autonomous counter.
 */

import { describe, expect, test } from "bun:test"
import { buildInteractiveTurnAssembler } from "@/host/runtime"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { createObjectiveAttemptSlot, createObjectiveAuthority } from "@/objective"
import type { PermissionContext } from "@/permission"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import type { AgentEvent, StreamPort } from "@/stream"
import { ToolRegistry } from "@/tool"

class ScriptedLLM implements LLMPort {
  readonly model = "scripted"
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "done" } satisfies StreamEvent
    yield { type: "usage", inputTokens: 7, outputTokens: 3, model: "scripted" } as never
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
      llm: new ScriptedLLM(),
      registry: new ToolRegistry([]),
      stream: new NullStream(),
      permission: { mode: "acceptEdits" } as PermissionContext,
      messages: [],
      system: "test",
      cwd: "/tmp",
      maxTurns: 4,
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
  return { authority, slot, session }
}

describe("GOAL-08 — web/SDK goal turn is attributed end to end", () => {
  test("autonomous continuation: one begin + one settle, autonomous counter 1, measured tokens", async () => {
    const { authority, slot, session } = await harness()
    const submit = session.turn.submitGoalContinuation
    if (submit === undefined) throw new Error("submitGoalContinuation missing")
    const domain = authority.readDomain(session.sessionId)
    await submit({
      text: "continue the goal",
      expectedSessionRevision: (await session.snapshot()).revision,
      objectiveId: domain.state?.objective.objectiveId ?? "",
      objectiveRevision: domain.revision,
      validateCurrent: () => true,
    })
    const o = authority.get(session.sessionId)
    expect(o?.budget.turnsUsed).toBe(1)
    expect(o?.attempts.autonomousTurnsStarted).toBe(1)
    expect(o?.attempts.started).toBeUndefined()
    expect(o?.budget.tokensUsed).toBe(10)
    const receipts = authority.readDomain(session.sessionId).progressReceipts ?? []
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.turnOutcome).toBe("completed")
    expect(slot.status().kind).toBe("empty")
  })

  test("user-requested goal work: turn budget moves, the autonomous counter does not", async () => {
    const { authority, session } = await harness()
    const work = session.turn.submitGoalWork
    if (work === undefined) throw new Error("submitGoalWork missing")
    const domain = authority.readDomain(session.sessionId)
    await work({
      text: "fix the flake",
      expectedSessionRevision: (await session.snapshot()).revision,
      objectiveId: domain.state?.objective.objectiveId ?? "",
      objectiveRevision: domain.revision,
      validateCurrent: () => true,
    })
    const o = authority.get(session.sessionId)
    expect(o?.budget.turnsUsed).toBe(1)
    expect(o?.attempts.autonomousTurnsStarted).toBe(0)
    expect(authority.readDomain(session.sessionId).progressReceipts).toHaveLength(1)
  })
})
