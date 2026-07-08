/**
 * Phase-1 loop decomposition — turn-outcome resolver (multi-turn plane).
 *
 * Pins TurnResult → TurnLoopResolution routing without running the full loop.
 */

import { describe, expect, test } from "bun:test"
import { BudgetMeter } from "@/agent/budget"
import { resolveTurnLoopOutcome, shouldParkOnGate } from "@/agent/loop/turn-outcome"
import { createInMemoryPlanStore } from "@/agent/plan/state"
import type { RunAgentContext, TurnResult } from "@/agent/loop/types"
import type { AgentConfig } from "@/agent/types"
import type { Message } from "@/llm"
import { createWorkingMemory } from "@/memory"
import type { AgentEvent, StreamPort } from "@/stream"
import { SubagentTurnGate } from "@/subagent"
import { ToolRegistry } from "@/tool"

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const assistantText = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

/** A real BudgetMeter already over its turn dial ⇒ `checkExhausted()` reports
 *  `{ exhausted: true, kind: "turn" }`. */
const exhaustedTurnMeter = (): BudgetMeter => {
  const meter = new BudgetMeter({ dials: { maxTurns: 0 } })
  meter.tick("turn")
  return meter
}

const baseArgs = (overrides?: {
  result?: TurnResult
  turn?: number
  stream?: RecordingStream
  budgetExhausted?: boolean
}) => {
  const stream = overrides?.stream ?? new RecordingStream()
  const wm = createWorkingMemory<Message>()
  const pendingPlanExitRef: { current: never[] } = { current: [] }
  const pendingPlanEntryRef: { current: never[] } = { current: [] }
  const hookPromptPending: never[] = []
  const cfg: AgentConfig = {
    llm: { stream: async function* () {} },
    registry: new ToolRegistry([]),
    stream,
    permission: { mode: "default" },
    messages: [],
    system: "",
    cwd: "/tmp",
    maxTurns: 10,
    signal: new AbortController().signal,
    ...(overrides?.budgetExhausted === true ? { budgetMeter: exhaustedTurnMeter() } : {}),
  }
  return {
    cfg,
    stream,
    wm,
    breaker: undefined,
    recorder: undefined,
    turn: overrides?.turn ?? 3,
    result: overrides?.result ?? ({ kind: "completed" } as TurnResult),
    pendingPlanExitRef,
    pendingPlanEntryRef,
    hookPromptPending,
  }
}

