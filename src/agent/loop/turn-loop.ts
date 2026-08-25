import { attrs, endSpan, SPAN_NAMES, type Span, startSpan } from "@/observability"
import { errMessage, isAbortError, LLMError, logger } from "@/shared"
import { maybeProposeRadarCard } from "../radar-producer-hook"
import { freshRecovery } from "../recovery"
import { buildWorkMetricsResources, turnSpanAttrs, withActiveSpanScope } from "../session-resources"
import { completedCategory, interruptedCategory } from "../stop-category"
import { flushTurnObservability } from "../turn-closeout"
import type { TurnState } from "../turn-context"
import type { AgentOutcome } from "../types"
import { isSessionApprovalRequiredError } from "./emit-helpers"
import { runTurn } from "./same-turn-engine"
import {
  DEFAULT_POST_CONTINUE_STOP_CONDITIONS,
  DEFAULT_PRE_TURN_STOP_CONDITIONS,
} from "./stop-conditions"
import { classifyTurnAbort } from "./turn-gate"
import { prepareTurnIteration } from "./turn-iteration"
import { resolveTurnLoopOutcome, shouldParkOnGate } from "./turn-outcome"
import type { RunAgentContext, TurnLoopResolution, TurnResult } from "./types"

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

/** ALBB-20 #13 REGRESSION FIX — is `e` a GENUINE cooperative abort (user Ctrl+C
 *  / deadline) that landed while a turn-body LLM stream was in-flight? Since
 *  ALBB-20 #13 threaded `config.signal` into the REACTIVE (PTL) summarizer, an
 *  abort during that in-flight summarizer throws an `AbortError` out of
 *  `summarizeWith` → `applyNonSuccessRecoveryAction` (unguarded) → `runTurn`.
 *  That throw is NOT a hard failure — it must settle the run as an aborted turn,
 *  not reject it. Detection mirrors `streamConsume.classifyStreamTurnError` (the
 *  SSOT for the same decision on the primary stream): our/native/DOM `AbortError`
 *  or `TimeoutError` (`isAbortError`), an `LLMError{kind:"aborted"}` (adapters
 *  mint this), OR the lifetime `signal` is already aborted (a cancel that surfaced
 *  as some other error while the signal was down). Pure — no throw, no IO. */
export const isGenuineTurnAbort = (e: unknown, signal: AbortSignal | undefined): boolean =>
  isAbortError(e) || (e instanceof LLMError && e.kind === "aborted") || signal?.aborted === true

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
    // Activate the turn span in async context so the nested sampling +
    // tool-call spans (opened deep inside `runTurn`) discover THIS turn as their
    // structural parent — replacing the old flat-sink LIFO-stack parentage.
    // No-op wrap when no sink is active (byte-identical default-OFF).
    result = await withActiveSpanScope(false, turnSpan, () =>
      runTurn(args.turn, args.ctx.session, state),
    )
    flushKind = result.kind
    turnSpanStatus =
      result.kind === "aborted" || result.kind === "interrupted"
        ? "aborted"
        : result.kind === "error"
          ? "error"
          : "ok"
  } catch (e) {
    // ALBB-20 #13 REGRESSION FIX — a GENUINE cooperative abort (user Ctrl+C /
    // deadline) that landed while a turn-body LLM stream was in-flight (most
    // notably the REACTIVE summarizer, made interruptible by ALBB-20 #13) throws
    // an `AbortError` out of `runTurn` instead of returning a cooperative
    // `{kind:"aborted"}`. Convert it here into that SAME clean aborted TurnResult
    // (identical to the `runTurn` line-26/58 pre-stream abort return) so the
    // normal aborted settlement runs (`resolveTurnLoopOutcome` → reason:"aborted",
    // interruptedCategory("user")) instead of the throw REJECTING the run promise
    // and being mis-recorded as a hard turn 'error'. Approval-required PAUSES are
    // NOT aborts — they are handled by `classifyTurnThrow` + rethrow BELOW
    // (checked first so an approval error that coincides with an aborted signal
    // keeps its HITL hand-off semantics, unchanged).
    if (!isSessionApprovalRequiredError(e) && isGenuineTurnAbort(e, args.ctx.cfg.signal)) {
      turnSpanStatus = "aborted"
      // Route through the SSOT (`classifyTurnAbort`) instead of hand-rolling
      // `{kind:"aborted"}`: a gate INTERRUPT (subagent `wake("interrupt")` — the
      // per-turn controller fired but the LIFETIME signal did NOT) must settle
      // `{kind:"interrupted"}` → park → resume (ADR-0437 collapse-then-resume),
      // whereas a genuine lifetime cancel settles `{kind:"aborted"}` → finish.
      // Uses the LIFETIME signal + the same gate `runTurn`/`same-turn-engine`
      // classify against, so a thrown abort matches those cooperative returns.
      const gate = args.ctx.session.config.subagentTurnGate
      result = classifyTurnAbort(gate, args.ctx.session.config.signal)
      flushKind = result.kind
      return { result }
    }
    // An approval-required PAUSE (SessionApprovalRequiredError) is an intentional
    // HITL hand-off, not a hard error — label the span + work-metrics as
    // "aborted" (which `emitWorkMetrics` deliberately suppresses) instead of
    // "error", so the pause is not recorded as a run failure. Any OTHER (non-abort)
    // throw stays "error" and is rethrown (classified 'error' downstream).
    const classification = classifyTurnThrow(e)
    turnSpanStatus = classification.turnSpanStatus
    flushKind = classification.flushKind
    throw e
  } finally {
    await runTurnEpilogue(args, { workCollector, workTurnId, flushKind, radarTurnStartMs })
    endSpan(turnSpan, turnSpanStatus, attrs({}))
  }
  return { result }
}

