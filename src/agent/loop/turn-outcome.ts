/**
 * Multi-turn loop outcome resolver — TurnResult → continue | park | finish.
 */

import type { Message } from "@/llm"
import type { WorkingMemory } from "@/memory"
import { emitBudgetExhaustedDecision } from "../decision-emit-phase3"
import {
  classifyErrorReason,
  completedCategory,
  interruptedCategory,
  refusalCategory,
} from "../stop-category"
import { appendPendingToolResults } from "../turn-closeout"
import type { AgentConfig } from "../types"
import { applyPendingPlanExit } from "./plan-exit-wire"
import type { RunAgentContext, TurnLoopResolution, TurnResult } from "./types"

export const resolveTurnLoopOutcome = async (args: {
  readonly cfg: AgentConfig
  readonly stream: AgentConfig["stream"]
  readonly wm: WorkingMemory<Message>
  readonly breaker: import("../compaction-breaker").CompactionBreaker | undefined
  readonly recorder: import("../metrics").AgentRecorder | undefined
  readonly turn: number
  readonly result: TurnResult
  readonly pendingPlanExitRef: { current: import("./types").PendingPlanExit | null }
  readonly hookPromptPending: import("../hooks").HookPromptInject[]
}): Promise<TurnLoopResolution> => {
  if (args.result.kind === "aborted") {
    return {
      kind: "finish",
      reason: "aborted",
      turns: args.turn - 1,
      stopCategory: interruptedCategory("user"),
    }
  }
  if (args.result.kind === "interrupted") {
    return { kind: "park", turns: args.turn - 1 }
  }
  if (args.result.kind === "error") {
    args.stream.emit({ type: "error", message: args.result.reason })
    return {
      kind: "finish",
      reason: "error",
      turns: args.turn - 1,
      stopCategory: classifyErrorReason(args.result.reason),
    }
  }
  if (args.result.kind === "refusal") {
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
  const exhausted = args.cfg.budgetMeter?.checkExhausted()
  if (exhausted?.exhausted) {
    if (args.result.kind === "tools") {
      appendPendingToolResults(args.wm, args.result.resultBlocks)
    }
    emitBudgetExhaustedDecision(args.cfg.decisionEmitter, exhausted, { turn: args.turn })
    return {
      kind: "finish",
      reason: "budget_exhausted",
      turns: args.turn,
      stopCategory: completedCategory("max_turns"),
    }
  }
  if (args.result.kind === "completed") {
    return {
      kind: "finish",
      reason: "completed",
      turns: args.turn,
      stopCategory: completedCategory("normal"),
    }
  }
  args.breaker?.noteProgress()
  args.wm.append({ role: "user", content: args.result.resultBlocks })
  if (args.pendingPlanExitRef.current !== null) {
    applyPendingPlanExit(args.cfg, args.pendingPlanExitRef.current, args.hookPromptPending)
    args.pendingPlanExitRef.current = null
  }
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