describe("resolveTurnLoopOutcome", () => {
  test("aborted ⇒ finish aborted with turn-1 accounting", async () => {
    const resolution = await resolveTurnLoopOutcome(
      baseArgs({ result: { kind: "aborted" }, turn: 5 }),
    )
    expect(resolution).toEqual({
      kind: "finish",
      reason: "aborted",
      turns: 4,
      stopCategory: expect.objectContaining({ kind: "interrupted" }),
    })
  })

  test("interrupted ⇒ park (ADR-0437)", async () => {
    const resolution = await resolveTurnLoopOutcome(
      baseArgs({ result: { kind: "interrupted" }, turn: 5 }),
    )
    expect(resolution).toEqual({ kind: "park", turns: 4 })
  })

  test("error ⇒ finish error + stream emit", async () => {
    const stream = new RecordingStream()
    const resolution = await resolveTurnLoopOutcome(
      baseArgs({ stream, result: { kind: "error", reason: "boom" }, turn: 2 }),
    )
    expect(resolution.kind).toBe("finish")
    if (resolution.kind === "finish") {
      expect(resolution.reason).toBe("error")
      expect(resolution.turns).toBe(1)
    }
    expect(stream.events).toEqual([{ type: "error", message: "boom" }])
  })

  test("refusal ⇒ finish refusal with rationale", async () => {
    const msg = assistantText("nope")
    const resolution = await resolveTurnLoopOutcome(
      baseArgs({
        result: { kind: "refusal", rationale: "policy", message: msg },
        turn: 2,
      }),
    )
    expect(resolution).toEqual({
      kind: "finish",
      reason: "refusal",
      turns: 2,
      stopCategory: expect.objectContaining({ kind: "refusal" }),
      refusal: { rationale: "policy" },
    })
  })

  test("completed ⇒ finish completed", async () => {
    const resolution = await resolveTurnLoopOutcome(
      baseArgs({ result: { kind: "completed" }, turn: 2 }),
    )
    expect(resolution).toMatchObject({
      kind: "finish",
      reason: "completed",
      turns: 2,
    })
  })

  test("tools ⇒ continue + append tool_result blocks to wm", async () => {
    const args = baseArgs({
      result: {
        kind: "tools",
        message: assistantText("ok"),
        resultBlocks: [{ type: "tool_result", tool_use_id: "t1", content: "done" }],
      },
    })
    const resolution = await resolveTurnLoopOutcome(args)
    expect(resolution).toEqual({ kind: "continue" })
    expect(args.wm.snapshot()).toHaveLength(1)
    expect(args.wm.snapshot()[0]?.role).toBe("user")
  })

  test("budget exhausted on tools turn seals pending tool_results before finish", async () => {
    const args = baseArgs({
      budgetExhausted: true,
      result: {
        kind: "tools",
        message: assistantText("ok"),
        resultBlocks: [{ type: "tool_result", tool_use_id: "t1", content: "x" }],
      },
    })
    const resolution = await resolveTurnLoopOutcome(args)
    expect(resolution).toMatchObject({
      kind: "finish",
      reason: "budget_exhausted",
    })
    expect(args.wm.snapshot()).toHaveLength(1)
    // ALBB-17 claim 1 — post-turn meter exhaustion must carry a `budget`-bucket
    // stopCategory (source=meter), NOT the misleading `max_turns` category. RED-on-
    // injection: reverting turn-outcome.ts:133 to `completedCategory("max_turns")`
    // turns this red.
    const finish = resolution as Extract<typeof resolution, { kind: "finish" }>
    expect(finish.stopCategory?.kind).toBe("budget")
    expect(finish.stopCategory?.reasonCode).toBe("budget.cost_cap")
    expect(finish.stopCategory?.kind).not.toBe("max_turns")
    expect(finish.stopCategory?.hint).not.toBe("Reached the configured maxTurns limit.")
  })

  test("approved exit is applied before a budget finish seals the turn", async () => {
    const stream = new RecordingStream()
    const args = baseArgs({
      stream,
      budgetExhausted: true,
      result: {
        kind: "tools",
        message: assistantText("ok"),
        resultBlocks: [{ type: "tool_result", tool_use_id: "pe1", content: "approved" }],
      },
    })
    args.cfg.planMode = true
    args.cfg.mode = "plan"
    args.pendingPlanExitRef.current = [
      { plan: "1. ship it", outcome: { decision: "approved" } },
    ] as typeof args.pendingPlanExitRef.current

    const resolution = await resolveTurnLoopOutcome(args)

    expect(resolution).toMatchObject({ kind: "finish", reason: "budget_exhausted" })
    expect(args.cfg.mode).toBe("default")
    expect(stream.events).toContainEqual({
      type: "mode_changed",
      from: "plan",
      to: "default",
      fromAgentMode: "plan",
      toAgentMode: "default",
      reason: "plan_exit_approved",
    })
  })

  test("same-turn exit dominates contradictory plan-entry requests", async () => {
    const stream = new RecordingStream()
    const args = baseArgs({
      stream,
      result: {
        kind: "tools",
        message: assistantText("ok"),
        resultBlocks: [{ type: "tool_result", tool_use_id: "mix1", content: "x" }],
      },
    })
    args.cfg.planMode = true
    args.cfg.mode = "plan"
    args.pendingPlanExitRef.current = [
      { plan: "1. ship it", outcome: { decision: "approved" } },
    ] as typeof args.pendingPlanExitRef.current
    args.pendingPlanEntryRef.current = [{ reason: "go back to planning" }] as typeof args.pendingPlanEntryRef.current

    const resolution = await resolveTurnLoopOutcome(args)

    expect(resolution).toEqual({ kind: "continue" })
    expect(args.cfg.mode).toBe("default")
    expect(stream.events.filter((e) => e.type === "mode_changed")).toEqual([
      {
        type: "mode_changed",
        from: "plan",
        to: "default",
        fromAgentMode: "plan",
        toAgentMode: "default",
        reason: "plan_exit_approved",
      },
    ])
  })

  test("when multiple same-turn exits are queued, the final exit outcome is authoritative", async () => {
    const stream = new RecordingStream()
    const args = baseArgs({
      stream,
      result: {
        kind: "tools",
        message: assistantText("ok"),
        resultBlocks: [{ type: "tool_result", tool_use_id: "mix2", content: "x" }],
      },
    })
    const planStore = createInMemoryPlanStore({ now: () => 1 })
    expect(
      planStore.create({
        name: "Queued plan",
        overview: "should survive the final approval",
        todos: [{ content: "ship it" }],
      }).ok,
    ).toBe(true)
    args.cfg.planMode = true
    args.cfg.mode = "plan"
    args.cfg.planStore = planStore
    args.pendingPlanExitRef.current = [
      { plan: "1. reject first", outcome: { decision: "rejected" } },
      { plan: "1. approve last", outcome: { decision: "approved" } },
    ] as typeof args.pendingPlanExitRef.current

    const resolution = await resolveTurnLoopOutcome(args)

    expect(resolution).toEqual({ kind: "continue" })
    expect(args.cfg.mode).toBe("default")
    expect(planStore.current()).toBeNull()
    expect(stream.events.filter((e) => e.type === "mode_changed")).toEqual([
      {
        type: "mode_changed",
        from: "plan",
        to: "default",
        fromAgentMode: "plan",
        toAgentMode: "default",
        reason: "plan_exit_approved",
      },
    ])
  })

  test("interrupted turns discard queued plan lifecycle so stale mode flips do not bleed into the next turn", async () => {
    const args = baseArgs({
      result: {
        kind: "interrupted",
      },
    })
    args.pendingPlanExitRef.current = [
      { plan: "1. stale exit", outcome: { decision: "approved" } },
    ] as typeof args.pendingPlanExitRef.current
    args.pendingPlanEntryRef.current = [{ reason: "stale entry" }] as typeof args.pendingPlanEntryRef.current

    const resolution = await resolveTurnLoopOutcome(args)

    expect(resolution).toEqual({ kind: "park", turns: 2 })
    expect(args.pendingPlanExitRef.current).toEqual([])
    expect(args.pendingPlanEntryRef.current).toEqual([])
  })

  test("aborted turns discard queued plan lifecycle so stale callbacks cannot reapply later", async () => {
    const args = baseArgs({
      result: {
        kind: "aborted",
      },
    })
    args.pendingPlanExitRef.current = [
      { plan: "1. stale exit", outcome: { decision: "approved" } },
    ] as typeof args.pendingPlanExitRef.current
    args.pendingPlanEntryRef.current = [{ reason: "stale entry" }] as typeof args.pendingPlanEntryRef.current

    const resolution = await resolveTurnLoopOutcome(args)

    expect(resolution).toMatchObject({ kind: "finish", reason: "aborted", turns: 2 })
    expect(args.pendingPlanExitRef.current).toEqual([])
    expect(args.pendingPlanEntryRef.current).toEqual([])
  })
})

