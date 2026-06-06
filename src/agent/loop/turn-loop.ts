import { attrs, endSpan, SPAN_NAMES, type Span, startSpan } from "@/observability"
import { errMessage, logger } from "@/shared"
import { freshRecovery } from "../recovery"
import { buildWorkMetricsResources, turnSpanAttrs } from "../session-resources"
import { interruptedCategory } from "../stop-category"
import { flushTurnObservability } from "../turn-closeout"
import type { TurnState } from "../turn-context"
import type { AgentOutcome } from "../types"
import { runTurn } from "./same-turn-engine"
import { prepareTurnIteration } from "./turn-iteration"
import { resolveTurnLoopOutcome, shouldParkOnGate } from "./turn-outcome"
import type { RunAgentContext, TurnResult } from "./types"

export const executeTurnWithObservability = async (args: {
  readonly ctx: RunAgentContext
  readonly turn: number
}): Promise<{ readonly result: TurnResult }> => {
  const { collector: workCollector, turnId: workTurnId } = buildWorkMetricsResources(args.ctx.cfg)
  const turnId = args.ctx.cfg.activeTurnRef?.current.currentTurn?.turnId ?? crypto.randomUUID()
  const turnSpan: Span = startSpan(SPAN_NAMES.turn, turnSpanAttrs(turnId))
  let turnSpanStatus: "ok" | "error" | "aborted" = "ok"
  let flushKind: "tools" | "completed" | "aborted" | "interrupted" | "error" | "refusal" = "error"
  let result: TurnResult
  try {
    if (args.ctx.turnDiffSession !== undefined) {
      await args.ctx.turnDiffSession.startTurn(args.turn)
    }
    const state: TurnState = {
      ...args.ctx.turnStateSeed,
      rec: freshRecovery(),
      collector: workCollector,
    }
    result = await runTurn(args.turn, args.ctx.session, state)
    flushKind = result.kind
    turnSpanStatus =
      result.kind === "aborted" || result.kind === "interrupted"
        ? "aborted"
        : result.kind === "error"
          ? "error"
          : "ok"
  } catch (e) {
    turnSpanStatus = "error"
    throw e
  } finally {
    try {
      await flushTurnObservability({
        cfg: args.ctx.cfg,
        stream: args.ctx.cfg.stream,
        turn: args.turn,
        turnDiffSession: args.ctx.turnDiffSession,
        gitDirectiveCollector: args.ctx.gitDirectiveCollector,
        workCollector,
        workTurnId,
        resultKind: flushKind,
      })
    } catch (flushErr) {
      logger.warn(`loop.flushTurnObservability: ${errMessage(flushErr)}`)
    }
    endSpan(turnSpan, turnSpanStatus, attrs({}))
  }
  return { result }
}

export const runAgentTurnLoop = async (ctx: RunAgentContext): Promise<AgentOutcome | undefined> => {
  for (let turn = 1; turn <= ctx.cfg.maxTurns; turn++) {
    const turnReady = await prepareTurnIteration({
      cfg: ctx.cfg,
      wm: ctx.wm,
      sessionId: ctx.sessionId,
      taskRegistry: ctx.features.taskRegistry,
      turn,
      localizePhaseState: ctx.localizePhaseState,
      dedupGate: ctx.dedupGate,
      shellSnapshotSession: ctx.shellSnapshotSession,
      hookPromptPending: ctx.hookPromptPending,
    })
    if (turnReady === "aborted") {
      return ctx.finish("aborted", turn - 1, interruptedCategory("user"))
    }
    const { result } = await executeTurnWithObservability({ ctx, turn })
    const resolution = await resolveTurnLoopOutcome({
      cfg: ctx.cfg,
      stream: ctx.cfg.stream,
      wm: ctx.wm,
      breaker: ctx.breaker,
      recorder: ctx.recorder,
      turn,
      result,
      pendingPlanExitRef: ctx.pendingPlanExitRef,
      hookPromptPending: ctx.hookPromptPending,
    })
    if (resolution.kind === "park") {
      const gate = ctx.cfg.subagentTurnGate
      if (gate !== undefined && (await gate.wait(ctx.cfg.signal)) !== "settle") continue
      return ctx.finish("aborted", resolution.turns, interruptedCategory("user"))
    }
    if (resolution.kind === "finish") {
      if (await shouldParkOnGate(ctx, resolution)) continue
      return ctx.finish(
        resolution.reason,
        resolution.turns,
        resolution.stopCategory,
        resolution.refusal,
      )
    }
  }
  return undefined
}
