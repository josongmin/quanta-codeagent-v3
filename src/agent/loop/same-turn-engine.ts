import type { HookPromptInject } from "../hooks"
import { buildRefusalFallbackInput, resolveTurnAction } from "../recovery"
import type { TurnSession, TurnState } from "../turn-context"
import { prepareTurnContext } from "./context-assembler"
import { applyAction, EMPTY_TOOL_HISTORY } from "./recovery-executor"
import { resolveActiveModelId } from "./skill-gate"
import { streamConsume } from "./stream-consume"
import { buildTurnSessionView, classifyTurnAbort } from "./turn-gate"
import {
  applySteerSafePoint,
  drainConversationActionsMidTurn,
  finalizeBufferedSteersOnAbort,
  freshSteerSafePointState,
} from "./turn-iteration"
import type { TurnResult } from "./types"

/** The per-turn subagent-gate view (`undefined` when the gate is unwired). */
type TurnGateView = ReturnType<typeof buildTurnSessionView>["gate"]

/** The assembled turn context `prepareTurnContext` hands back. */
type TurnContext = Awaited<ReturnType<typeof prepareTurnContext>>["ctx"]

/** The loop-owned steer FIFO + extra-round budget for ONE `runTurn` call. */
type SteerSafePoint = ReturnType<typeof freshSteerSafePointState>

/** True when THIS turn must unwind: the loop-lifetime signal aborted, or the
 *  subagent gate recorded a per-turn interrupt.
 *
 *  UNIT because the identical disjunction was spelled at FOUR points in
 *  `runTurn` (pre-round, post-prep, post-stream, and the steer supersede test)
 *  and every one of them has to stay in lockstep — a spelling that drifts from
 *  its siblings is exactly the ALBB-20 #14 class of bug that added the
 *  post-prep check in the first place. One predicate ⇒ one place to be right.
 *  Order of reads is load-bearing: the signal is read FIRST and short-circuits
 *  the gate call, so a gate observer never sees a probe on an already-cancelled
 *  turn. */
const turnAbortSignalled = (config: TurnSession["config"], gate: TurnGateView): boolean =>
  config.signal.aborted || gate?.wasInterrupted() === true

/** Unwind the turn on an abort: cancel the speculative background compaction
 *  (its consumer is gone) and classify interrupt-vs-lifetime-cancel.
 *
 *  UNIT because the pre-round, post-prep and post-stream exits carried this
 *  exact two-statement body inline; the only thing that ever differed between
 *  the three copies was the comment above them. Keeping them one function
 *  makes "every abort exit cancels bgCompaction" a structural fact rather than
 *  a review obligation. */
const settleTurnAbort = (session: TurnSession, gate: TurnGateView): TurnResult => {
  session.bgCompaction?.cancelIfPending()
  return classifyTurnAbort(gate, session.config.signal)
}

/** Take — and clear — the hook-prompt injects queued for THIS turn.
 *
 *  UNIT because read-then-drain is one indivisible hand-off: the copy MUST be
 *  taken before the length reset, and an EMPTY pending buffer must yield
 *  `undefined` rather than `[]` so the assembled prompt stays byte-identical.
 *  Mutating the caller's array is the contract, not a side effect to hide. */
const takeHookPromptInjects = (
  pending: HookPromptInject[] | undefined,
): readonly HookPromptInject[] | undefined => {
  const injects: readonly HookPromptInject[] | undefined =
    pending !== undefined && pending.length > 0 ? [...pending] : undefined
  if (pending !== undefined) pending.length = 0
  return injects
}

/**
 * UUX-5-05 — MID-turn conversation-action drain, at the top of the SAME-turn
 * re-stream loop. Returns a terminal {@link TurnResult} when a `/cancel` landed
 * mid-loop, otherwise `undefined` (proceed with the round).
 *
 * UNIT because the drain's ADMISSION rule (`streamRound > 0`) and its ONE
 * non-continue outcome belong together: a caller that kept the round gate
 * outside would be free to drain at iteration 0, which is precisely what the
 * coverage map below forbids. Drain coverage map:
 *   - BETWEEN tool rounds: already covered — each `{kind:"tools"}` round
 *     returns to the outer loop, whose `prepareTurnIteration` →
 *     `syncQueuedTurnInputs` drains before the next round.
 *   - WITHIN this same-turn loop (nudge / retry / PTL / guard-blocked
 *     re-streams): previously UN-drained — a turn stuck in the empty/
 *     malformed nudge cycle could run many LLM streams while a queued
 *     `/cancel` or `/summarize-now` waited for the turn to seal. This
 *     drain closes that window. Iteration 0 is skipped: the boundary
 *     drain ran just before `runTurn`, so nothing can have queued yet.
 *   - WITHIN one stream round (a multi-tool_use batch dispatching inside
 *     `streamConsume`): deliberately NOT drained — the assistant message
 *     is still being assembled and is not yet in `wm`, so an on-demand
 *     compaction's `wm.replace` there could orphan the in-flight
 *     tool_use ids. This seam (post-append, pre-stream) is the same
 *     structurally-safe point the proactive compaction already uses
 *     (`prepareTurnContext` → `maybeCompact` runs right below).
 * Default-OFF byte-identical: `conversationActionPort` is only wired when
 * QUANTA_CONVERSATION_ACTIONS is on; absent ⇒ one property read, no-op.
 */
