/**
 * ★ HELLGATE (P0-1) — a goal turn that PAUSES AT AN APPROVAL must still be
 * attributed after it resumes.
 *
 * MEASURED DEFECT (2026-08-30, probe): the approval pause SETTLES the attempt
 * (`turn-runner.ts` → `persistApprovalSettlement`, pinned by
 * `tests/unit/host/turn-runner-objective-settlement.test.ts`), and the daemon
 * resumes with a BARE `session.turn.run`
 * (`src/apps/web-daemon/server/approval-continuation.ts`), which never claims
 * (`tests/unit/kernel-turn-submit.test.ts` "turn.run … never claims"). So the
 * resumed body — the half of the goal turn that actually does the work — runs
 * outside the budget, the receipts and the autonomous hard cap.
 *
 * MEASURED, WORSE THAN THE ATTRIBUTION GAP: a `turn.submit` goal turn leaves
 * NO draft, so the daemon's resume (`session.turn.run`) is refused with
 * `empty_turn_input` — swallowed as "the benign duplicate case". The operator
 * approves and NOTHING runs: the approved goal work is silently abandoned.
 *
 * CONTRACT this pins: an approved goal turn RESUMES, and every executed goal
 * body is one attributed attempt — a pause plus a resume is two bodies ⇒ two
 * attempts, two receipts, and the resumed body's measured tokens on the budget.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { setupApprovalContinuation } from "@/apps/web-daemon/server/approval-continuation"
import { buildInteractiveTurnAssembler } from "@/host/runtime"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { createObjectiveAttemptSlot, createObjectiveAuthority } from "@/objective"
import type { PermissionContext, ToolAction } from "@/permission"
import { createRuntimeFromAgentConfigBase, type RuntimeSession } from "@/sdk/runtime"
import type { AgentEvent, StreamPort } from "@/stream"
import { type Tool, type ToolEvent, ToolRegistry } from "@/tool"

class ScriptedLLM implements LLMPort {
  readonly model = "stub-goal-approval"
  constructor(private readonly scripts: StreamEvent[][]) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    for (const ev of this.scripts.shift() ?? [{ type: "message_stop", stop_reason: "end_turn" }])
      yield ev
  }
}
class NullStream implements StreamPort {
  emit(_event: AgentEvent): void {}
}

const callTool = (id: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "danger" } as never,
  { type: "tool_use_end", id, input: {} } as never,
  { type: "usage", inputTokens: 5, outputTokens: 3, model: "stub" } as never,
  { type: "message_stop", stop_reason: "tool_use" } as never,
]
/** The resumed body: real work, real tokens. */
const finishing: StreamEvent[] = [
  { type: "text_delta", delta: "done" } as never,
  { type: "usage", inputTokens: 40, outputTokens: 20, model: "stub" } as never,
  { type: "message_stop", stop_reason: "end_turn" } as never,
]

const mutatingTool = (counts: { n: number }): Tool => ({
  name: "danger",
  description: "danger",
  inputSchema: z.object({}).passthrough() as never,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "pre-approval-ok",
  async *execute(): AsyncIterable<ToolEvent> {
    counts.n += 1
    yield { type: "result", result: { ok: true, output: "ran" } } as never
  },
})

