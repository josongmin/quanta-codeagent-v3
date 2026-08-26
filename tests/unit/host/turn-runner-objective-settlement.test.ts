/**
 * GOAL-04 hellgate — `runRuntimeTurn` settles an attributed objective attempt:
 * begin (durable) BEFORE the provider call, measured usage, one typed settlement
 * per terminal path, fail-stop on lost durability, and NO objective movement for
 * ordinary (unattributed) chat.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { buildInteractiveTurnAssembler } from "@/host/runtime/agent-config-assembler"
import { RuntimeApprovalRequiredError } from "@/host/runtime/internal/context-binding/approval-support"
import {
  beginObjectiveAttempt,
  createTurnUsageAccumulator,
  SETTLEMENT_OUTCOME,
} from "@/host/runtime/internal/context-binding/objective-settlement"
import { runRuntimeTurn } from "@/host/runtime/internal/context-binding/turn-runner"
import type { RuntimeBase } from "@/host/runtime/internal/context-binding/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  createObjectiveAttemptSlot,
  createObjectiveAuthority,
  createObjectiveCapabilities,
  type ObjectiveAttemptContext,
  type ObjectiveAttemptSlot,
  type ObjectivePort,
  PROGRESS_TURN_OUTCOMES,
} from "@/objective"
import { loadSessionById, saveSessionById } from "@/session"
import { __resetRuntimeConfig, LLMError } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { type Tool, ToolRegistry } from "@/tool"

type Step =
  | { readonly kind: "events"; readonly events: StreamEvent[] }
  | { readonly kind: "throw" }
  | { readonly kind: "throw-plain" }

class ScriptedLLM implements LLMPort {
  calls = 0
  readonly model = "scripted-test-model"
  private cursor = 0
  private readonly steps: Step[]
  constructor(steps: Step[]) {
    this.steps = [...steps]
  }
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const step = this.steps[Math.min(this.cursor, this.steps.length - 1)]
    this.cursor += 1
    if (step === undefined) throw new LLMError("script exhausted")
    if (step.kind === "throw") throw new LLMError("400 boom — forced error turn")
    if (step.kind === "throw-plain") throw new Error("adapter exploded (not an LLMError)")
    for (const e of step.events) yield e
  }
}

class NullStream implements StreamPort {
  emit(_event: AgentEvent): void {}
}

const completing = (
  tokens: { input: number; output: number } = { input: 30, output: 12 },
): Step => ({
  kind: "events",
  events: [
    { type: "text_delta", delta: "done" },
    {
      type: "usage",
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      model: "scripted",
    } as never,
    { type: "message_stop", stop_reason: "end_turn" },
  ],
})

const makeBase = (over: Partial<RuntimeBase> = {}): RuntimeBase =>
  ({
    llm: new ScriptedLLM([completing()]),
    registry: new ToolRegistry([]),
    stream: new NullStream(),
    permission: { mode: "acceptEdits" },
    system: "test-system",
    cwd: "/tmp",
    maxTurns: 3,
    signal: new AbortController().signal,
    onConfirm: async () => false,
    ...over,
  }) as unknown as RuntimeBase

/** Production parity: the CLI preset and the web-daemon both assemble the turn
 *  through this assembler, which is what mints the authoritative BudgetMeter. */
const turnAssembler = buildInteractiveTurnAssembler({}, {})

const setup = (over: Partial<RuntimeBase> = {}) => {
  const authority = createObjectiveAuthority({ now: () => 7 })
  authority.create("thread-1", { goal: "ship", successCriteria: ["c"] })
  const slot = createObjectiveAttemptSlot()
  const base = makeBase({
    objective: authority as ObjectivePort,
    objectiveAttemptSlot: slot,
    ...over,
  })
  const claim = (over2: Partial<ObjectiveAttemptContext> = {}): boolean =>
    slot.claim({
      threadId: "thread-1",
      objectiveId: authority.get("thread-1")?.objectiveId ?? "",
      startedRevision: authority.readDomain("thread-1").revision,
      attemptId: "attempt-1",
      provenance: "autonomous-continuation",
      executionMode: "foreground",
      ...over2,
    })
  const run = () =>
    runRuntimeTurn({
      base,
      turnAssembler,
      history: [],
      prompt: "go",
      state: undefined,
      idMeta: undefined,
    })
  return { authority, slot, base, claim, run }
}