/** The turn's side-effect EPILOGUE: flush the turn's telemetry, then run the
 *  ADR-0231 radar producer hook. A unit because nothing in it can change the
 *  turn's result — it runs from a `finally` on every exit path, success or
 *  throw — and because both halves must survive their own failure: a flush
 *  error is warned AND surfaced on the stream rather than escaping a `finally`
 *  and replacing the real outcome. Never throws. */
const runTurnEpilogue = async (
  args: { readonly ctx: RunAgentContext; readonly turn: number },
  telemetry: {
    readonly workCollector: ReturnType<typeof buildWorkMetricsResources>["collector"]
    readonly workTurnId: ReturnType<typeof buildWorkMetricsResources>["turnId"]
    readonly flushKind: "tools" | "completed" | "aborted" | "interrupted" | "error" | "refusal"
    readonly radarTurnStartMs: number | undefined
  },
): Promise<void> => {
  try {
    await flushTurnObservability({
      cfg: args.ctx.cfg,
      stream: args.ctx.cfg.stream,
      turn: args.turn,
      turnDiffSession: args.ctx.turnDiffSession,
      gitDirectiveCollector: args.ctx.gitDirectiveCollector,
      workCollector: telemetry.workCollector,
      workTurnId: telemetry.workTurnId,
      resultKind: telemetry.flushKind,
    })
  } catch (flushErr) {
    // ALBB-20 #9 — the flush failure was warn-only (operator log), so a UI
    // watching the stream sink never learned turn telemetry was dropped. Add a
    // non-fatal stream emit alongside the warn so the drop is observable on the
    // agent-state surface too (north-star). Never rethrows (finally block).
    logger.warn(`loop.flushTurnObservability: ${errMessage(flushErr)}`)
    args.ctx.cfg.stream.emit({
      type: "error",
      message: `turn observability flush failed: ${errMessage(flushErr)}`,
    })
  }
  // ADR-0231 (wire phase) — radar proposal-queue producer hook. Absent
  // block (`cfg.radar === undefined`) ⇒ the caller left `radarTurnStartMs`
  // undefined and this never runs (byte-identical). When wired, deposit a
  // heuristic card ONLY on a COMPLETED turn (the hook enforces the
  // `flushKind` gate too) — the hook NEVER throws.
  if (args.ctx.cfg.radar !== undefined && telemetry.radarTurnStartMs !== undefined) {
    maybeProposeRadarCard(args.ctx.cfg.radar, {
      lastTaskDurationMs: Date.now() - telemetry.radarTurnStartMs,
      flushKind: telemetry.flushKind,
      ...(args.ctx.cfg.sessionId !== undefined ? { sessionId: args.ctx.cfg.sessionId } : {}),
    })
  }
}

/** A stop verdict from either condition registry (`{reason, turns, stopCategory}`). */
type TurnStop = NonNullable<Awaited<ReturnType<(typeof DEFAULT_PRE_TURN_STOP_CONDITIONS)[number]>>>

/**
 * H3 (OCP): the FIRST pre-turn stop condition that fires — admission control,
 * evaluated before a model call is issued. Today: L2 cost pre-flight.
 *
 * UNIT because the registry walk IS the extension point: add a pre-turn stop
 * concern by registering it in `DEFAULT_PRE_TURN_STOP_CONDITIONS`, never by
 * editing the loop. First-non-undefined wins and the remaining conditions are
 * NOT evaluated — a short-circuit the loop must not be free to re-order.
 */
const firstPreTurnStop = async (
  ctx: RunAgentContext,
  turn: number,
): Promise<TurnStop | undefined> => {
  for (const condition of DEFAULT_PRE_TURN_STOP_CONDITIONS) {
    const stop = await condition(ctx, turn)
    if (stop !== undefined) return stop
  }
  return undefined
}