describe("shouldParkOnGate", () => {
  // `shouldParkOnGate` reads ONLY `ctx.cfg` (`.subagentTurnGate` + `.signal`),
  // so a cfg-only context is sufficient. Asserted via the `Partial` supertype
  // (NOT `unknown`) since the rest of `RunAgentContext` is intentionally absent.
  const minimalCtx = (gate?: SubagentTurnGate): RunAgentContext => {
    const cfg: AgentConfig = {
      llm: { stream: async function* () {} },
      registry: new ToolRegistry([]),
      stream: new RecordingStream(),
      permission: { mode: "default" },
      messages: [],
      system: "",
      cwd: "/tmp",
      maxTurns: 1,
      signal: new AbortController().signal,
      ...(gate !== undefined ? { subagentTurnGate: gate } : {}),
    }
    return { cfg } as Partial<RunAgentContext> as RunAgentContext
  }

  test("no gate ⇒ false (default-OFF)", async () => {
    const parked = await shouldParkOnGate(minimalCtx(), {
      kind: "finish",
      reason: "completed",
      turns: 1,
    })
    expect(parked).toBe(false)
  })

  test("non-completed finish ⇒ false", async () => {
    const gate = new SubagentTurnGate()
    const parked = await shouldParkOnGate(minimalCtx(gate), {
      kind: "finish",
      reason: "error",
      turns: 1,
    })
    expect(parked).toBe(false)
  })

  test("completed + gate settle ⇒ false", async () => {
    const gate = new SubagentTurnGate()
    const ac = new AbortController()
    const ctx = {
      ...minimalCtx(gate),
      cfg: { ...minimalCtx(gate).cfg, signal: ac.signal },
    }
    ac.abort()
    const parked = await shouldParkOnGate(ctx, {
      kind: "finish",
      reason: "completed",
      turns: 1,
    })
    expect(parked).toBe(false)
  })

  test("completed + pending wake ⇒ true (park for another turn)", async () => {
    const gate = new SubagentTurnGate()
    gate.wake("followup")
    const parked = await shouldParkOnGate(minimalCtx(gate), {
      kind: "finish",
      reason: "completed",
      turns: 1,
    })
    expect(parked).toBe(true)
  })
})