const drainMidTurnActions = async (
  session: TurnSession,
  state: TurnState,
  turnConfig: TurnSession["config"],
  streamRound: number,
): Promise<TurnResult | undefined> => {
  if (streamRound === 0) return undefined
  const drained = await drainConversationActionsMidTurn({
    cfg: turnConfig,
    wm: state.wm,
    taskRegistry: session.taskRegistry,
    tokenBaseline: state.tokenBaseline,
  })
  if (drained !== "aborted_captured") return undefined
  // A `/cancel` landed mid-loop: the drain already captured the partial turn
  // (conversation_cancel) + emitted `interrupted`. Unwind exactly like the
  // pre-round abort check. NOT routed through `classifyTurnAbort` — neither the
  // lifetime signal nor the subagent gate fired; this is a cooperative
  // conversation-action abort. `captured:true` tells `resolveTurnLoopOutcome`'s
  // aborted arm NOT to re-capture with the generic `turn_result_abort` reason
  // (which would clobber the precise conversation_cancel capture — ALBB-06).
  session.bgCompaction?.cancelIfPending()
  return { kind: "aborted", captured: true }
}

/** Outcome of the pre-stream half of one round: either a context ready to
 *  stream, or a terminal result the loop must return immediately. */
type PreparedRound =
  | { readonly kind: "ready"; readonly ctx: TurnContext; readonly activeModel: string }
  | { readonly kind: "exit"; readonly result: TurnResult }

/**
 * Resolve the active model and assemble the turn context for ONE round.
 *
 * UNIT because everything here happens strictly BEFORE any token is sampled,
 * and the two early exits it owns are both consequences of that prep work:
 *   - D4 (jun-7) — resolve the model that will ACTUALLY process this turn
 *     (sticky-model / skill override) BEFORE compaction, so the window
 *     threshold tracks the ACTIVE model, not the base `config.llm`.
 *     `streamConsume` re-resolves the full `turnLlm` for the stream.
 *   - ALBB-20 #14 — `prepareTurnContext` awaits provider work (ideContext
 *     snapshot, effort classifier, compaction summarizer). An abort that lands
 *     DURING prep was only checked at the top of the loop, so it would
 *     otherwise surface only AFTER a full stream turn ran. Re-check here,
 *     before `streamConsume`, via the SAME `settleTurnAbort` path.
 * The breaker verdict is checked first, exactly as the inline code did — a
 * hard breaker abort outranks a concurrent cancel.
 */
const prepareRound = async (args: {
  readonly turn: number
  readonly session: TurnSession
  readonly state: TurnState
  readonly gate: TurnGateView
  readonly turnConfig: TurnSession["config"]
  readonly activeSkills:
    | ReturnType<NonNullable<TurnSession["skillRuntime"]>["activeInventory"]>
    | undefined
  readonly turnInjects: readonly HookPromptInject[] | undefined
}): Promise<PreparedRound> => {
  const { session, state, turnConfig } = args
  const activeModel = await resolveActiveModelId(turnConfig, session.skillGate?.activeOverride())
  const { ctx, breakerVerdict } = await prepareTurnContext({
    config: turnConfig,
    wm: state.wm,
    recorder: session.recorder,
    breaker: state.breaker,
    activeSkills: args.activeSkills,
    workingState: state.workingState,
    archive: session.archive,
    turn: args.turn,
    citations: state.citations,
    hookPromptInjects: args.turnInjects,
    taskSpend: state.taskSpend,
    bgController: session.bgCompaction,
    tokenBaselineBox: state.tokenBaseline,
    activeModel,
  })
  if (breakerVerdict.abort)
    return { kind: "exit", result: { kind: "error", reason: breakerVerdict.reason } }
  if (turnAbortSignalled(session.config, args.gate)) {
    return { kind: "exit", result: settleTurnAbort(session, args.gate) }
  }
  return { kind: "ready", ctx, activeModel }
}

