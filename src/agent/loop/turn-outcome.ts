/**
 * Multi-turn loop outcome resolver — TurnResult → continue | park | finish.
 */

import type { Message } from "@/llm"
import type { WorkingMemory } from "@/memory"
import { emitBudgetExhaustedDecision } from "../decision-emit-phase3"
import { captureAbortedTurn } from "../interrupted-turn"
import {
  budgetCategory,
  classifyErrorReason,
  completedCategory,
  interruptedCategory,
  refusalCategory,
} from "../stop-category"
import { appendPendingToolResults } from "../turn-closeout"
import type { AgentConfig } from "../types"
import { applyPendingPlanEntry } from "./plan-enter-wire"
import { applyPendingPlanExit } from "./plan-exit-wire"
import type { RunAgentContext, TurnLoopResolution, TurnResult } from "./types"

const applyQueuedPlanLifecycle = (args: {
  readonly cfg: AgentConfig
  readonly pendingPlanExitRef: { current: import("./types").PendingPlanExit[] }
  readonly pendingPlanEntryRef: { current: import("./types").PendingPlanEntry[] }
  readonly hookPromptPending: import("../hooks").HookPromptInject[]
}): void => {
  const exitCount = args.pendingPlanExitRef.current.length
  const exit = exitCount === 0 ? null : (args.pendingPlanExitRef.current[exitCount - 1] ?? null)
  // Multiple lifecycle tools can land in one assistant turn. The NEXT-turn
  // authority must follow the FINAL operator-visible request/result pair from
  // that turn, not the first queued callback. Exit outcomes still dominate any
  // same-turn entry requests because a turn that asked to leave plan mode must
  // not silently re-enter on a contradictory later entry tool.
  const entryCount = args.pendingPlanEntryRef.current.length
  const entry =
    exit === null
      ? entryCount === 0
        ? null
        : (args.pendingPlanEntryRef.current[entryCount - 1] ?? null)
      : null
  args.pendingPlanExitRef.current = []
  args.pendingPlanEntryRef.current = []
  if (exit !== null) applyPendingPlanExit(args.cfg, exit, args.hookPromptPending)
  if (entry !== null) applyPendingPlanEntry(args.cfg, entry, args.hookPromptPending)
}

const clearQueuedPlanLifecycle = (args: {
  readonly pendingPlanExitRef: { current: import("./types").PendingPlanExit[] }
  readonly pendingPlanEntryRef: { current: import("./types").PendingPlanEntry[] }
}): void => {
  args.pendingPlanExitRef.current = []
  args.pendingPlanEntryRef.current = []
}

export const resolveTurnLoopOutcome = async (args: {
  readonly cfg: AgentConfig
  readonly stream: AgentConfig["stream"]
  readonly wm: WorkingMemory<Message>
  readonly breaker: import("../compaction-breaker").CompactionBreaker | undefined
  readonly recorder: import("../metrics").AgentRecorder | undefined
  readonly turn: number
  readonly result: TurnResult
  readonly pendingPlanExitRef: { current: import("./types").PendingPlanExit[] }
  readonly pendingPlanEntryRef: { current: import("./types").PendingPlanEntry[] }
  readonly hookPromptPending: import("../hooks").HookPromptInject[]
}): Promise<TurnLoopResolution> => {
  if (args.result.kind === "aborted") {
    // ALBB-06 (path c) — a mid-turn `TurnResult.kind==="aborted"` (the branch a
    // keystroke cancel lands on when the REPL wires no SubagentTurnGate). Capture
    // the partial turn BEFORE finishing so `/resume` can restore it. Distinct
    // reason for telemetry. Default-OFF: no buffer wired ⇒ no-op (byte-identical).
    // UUX-5-05 — SKIP when the producer already captured with a precise reason
    // (`captured:true`, the mid-turn `/cancel` drain): the buffer is single-slot
    // last-wins, so re-capturing here would clobber conversation_cancel with the
    // generic turn_result_abort (the ALBB-06 double-capture class).
    if (args.result.captured !== true) captureAbortedTurn(args.cfg, args.wm, "turn_result_abort")
    clearQueuedPlanLifecycle(args)
    return {
      kind: "finish",
      reason: "aborted",
      turns: args.turn - 1,
      stopCategory: interruptedCategory("user"),
    }
  }
  if (args.result.kind === "interrupted") {
    clearQueuedPlanLifecycle(args)
    return { kind: "park", turns: args.turn - 1 }
  }
  if (args.result.kind === "error") {
    clearQueuedPlanLifecycle(args)
    args.stream.emit({ type: "error", message: args.result.reason })
    return {
      kind: "finish",
      reason: "error",
      turns: args.turn - 1,
      stopCategory: classifyErrorReason(args.result.reason),
    }
  }
  if (args.result.kind === "refusal") {
    clearQueuedPlanLifecycle(args)
    args.recorder?.turn()
    return {
      kind: "finish",
      reason: "refusal",
      turns: args.turn,
      stopCategory: refusalCategory(),
      refusal: { rationale: args.result.rationale },
    }
  }
  args.recorder?.turn()
  if (args.result.kind === "completed") {
    clearQueuedPlanLifecycle(args)
    // A cleanly-completed FINAL turn is terminal on its OWN merit — the natural
    // outcome WINS even if this turn also crossed the post-turn budget meter
    // (mirrors the L4 ledger placement in turn-loop.ts, which is deliberately
    // AFTER the natural outcome). Meter exhaustion only pre-empts a CONTINUATION
    // (the `tools` case below), never a completion.
    return {
      kind: "finish",
      reason: "completed",
      turns: args.turn,
      stopCategory: completedCategory("normal"),
    }
  }
  applyQueuedPlanLifecycle(args)
  // Meter-exhaustion is terminal only when the turn is about to CONTINUE
  // (kind === "tools"): the loop would otherwise append tool_results and loop
  // again, so a crossed budget stops it here. Preserve appendPendingToolResults
  // for that case so the transcript stays well-formed.
  const exhausted =
    args.result.kind === "tools" ? args.cfg.budgetMeter?.checkExhausted() : undefined
  if (exhausted?.exhausted) {
    appendPendingToolResults(args.wm, args.result.resultBlocks)
    emitBudgetExhaustedDecision(args.cfg.decisionEmitter, exhausted, { turn: args.turn })
    return {
      kind: "finish",
      reason: "budget_exhausted",
      turns: args.turn,
      // ALBB-17 claim 1: post-turn cost-meter exhaustion is a BUDGET stop, not a
      // turn-count cap — label it distinctly so a surface renders a cost-cap hint.
      stopCategory: budgetCategory("meter"),
    }
  }
  args.breaker?.noteProgress()
  args.wm.append({ role: "user", content: args.result.resultBlocks })
  return { kind: "continue" }
}

/** Park on gate when a clean `completed` turn has a pending follow-up wake. */
export const shouldParkOnGate = async (
  ctx: RunAgentContext,
  resolution: Extract<TurnLoopResolution, { kind: "finish" }>,
): Promise<boolean> => {
  const gate = ctx.cfg.subagentTurnGate
  if (gate === undefined || resolution.reason !== "completed") return false
  const waited = await gate.wait(ctx.cfg.signal)
  return waited !== "settle"
}