describe("GOAL-04 — runRuntimeTurn attributed settlement", () => {
  test("ordinary chat (no claim) moves no objective tokens, turns or receipts", async () => {
    const { authority, run } = setup()
    const before = authority.readDomain("thread-1")
    const result = await run()
    expect(result.outcome.reason).toBe("completed")
    expect(authority.readDomain("thread-1")).toEqual(before)
    expect(authority.get("thread-1")?.budget.tokensUsed).toBe(0)
    expect(authority.get("thread-1")?.budget.turnsUsed).toBe(0)
  })

  test("an autonomous claim: begin before the provider, measured tokens, one receipt, slot consumed", async () => {
    const { authority, slot, run, claim } = setup()
    expect(claim()).toBe(true)
    const result = await run()
    expect(result.outcome.reason).toBe("completed")
    const o = authority.get("thread-1")
    expect(o?.budget.turnsUsed).toBe(1)
    expect(o?.attempts.autonomousTurnsStarted).toBe(1)
    expect(o?.budget.tokensUsed).toBe(42) // 30 input + 12 output, reasoning not double-counted
    expect(o?.attempts.started).toBeUndefined()
    const receipts = authority.readDomain("thread-1").progressReceipts ?? []
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.attemptKey).toBe("attempt-1")
    expect(receipts[0]?.turnOutcome).toBe("completed")
    expect(slot.status().kind).toBe("empty")
  })

  test("user-requested goal work charges the turn but not the autonomous counter", async () => {
    const { authority, run, claim } = setup()
    claim({ provenance: "user-requested-goal-work", attemptId: "user-1" })
    await run()
    expect(authority.get("thread-1")?.budget.turnsUsed).toBe(1)
    expect(authority.get("thread-1")?.attempts.autonomousTurnsStarted).toBe(0)
  })

  test("a provider throw settles exactly once as `error` (no re-debit, no orphan)", async () => {
    const { authority, run, claim } = setup({ llm: new ScriptedLLM([{ kind: "throw" }]) })
    claim()
    const result = await run()
    expect(result.outcome.reason).toBe("error")
    const o = authority.get("thread-1")
    expect(o?.budget.turnsUsed).toBe(1)
    expect(o?.attempts.started).toBeUndefined()
    expect(authority.readDomain("thread-1").progressReceipts?.[0]?.turnOutcome).toBe("error")
  })

  test("a stale claim (objective replaced after the claim) is NOT charged to the new generation", async () => {
    const { authority, run, claim } = setup()
    claim()
    createObjectiveCapabilities(authority).user.commit("thread-1", {
      kind: "replace",
      definition: { goal: "new" },
    })
    await run()
    expect(authority.get("thread-1")?.budget.turnsUsed).toBe(0)
    expect(authority.readDomain("thread-1").progressReceipts ?? []).toHaveLength(0)
  })

  test("the same attemptId cannot be settled twice (second turn with a replayed claim is refused durably)", async () => {
    const { authority, run, claim, slot } = setup()
    claim()
    await run()
    expect(claim()).toBe(true) // the slot itself is free again
    // The authority refuses the replayed begin; the runtime refuses to run the
    // paid call on an unreserved attempt (loud, before the provider) and never
    // charges twice.
    await expect(run()).rejects.toThrow(/attempt-replayed/)
    expect(authority.get("thread-1")?.budget.turnsUsed).toBe(1)
    expect(authority.readDomain("thread-1").progressReceipts ?? []).toHaveLength(1)
    expect(slot.status().kind).toBe("empty")
  }, 20_000)

  test("begin persistence failure fail-stops the slot and the provider is never called", async () => {
    const llm = new ScriptedLLM([completing()])
    const { slot, claim, base } = setup({ llm })
    claim()
    // Id-mode with a session id that was never persisted ⇒ durable start impossible.
    await expect(
      runRuntimeTurn({
        base,
        turnAssembler,
        history: [],
        prompt: "go",
        state: undefined,
        idMeta: {
          id: "never-persisted-session",
          title: "t",
          cwd: "/tmp",
          createdAt: 1,
          lastTouched: 1,
          archived: false,
        },
      }),
    ).rejects.toThrow(/not durable/)
    expect(llm.calls).toBe(0)
    expect(slot.status().kind).toBe("fail-stopped")
    expect(
      slot.claim({
        threadId: "thread-1",
        objectiveId: "x",
        startedRevision: 1,
        attemptId: "z",
        provenance: "autonomous-continuation",
        executionMode: "foreground",
      }),
    ).toBe(false)
  })

  test("a non-LLM adapter throw is normalized by the loop and still settles exactly once as `error`", async () => {
    const { authority, run, claim } = setup({ llm: new ScriptedLLM([{ kind: "throw-plain" }]) })
    claim()
    const result = await run()
    expect(result.outcome.reason).toBe("error")
    const o = authority.get("thread-1")
    expect(o?.attempts.started).toBeUndefined()
    expect(o?.budget.turnsUsed).toBe(1)
    const receipts = authority.readDomain("thread-1").progressReceipts ?? []
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.turnOutcome).toBe("error")
  })

  test("an approval pause durably settles once as `awaiting_approval` and returns the request", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "goal04-approval-"))
    const priorSessionsDir = process.env.QUANTA_SESSIONS_DIR
    process.env.QUANTA_SESSIONS_DIR = sessionsDir
    __resetRuntimeConfig()
    const mutating: Tool = {
      name: "write_thing",
      description: "mutates",
      inputSchema: z.object({ path: z.string() }) as z.ZodType<unknown>,
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      execute: async function* () {
        yield { type: "result", result: { ok: true, output: "never runs" } } as never
      },
    }
    const llm = new ScriptedLLM([
      {
        kind: "events",
        events: [
          { type: "tool_use_start", id: "t1", name: "write_thing" },
          { type: "tool_use_end", id: "t1", input: { path: "a.txt" } },
          { type: "usage", inputTokens: 5, outputTokens: 3, model: "scripted" } as never,
          { type: "message_stop", stop_reason: "tool_use" },
        ],
      },
    ])
    const meta = {
      id: "goal04-approval",
      title: "goal approval",
      cwd: "/tmp",
      createdAt: 1,
      lastTouched: 1,
      archived: false,
    }
    try {
      await saveSessionById(meta, { reason: "seed", turns: 0, messages: [] })
      const { authority, slot, base, claim } = setup({
        llm,
        registry: new ToolRegistry([mutating]),
        permission: { mode: "default" },
        onConfirm: async () => {
          throw new RuntimeApprovalRequiredError({
            approvalId: "ap-1",
            reason: "write_thing needs approval",
            requestedAt: "2026-08-26T00:00:00.000Z",
          })
        },
      } as unknown as Partial<RuntimeBase>)
      claim()
      const result = await runRuntimeTurn({
        base,
        turnAssembler,
        history: [],
        prompt: "go",
        state: undefined,
        idMeta: meta,
      })
      expect(result.approvalRequest?.approvalId).toBe("ap-1")
      expect(result.outcome.reason).toBe("awaiting_approval")
      expect(authority.get("thread-1")?.attempts.started).toBeUndefined()
      expect(authority.get("thread-1")?.budget.turnsUsed).toBe(1)
      expect(authority.readDomain("thread-1").progressReceipts?.[0]?.turnOutcome).toBe(
        "awaiting_approval",
      )
      expect(slot.status().kind).toBe("empty")
      const saved = await loadSessionById(meta.id)
      if (saved?.objective?.version !== 2) throw new Error("expected persisted v2 objective")
      const persistedObjective = saved.objective.threads[0]?.objective
      expect(persistedObjective?.progressReceipts?.[0]?.turnOutcome).toBe("awaiting_approval")
      expect(persistedObjective?.attempts?.started).toBeUndefined()
    } finally {
      if (priorSessionsDir === undefined) delete process.env.QUANTA_SESSIONS_DIR
      else process.env.QUANTA_SESSIONS_DIR = priorSessionsDir
      __resetRuntimeConfig()
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  test("terminal persistence failure AFTER settlement keeps the receipt and fail-stops the slot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal04-persist-"))
    const notADir = join(dir, "file.txt")
    writeFileSync(notADir, "x")
    const { authority, slot, claim, base } = setup()
    claim()
    await expect(
      runRuntimeTurn({
        base,
        turnAssembler,
        history: [],
        prompt: "go",
        // path-mode transcript whose parent is a FILE ⇒ save throws after settlement
        state: join(notADir, "session.json"),
        idMeta: undefined,
      }),
    ).rejects.toThrow()
    // Settled (never refunded), then durably uncertain ⇒ fail-stopped.
    expect(authority.get("thread-1")?.budget.turnsUsed).toBe(1)
    expect(authority.get("thread-1")?.attempts.started).toBeUndefined()
    expect(authority.readDomain("thread-1").progressReceipts ?? []).toHaveLength(1)
    expect(slot.status().kind).toBe("fail-stopped")
    expect(claim({ attemptId: "attempt-2" })).toBe(false)
  })

  test("rail 13 — an attributed attempt without a BudgetMeter is a composition error (nothing reserved)", async () => {
    const authority = createObjectiveAuthority({ now: () => 7 })
    authority.create("thread-1", { goal: "ship", successCriteria: ["c"] })
    const slot = createObjectiveAttemptSlot()
    const attempt: ObjectiveAttemptContext = {
      threadId: "thread-1",
      objectiveId: authority.get("thread-1")?.objectiveId ?? "",
      startedRevision: 1,
      attemptId: "a",
      provenance: "autonomous-continuation",
      executionMode: "foreground",
    }
    slot.claim(attempt)
    let persisted = 0
    await expect(
      beginObjectiveAttempt({
        objective: authority,
        objectiveAttemptSlot: slot,
        budgetMeter: undefined,
        persistStart: async () => {
          persisted += 1
        },
      }),
    ).rejects.toThrow(/BudgetMeter/)
    expect(persisted).toBe(0)
    expect(authority.get("thread-1")?.budget.turnsUsed).toBe(0)
    expect(authority.get("thread-1")?.attempts.started).toBeUndefined()
    expect(slot.status().kind).toBe("fail-stopped")
    expect(slot.claim(attempt)).toBe(false)
    slot.recover()
    // The explicit legacy opt-in (test adapters) still works.
    slot.claim(attempt)
    const legacy = await beginObjectiveAttempt({
      objective: authority,
      objectiveAttemptSlot: slot,
      budgetMeter: undefined,
      persistStart: undefined,
      usageSource: "legacy-stream-events",
    })
    expect(legacy?.attempt.attemptId).toBe("a")
    expect(authority.get("thread-1")?.budget.turnsUsed).toBe(1)
  })

  test("legacy stream-usage accumulator counts input + output once (reasoning is inside output; cache excluded)", () => {
    const acc = createTurnUsageAccumulator()
    acc.observe({ type: "text_delta", delta: "x" } as never)
    acc.observe({
      type: "usage",
      inputTokens: 30,
      outputTokens: 12,
      reasoningTokens: 8,
      cacheReadTokens: 100,
      model: "m",
    } as never)
    acc.observe({ type: "usage", inputTokens: Number.NaN, outputTokens: -5, model: "m" } as never)
    expect(acc.total()).toBe(42)
  })

  test("rail 15 — every StopReason maps to exactly one closed ProgressTurnOutcome", () => {
    const stopReasons = [
      "completed",
      "max_turns",
      "aborted",
      "error",
      "budget_exhausted",
      "refusal",
      "awaiting_approval",
    ]
    expect(Object.keys(SETTLEMENT_OUTCOME).sort()).toEqual([...stopReasons].sort())
    for (const v of Object.values(SETTLEMENT_OUTCOME)) {
      expect(PROGRESS_TURN_OUTCOMES).toContain(v)
    }
  })

  test("a fail-stopped slot refuses new claims until an operator recovers it", () => {
    const slot: ObjectiveAttemptSlot = createObjectiveAttemptSlot()
    slot.failStop("uncertain")
    expect(
      slot.claim({
        threadId: "t",
        objectiveId: "o",
        startedRevision: 1,
        attemptId: "a",
        provenance: "autonomous-continuation",
        executionMode: "foreground",
      }),
    ).toBe(false)
    slot.recover()
    expect(
      slot.claim({
        threadId: "t",
        objectiveId: "o",
        startedRevision: 1,
        attemptId: "a",
        provenance: "autonomous-continuation",
        executionMode: "foreground",
      }),
    ).toBe(true)
  })
})