/**
 * H3 (OCP): the FIRST post-continue stop condition that fires — evaluated
 * AFTER a turn resolves to continue (neither park nor finish), before the next
 * iteration. Today: L4 cross-run ledger hard breach + dedup no-progress.
 *
 * UNIT for the same reason as {@link firstPreTurnStop}, and SYNCHRONOUS on
 * purpose: these conditions are pure ledger reads, and making the walk `async`
 * would insert a microtask turn between the turn's resolution and the next
 * iteration that the pre-extraction loop did not have.
 */
const firstPostContinueStop = (ctx: RunAgentContext, turn: number): TurnStop | undefined => {
  for (const condition of DEFAULT_POST_CONTINUE_STOP_CONDITIONS) {
    const stop = condition(ctx, turn)
    if (stop !== undefined) return stop
  }
  return undefined
}

/** The four arguments of one `ctx.finish(...)` call, captured so the decision
 *  (WHICH finish) is separable from the act (calling it). */
interface FinishCall {
  readonly reason: Parameters<RunAgentContext["finish"]>[0]
  readonly turns: number
  readonly stopCategory: Parameters<RunAgentContext["finish"]>[2]
  readonly refusal: Parameters<RunAgentContext["finish"]>[3]
}

/** What the loop must do once `resolveTurnLoopOutcome` has settled the turn:
 *  end the run, take another turn immediately, or fall through to the
 *  post-continue stop conditions. */
type TurnDirective =
  | { readonly kind: "finish"; readonly finish: FinishCall }
  | { readonly kind: "retry" }
  | { readonly kind: "proceed" }

const RETRY_DIRECTIVE: TurnDirective = { kind: "retry" }
const PROCEED_DIRECTIVE: TurnDirective = { kind: "proceed" }

/**
 * Map a settled {@link TurnLoopResolution} onto the loop's next move.
 *
 * UNIT because `park` and `finish` are the SAME decision wearing two hats —
 * "may the subagent gate keep this run alive?" — and both answer it by awaiting
 * the gate and then choosing between another turn and a terminal finish. Held
 * apart they duplicated the gate/turn-budget reasoning in two nested branch
 * tails; held together the two arms read as one table:
 *
 *   park   + gate says not-settled  ⇒ retry (keep waiting on the next turn)
 *   park   + gate settled/absent    ⇒ finish as a SYSTEM interrupt
 *   finish + gate parks + turns left⇒ retry (a wake reopened the run)
 *   finish + otherwise              ⇒ finish with the resolution's own verdict
 *   continue                        ⇒ proceed to the post-continue conditions
 *
 * The `turn < maxTurns` guard on the third row is load-bearing: a wake on the
 * LAST allowed turn must not overwrite a clean terminal completion with the
 * outer-loop `max_turns` fallback.
 */
const resolveTurnDirective = async (
  ctx: RunAgentContext,
  resolution: TurnLoopResolution,
  turn: number,
): Promise<TurnDirective> => {
  if (resolution.kind === "park") {
    const gate = ctx.cfg.subagentTurnGate
    if (gate !== undefined && (await gate.wait(ctx.cfg.signal)) !== "settle") return RETRY_DIRECTIVE
    const f = parkSettleFinish(resolution.turns)
    return {
      kind: "finish",
      finish: {
        reason: f.reason,
        turns: f.turns,
        stopCategory: f.stopCategory,
        refusal: undefined,
      },
    }
  }
  if (resolution.kind === "finish") {
    if (await shouldParkOnGate(ctx, resolution)) {
      if (turn < ctx.cfg.maxTurns) return RETRY_DIRECTIVE
    }
    return {
      kind: "finish",
      finish: {
        reason: resolution.reason,
        turns: resolution.turns,
        stopCategory: resolution.stopCategory,
        refusal: resolution.refusal,
      },
    }
  }
  return PROCEED_DIRECTIVE
}

export const runAgentTurnLoop = async (ctx: RunAgentContext): Promise<AgentOutcome> => {
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
    const preTurnStop = await firstPreTurnStop(ctx, turn)
    if (preTurnStop !== undefined) {
      return ctx.finish(preTurnStop.reason, preTurnStop.turns, preTurnStop.stopCategory)
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
      pendingPlanEntryRef: ctx.pendingPlanEntryRef,
      hookPromptPending: ctx.hookPromptPending,
    })
    const directive = await resolveTurnDirective(ctx, resolution, turn)
    if (directive.kind === "finish") {
      const f = directive.finish
      return ctx.finish(f.reason, f.turns, f.stopCategory, f.refusal)
    }
    if (directive.kind === "retry") continue
    const postContinueStop = firstPostContinueStop(ctx, turn)
    if (postContinueStop !== undefined) {
      return ctx.finish(
        postContinueStop.reason,
        postContinueStop.turns,
        postContinueStop.stopCategory,
      )
    }
  }
  return ctx.finish("max_turns", ctx.cfg.maxTurns, completedCategory("max_turns"))
}