const liveProxy = (): PermissionContext => {
  let m: PermissionContext["mode"] = "default"
  return {
    get mode() {
      return m
    },
    set mode(next) {
      m = next
    },
  } as PermissionContext
}

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const boot = async () => {
  const authority = createObjectiveAuthority({ now: () => 7 })
  const slot = createObjectiveAttemptSlot()
  const counts = { n: 0 }
  const confirmSlot = {
    current: async (_action?: ToolAction): Promise<boolean> => {
      throw new Error("surface onConfirm must not be reached under the approval protocol")
    },
  }
  const { runtime } = await createRuntimeFromAgentConfigBase({
    base: {
      llm: new ScriptedLLM([callTool("t1"), callTool("t1b"), finishing, finishing]),
      registry: new ToolRegistry([mutatingTool(counts)]),
      stream: new NullStream(),
      permission: liveProxy(),
      messages: [],
      system: "system",
      cwd: "/tmp",
      maxTurns: 6,
      signal: new AbortController().signal,
      hitl: { enabled: true },
      onConfirm: async (action: ToolAction) => confirmSlot.current(action),
      approvalProtocol: { confirmSlot },
      objective: authority,
      objectiveAttemptSlot: slot,
    } as never,
    turnAssembler: buildInteractiveTurnAssembler({}, {}),
    history: [],
    state: undefined,
    idMeta: undefined,
    shutdown: async () => undefined,
  })
  const session: RuntimeSession = await runtime.createSession({
    cwd: "/tmp",
    permissionMode: "default",
  })
  // The PRODUCTION resume wiring (gate ON, exactly as the daemon composes it).
  const continuation = setupApprovalContinuation(session, {
    QUANTA_INLINE_APPROVAL_RESOLVER: "1",
  })
  authority.create(session.sessionId, { goal: "ship", successCriteria: ["c"] })
  cleanup = async () => {
    continuation.unsub?.()
    await session.close()
    await runtime.close()
  }
  return { authority, slot, session, counts }
}

const until = async (pred: () => boolean, timeoutMs = 5_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return pred()
}

describe("P0-1 — a goal turn that pauses at an approval stays attributed", () => {
  test("the post-approval body is charged: two attempts, two receipts, its tokens on the budget", async () => {
    const { authority, slot, session, counts } = await boot()
    const domain = authority.readDomain(session.sessionId)
    const submit = session.turn.submitGoalContinuation
    if (submit === undefined) throw new Error("submitGoalContinuation missing")

    const paused = await submit({
      text: "pursue the goal",
      expectedSessionRevision: (await session.snapshot()).revision,
      objectiveId: domain.state?.objective.objectiveId ?? "",
      objectiveRevision: domain.revision,
      validateCurrent: () => true,
    })
    const approvalId = paused.turn?.approvalRequest?.approvalId
    expect(approvalId).toBeDefined()
    const atPause = authority.get(session.sessionId)
    expect(atPause?.attempts.autonomousTurnsStarted).toBe(1)
    expect(authority.readDomain(session.sessionId).progressReceipts).toHaveLength(1)
    const tokensAtPause = atPause?.budget.tokensUsed ?? 0

    // MEASURED (2026-08-30): at this point draftInput is "" — `turn.submit`
    // never populates a draft — so the daemon's resume `turn.run` dies with
    // `empty_turn_input`, which its catch logs as "the benign duplicate case".
    // Approve → the daemon's own continuation fires the resumed body.
    await session.approval.respond(approvalId as string, "approve")
    // The approved work must actually RESUME and the approved tool must RUN.
    expect(await until(() => counts.n > 0)).toBe(true)
    expect(
      await until(
        () => (authority.readDomain(session.sessionId).progressReceipts?.length ?? 0) > 1,
      ),
    ).toBe(true)

    const after = authority.get(session.sessionId)
    expect(after?.attempts.autonomousTurnsStarted).toBe(2)
    expect(authority.readDomain(session.sessionId).progressReceipts).toHaveLength(2)
    expect(after?.budget.tokensUsed ?? 0).toBeGreaterThan(tokensAtPause)
    expect(after?.budget.turnsUsed).toBe(2)
    expect(slot.status().kind).toBe("empty")

    // ...and the record must not outlive the resume: the NEXT ordinary user
    // turn must stay unattributed (a lingering paused-turn provenance would
    // re-claim it and charge the operator's own turn to the goal).
    await session.input.append("plain user work")
    await session.turn.run()
    const afterUserTurn = authority.get(session.sessionId)
    expect(afterUserTurn?.attempts.autonomousTurnsStarted).toBe(2)
    expect(afterUserTurn?.budget.turnsUsed).toBe(2)
    expect(authority.readDomain(session.sessionId).progressReceipts).toHaveLength(2)
  }, 30_000)
})
