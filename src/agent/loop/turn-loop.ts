import { attrs, endSpan, SPAN_NAMES, type Span, startSpan } from "@/observability"
import { errMessage, logger } from "@/shared"
import { emitBudgetExhaustedDecision } from "../decision-emit-phase3"
import { maybeProposeRadarCard } from "../radar-producer-hook"
import { freshRecovery } from "../recovery"
import { buildWorkMetricsResources, turnSpanAttrs } from "../session-resources"
import { completedCategory, interruptedCategory } from "../stop-category"
import { flushTurnObservability } from "../turn-closeout"
import type { TurnState } from "../turn-context"
import type { AgentOutcome } from "../types"
import { isSessionApprovalRequiredError } from "./emit-helpers"
import { runTurn } from "./same-turn-engine"
import { resolveActiveModelId } from "./skill-gate"
import { prepareTurnIteration, projectCostPreflight } from "./turn-iteration"
import { resolveTurnLoopOutcome, shouldParkOnGate } from "./turn-outcome"
import type { RunAgentContext, TurnResult } from "./types"

/** Classify a throw out of `runTurn` into the observability labels the finally
 *  block flushes. An approval-required PAUSE (HITL hand-off) is deliberately
 *  labeled "aborted" (a pause, which `emitWorkMetrics` suppresses) rather than
 *  "error" so it is not recorded as a hard run failure; every other throw stays
 *  "error" (byte-identical to the prior unconditional `turnSpanStatus="error"`).
 *  Pure — no throw, no IO. */
export const classifyTurnThrow = (
  e: unknown,
): {
  readonly turnSpanStatus: "ok" | "error" | "aborted"
  readonly flushKind: "tools" | "completed" | "aborted" | "interrupted" | "error" | "refusal"
} =>
  isSessionApprovalRequiredError(e)
    ? { turnSpanStatus: "aborted", flushKind: "aborted" }
    : { turnSpanStatus: "error", flushKind: "error" }

/** The finish tuple for the park/gate SETTLE path (a parked turn whose gate
 *  wait resolved to "settle", or a park with no gate to keep waiting on). This
 *  is a SYSTEM-originated interrupt (subagent wake), NOT a user Ctrl+C — so it
 *  is attributed to `interruptedCategory("system")`. The true user-abort path
 *  (`turnReady === "aborted"`, the `config.signal` abort) keeps
 *  `interruptedCategory("user")`. Pure. */
export const parkSettleFinish = (
  turns: number,
): {
  readonly reason: "aborted"
  readonly turns: number
  readonly stopCategory: ReturnType<typeof interruptedCategory>
} => ({ reason: "aborted", turns, stopCategory: interruptedCategory("system") })

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
  // ADR-0231 (wire phase) — capture the turn-start wall-clock ONLY when the
  // radar producer hook is wired, so the default-OFF path reads no extra
  // clock (strict byte-identity). `undefined` ⇒ the radar block is absent ⇒
  // the finally never samples.
  const radarTurnStartMs = args.ctx.cfg.radar !== undefined ? Date.now() : undefined
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
    // An approval-required PAUSE (SessionApprovalRequiredError) is an intentional
    // HITL hand-off, not a hard error — label the span + work-metrics as
    // "aborted" (which `emitWorkMetrics` deliberately suppresses) instead of
    // "error", so the pause is not recorded as a run failure. Any OTHER throw
    // stays "error". Control flow is unchanged (the error is always rethrown).
    const classification = classifyTurnThrow(e)
    turnSpanStatus = classification.turnSpanStatus
    flushKind = classification.flushKind
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
    // ADR-0231 (wire phase) — radar proposal-queue producer hook. Absent
    // block (`cfg.radar === undefined`) ⇒ the guard above left
    // `radarTurnStartMs` undefined and this never runs (byte-identical). When
    // wired, deposit a heuristic card ONLY on a COMPLETED turn (the hook
    // enforces the `flushKind` gate too) — the hook NEVER throws.
    if (args.ctx.cfg.radar !== undefined && radarTurnStartMs !== undefined) {
      maybeProposeRadarCard(args.ctx.cfg.radar, {
        lastTaskDurationMs: Date.now() - radarTurnStartMs,
        flushKind,
        ...(args.ctx.cfg.sessionId !== undefined ? { sessionId: args.ctx.cfg.sessionId } : {}),
      })
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
      tokenBaseline: ctx.turnStateSeed.tokenBaseline,
    })
    if (turnReady === "aborted") {
      return ctx.finish("aborted", turn - 1, interruptedCategory("user"))
    }
    // L2 cost pre-flight admission control — stop BEFORE issuing a model call
    // whose input cost alone would breach `maxCostUsd` (the call cannot avoid
    // breaching, so spending on it is waste). Priced at the model the turn will
    // ACTUALLY run (`resolveActiveModelId`, the SAME resolver `same-turn-engine`
    // uses) so a sticky/skill swap never over-estimates. `turn-1` completed
    // turns: this turn produced no model output. The whole block is GATED on a
    // configured `budgetMeter` so the no-cost-cap path pays no extra
    // model-resolution / sticky read (byte-identical default-OFF).
    const costPreflight =
      ctx.cfg.budgetMeter !== undefined
        ? projectCostPreflight(
            ctx.cfg,
            ctx.wm,
            await resolveActiveModelId(ctx.cfg, ctx.session.skillGate?.activeOverride()),
          )
        : undefined
    if (costPreflight !== undefined) {
      emitBudgetExhaustedDecision(ctx.cfg.decisionEmitter, costPreflight, { turn })
      return ctx.finish("budget_exhausted", turn - 1, completedCategory("max_turns"))
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
      const f = parkSettleFinish(resolution.turns)
      return ctx.finish(f.reason, f.turns, f.stopCategory)
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
    // L4 cross-run cost ledger enforcement — the turn is about to CONTINUE
    // (resolution is neither park nor finish). If the usage recorded this turn
    // (emitUsage) crossed a HARD session/daily cost ceiling, stop instead of
    // looping. Placed AFTER resolveTurnLoopOutcome so a turn that already
    // reached a terminal state (completed/error) keeps its natural outcome and
    // its recorder/tool-result handling — a hard cost breach only PRE-EMPTS the
    // continuation, the cross-run analogue of the per-run meter cap. Default-OFF
    // / byte-identical when no ledger or no policy is wired (`hardBreach()` ⇒
    // undefined).
    const ledgerHardBreach = ctx.cfg.budgetLedger?.hardBreach()
    if (ledgerHardBreach !== undefined) {
      emitBudgetExhaustedDecision(
        ctx.cfg.decisionEmitter,
        {
          exhausted: true,
          kind: "cost_usd",
          budget: ledgerHardBreach.limit,
          observed: ledgerHardBreach.observed,
        },
        { turn },
      )
      return ctx.finish("budget_exhausted", turn, completedCategory("max_turns"))
    }
  }
  return undefined
}