/**
 * WS4 (RFC jul-18 §3.5) — POST-STREAM STEER SAFE-POINT. Answers ONE question:
 * may this otherwise-final turn re-stream to absorb a pending steer?
 *
 * UNIT because the admission rule and the drain are inseparable —
 * `applySteerSafePoint` must be reached ONLY on an otherwise-FINAL
 * (`completed` / end_turn) turn; a `tools`/`error`/`refusal` step already
 * continues or terminates on its own merit and must stay byte-identical. The
 * supersede read sits inside the gate for the same reason: an interrupt /
 * lifetime abort that landed by now SUPERSEDES the pending steer (it is
 * preserved via mailbox fallback, never applied), and probing the signal on a
 * turn that was never eligible would be an observable extra read. When no drain
 * view is wired (gate OFF) this returns after ONE property read, so the whole
 * seam is byte-identical default-OFF.
 */
const shouldRestreamForSteer = (
  session: TurnSession,
  gate: TurnGateView,
  state: TurnState,
  steerSafePoint: SteerSafePoint,
  result: TurnResult,
): boolean => {
  const config = session.config
  if (config.childSteerDrain === undefined || result.kind !== "completed") return false
  const superseded = turnAbortSignalled(config, gate)
  return applySteerSafePoint(config, state.wm, steerSafePoint, superseded).continue
}

export const runTurn = async (
  turn: number,
  session: TurnSession,
  state: TurnState,
): Promise<TurnResult> => {
  const { config } = session
  // RFC-06 F3 — read the LIVE active-skill inventory for THIS turn (not a frozen
  // session array); a skill disabled after session start drops from the prompt
  // reminder on the next turn. Absent reader ⇒ undefined ⇒ no block.
  const activeSkills = session.skillRuntime?.activeInventory()
  const { rec, toolHistory } = state
  const { turnSession, gate } = buildTurnSessionView(session)
  const turnConfig = turnSession.config
  const turnInjects = takeHookPromptInjects(session.hookPromptPending)
  // Loop-invariant: `state.toolHistory` is read once, so the fallback is too.
  const history = toolHistory ?? EMPTY_TOOL_HISTORY
  let streamRound = 0
  // WS4 (RFC jul-18 §3.5) — the loop-owned steer FIFO buffer + extra-round budget
  // for THIS turn invocation. Only ever touched when the child steer-drain view is
  // wired (gate ON); default-OFF this stays an empty `{drained:[],applied:0}` that
  // `applySteerSafePoint` returns from after ONE property read.
  const steerSafePoint = freshSteerSafePointState()
  try {
    for (;;) {
      if (turnAbortSignalled(config, gate)) return settleTurnAbort(session, gate)
      const midTurnExit = await drainMidTurnActions(session, state, turnConfig, streamRound)
      if (midTurnExit !== undefined) return midTurnExit
      streamRound += 1
      const round = await prepareRound({
        turn,
        session,
        state,
        gate,
        turnConfig,
        activeSkills,
        turnInjects,
      })
      if (round.kind === "exit") return round.result
      const result = await streamConsume(turnSession, state, round.ctx)
      // A stream-originated abort ends the turn before its normal boundary, so
      // speculative compaction no longer has a consumer — same early-exit
      // contract as the pre-round, mid-loop-action and post-prep abort paths.
      if ("aborted" in result) return settleTurnAbort(session, gate)
      // T08 — refusal-fallback recovery input (undefined ⇒ OFF, byte-identical).
      const refusalFallback = buildRefusalFallbackInput(turnConfig, state)
      const action = resolveTurnAction(turnConfig.stopReasonPolicy, result, rec, refusalFallback)
      const step = await applyAction(
        turnSession,
        state,
        action,
        result,
        round.ctx.system,
        history,
        // claim 2 (ALBB-07) — the SAME `activeModel` resolved for this round (and
        // already threaded into `prepareTurnContext`), so the reactive
        // `dropOldestSalvage` window target tracks the ACTIVE model (skill/sticky
        // swap), not the base `config.llm`. Previously dropped here.
        round.activeModel,
      )
      // Not done ⇒ another same-turn round (tools / nudge / retry / PTL).
      if (!step.done) continue
      // Otherwise-final turn: the steer safe-point gets first refusal on it.
      if (shouldRestreamForSteer(session, gate, state, steerSafePoint, step.result)) {
        continue // re-stream the SAME turn with the injection
      }
      return step.result
    }
  } finally {
    // R2-MED-1 — finalize any steer left buffered when the turn exits via an abort
    // (mid multi-steer re-stream); no-op on normal completion / gate-OFF.
    finalizeBufferedSteersOnAbort(config, steerSafePoint)
  }
}
