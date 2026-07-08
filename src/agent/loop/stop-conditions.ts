/**
 * `@/agent/loop/stop-conditions` — the per-turn admission-control STOP CONDITIONS as a registry (H3,
 * jul-4 hexagonal audit F2 / OCP).
 *
 * The hot loop (`runAgentTurnLoop`) had cost/ledger admission control INLINED as `if` blocks that
 * accreted per feature (L2 pre-turn cost pre-flight, L4 post-continue ledger breach) — a closed
 * switch, so every new stop concern re-edited the loop body. This module extracts each as a NAMED,
 * unit-testable condition and exposes ordered default arrays the loop iterates. Adding a stop concern
 * is now: write a condition + register it in the array — the loop body is closed for modification.
 *
 * Two phases (the loop's real structure): a PRE-TURN condition can stop BEFORE the model call
 * (cost pre-flight — spending on a call that must breach is waste); a POST-CONTINUE condition can
 * stop a turn that is about to CONTINUE (ledger hard breach — after the turn's outcome is resolved,
 * before looping). park/finish outcome-routing stays in the loop (it is control flow, not a stop
 * concern). Each condition returns a {@link TurnFinish} to `ctx.finish(...)` or `undefined` (continue).
 *
 * BYTE-IDENTICAL: the default arrays hold exactly today's two conditions, in today's order, with the
 * same gate/emit/return semantics — the loop's observable behavior is unchanged.
 */

import { emitBudgetExhaustedDecision } from "../decision-emit-phase3"
import { budgetCategory, type StopCategory } from "../stop-category"
import { resolveActiveModelId } from "./skill-gate"
import { projectCostPreflight } from "./turn-iteration"
import type { FinishAgentSession, RunAgentContext } from "./types"

/** The three args a stop condition hands to `ctx.finish(reason, turns, stopCategory)`. */
export interface TurnFinish {
  readonly reason: Parameters<FinishAgentSession>[0]
  readonly turns: number
  readonly stopCategory: StopCategory
}

/** A condition evaluated BEFORE the model call — may stop the run pre-emptively (async: it may
 *  resolve the active model to price the pre-flight). */
export type PreTurnStopCondition = (
  ctx: RunAgentContext,
  turn: number,
) => Promise<TurnFinish | undefined>

/** A condition evaluated AFTER a turn resolves to continue — may stop before the next iteration. */
export type PostContinueStopCondition = (
  ctx: RunAgentContext,
  turn: number,
) => TurnFinish | undefined

/**
 * L2 cost pre-flight admission control — stop BEFORE issuing a model call whose input cost alone
 * would breach `maxCostUsd` (the call cannot avoid breaching, so spending is waste). Priced at the
 * model the turn will ACTUALLY run (`resolveActiveModelId`, the same resolver `same-turn-engine`
 * uses). GATED on a configured `budgetMeter` ⇒ the no-cost-cap path pays no model-resolution
 * (byte-identical default-OFF). `turn-1`: this turn produced no model output.
 */
export const costPreflightCondition: PreTurnStopCondition = async (ctx, turn) => {
  if (ctx.cfg.budgetMeter === undefined) return undefined
  const costPreflight = projectCostPreflight(
    ctx.cfg,
    ctx.wm,
    await resolveActiveModelId(ctx.cfg, ctx.session.skillGate?.activeOverride()),
  )
  if (costPreflight === undefined) return undefined
  emitBudgetExhaustedDecision(ctx.cfg.decisionEmitter, costPreflight, { turn })
  // ALBB-17 claim 1: L2 pre-flight cost admission is a BUDGET stop, not a turn cap.
  return { reason: "budget_exhausted", turns: turn - 1, stopCategory: budgetCategory("preflight") }
}

/**
 * L4 cross-run cost ledger enforcement — the turn is about to CONTINUE (neither park nor finish). If
 * the usage recorded this turn crossed a HARD session/daily cost ceiling, stop instead of looping —
 * the cross-run analogue of the per-run meter cap. Default-OFF / byte-identical when no ledger/policy
 * is wired (`hardBreach()` ⇒ undefined). `turn` (not `turn-1`): this turn DID run.
 */
export const ledgerHardBreachCondition: PostContinueStopCondition = (ctx, turn) => {
  const ledgerHardBreach = ctx.cfg.budgetLedger?.hardBreach()
  if (ledgerHardBreach === undefined) return undefined
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
  // ALBB-17 claim 1: L4 cross-run ledger breach is a BUDGET stop (distinct code).
  return { reason: "budget_exhausted", turns: turn, stopCategory: budgetCategory("ledger") }
}

/** Ordered PRE-TURN conditions the loop iterates before the model call. Register a new one here. */
export const DEFAULT_PRE_TURN_STOP_CONDITIONS: readonly PreTurnStopCondition[] = [
  costPreflightCondition,
]

/** Ordered POST-CONTINUE conditions the loop iterates before the next iteration. Register here. */
export const DEFAULT_POST_CONTINUE_STOP_CONDITIONS: readonly PostContinueStopCondition[] = [
  ledgerHardBreachCondition,
]
