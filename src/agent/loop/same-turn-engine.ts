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
  freshSteerSafePointState,
} from "./turn-iteration"
import type { TurnResult } from "./types"

export const runTurn = async (
  turn: number,
  session: TurnSession,
  state: TurnState,
): Promise<TurnResult> => {
  const { config, recorder, activeSkills, archive, hookPromptPending, bgCompaction } = session
  const { wm, rec, breaker, toolHistory, workingState, citations } = state
  const { turnSession, gate } = buildTurnSessionView(session)
  const turnConfig = turnSession.config
  const turnInjects: readonly HookPromptInject[] | undefined =
    hookPromptPending !== undefined && hookPromptPending.length > 0
      ? [...hookPromptPending]
      : undefined
  if (hookPromptPending !== undefined) hookPromptPending.length = 0
  let streamRound = 0
  // WS4 (RFC jul-18 §3.5) — the loop-owned steer FIFO buffer + extra-round budget
  // for THIS turn invocation. Only ever touched when the child steer-drain view is
  // wired (gate ON); default-OFF this stays an empty `{drained:[],applied:0}` that
  // `applySteerSafePoint` returns from after ONE property read.
  const steerSafePoint = freshSteerSafePointState()
  for (;;) {
    if (config.signal.aborted || gate?.wasInterrupted() === true) {
      bgCompaction?.cancelIfPending()
      return classifyTurnAbort(gate, config.signal)
    }
    // UUX-5-05 — MID-turn conversation-action drain, at the top of the
    // SAME-turn re-stream loop. Drain coverage map:
    //   - BETWEEN tool rounds: already covered — each `{kind:"tools"}` round
    //     returns to the outer loop, whose `prepareTurnIteration` →
    //     `syncQueuedTurnInputs` drains before the next round.
    //   - WITHIN this same-turn loop (nudge / retry / PTL / guard-blocked
    //     re-streams): previously UN-drained — a turn stuck in the empty/
    //     malformed nudge cycle could run many LLM streams while a queued
    //     `/cancel` or `/summarize-now` waited for the turn to seal. This
    //     drain closes that window. Iteration 0 is skipped: the boundary
    //     drain ran just before `runTurn`, so nothing can have queued yet.
    //   - WITHIN one stream round (a multi-tool_use batch dispatching inside
    //     `streamConsume`): deliberately NOT drained — the assistant message
    //     is still being assembled and is not yet in `wm`, so an on-demand
    //     compaction's `wm.replace` there could orphan the in-flight
    //     tool_use ids. This seam (post-append, pre-stream) is the same
    //     structurally-safe point the proactive compaction already uses
    //     (`prepareTurnContext` → `maybeCompact` runs right below).
    // Default-OFF byte-identical: `conversationActionPort` is only wired when
    // QUANTA_CONVERSATION_ACTIONS is on; absent ⇒ one property read, no-op.
    if (streamRound > 0) {
      const drained = await drainConversationActionsMidTurn({
        cfg: turnConfig,
        wm,
        taskRegistry: session.taskRegistry,
        tokenBaseline: state.tokenBaseline,
      })
      if (drained === "aborted_captured") {
        // A `/cancel` landed mid-loop: the drain already captured the partial
        // turn (conversation_cancel) + emitted `interrupted`. Unwind exactly
        // like the pre-round abort check above. NOT routed through
        // `classifyTurnAbort` — neither the lifetime signal nor the subagent
        // gate fired; this is a cooperative conversation-action abort.
        // `captured:true` tells `resolveTurnLoopOutcome`'s aborted arm NOT to
        // re-capture with the generic `turn_result_abort` reason (which would
        // clobber the precise conversation_cancel capture — ALBB-06 class).
        bgCompaction?.cancelIfPending()
        return { kind: "aborted", captured: true }
      }
    }
    streamRound += 1
    // D4 (jun-7) — resolve the model that will ACTUALLY process this turn
    // (sticky-model / skill override), so compaction's window threshold tracks
    // the ACTIVE model, not the base `config.llm`. Resolved here, before
    // compaction; `streamConsume` re-resolves the full `turnLlm` for the stream.
    const activeModel = await resolveActiveModelId(turnConfig, session.skillGate?.activeOverride())
    const { ctx, breakerVerdict } = await prepareTurnContext({
      config: turnConfig,
      wm,
      recorder,
      breaker,
      activeSkills,
      workingState,
      archive,
      turn,
      citations,
      hookPromptInjects: turnInjects,
      taskSpend: state.taskSpend,
      bgController: bgCompaction,
      tokenBaselineBox: state.tokenBaseline,
      activeModel,
    })
    if (breakerVerdict.abort) return { kind: "error", reason: breakerVerdict.reason }
    // ALBB-20 #14 — `prepareTurnContext` awaits provider work (ideContext
    // snapshot, effort classifier, compaction summarizer). An abort that lands
    // DURING prep was only checked at the top of the loop (`:26`), so it would
    // otherwise surface only AFTER a full stream turn ran. Re-check here, before
    // entering `streamConsume`, so a mid-prep abort short-circuits immediately
    // via the SAME `classifyTurnAbort` path as the pre-prep check.
    if (config.signal.aborted || gate?.wasInterrupted() === true) {
      bgCompaction?.cancelIfPending()
      return classifyTurnAbort(gate, config.signal)
    }
    const result = await streamConsume(turnSession, state, ctx)
    // A stream-originated abort ends the turn before its normal boundary, so
    // speculative compaction no longer has a consumer. This is the same early
    // exit contract as the pre-round, mid-loop-action, and post-prep abort
    // paths above: cancel the in-flight summarizer before returning.
    if ("aborted" in result) {
      bgCompaction?.cancelIfPending()
      return classifyTurnAbort(gate, config.signal)
    }
    // T08 — refusal-fallback recovery input (undefined ⇒ OFF, byte-identical).
    const refusalFallback = buildRefusalFallbackInput(turnConfig, state)
    const action = resolveTurnAction(turnConfig.stopReasonPolicy, result, rec, refusalFallback)
    const step = await applyAction(
      turnSession,
      state,
      action,
      result,
      ctx.system,
      toolHistory ?? EMPTY_TOOL_HISTORY,
      // claim 2 (ALBB-07) — thread the SAME `activeModel` resolved above (and
      // already threaded into `prepareTurnContext`) into the recovery apply, so
      // the reactive `dropOldestSalvage` window target tracks the ACTIVE model
      // (skill/sticky swap), not the base `config.llm`. Previously dropped here.
      activeModel,
    )
    if (step.done) {
      // WS4 (RFC jul-18 §3.5) — POST-STREAM STEER SAFE-POINT. Only an otherwise-
      // FINAL (`completed` / end_turn) turn is a safe boundary to inject a pending
      // steer + re-stream the SAME turn; a `tools`/`error`/`refusal` step already
      // continues or terminates on its own merit and is left byte-identical. When
      // no drain view is wired (gate OFF) `applySteerSafePoint` returns after ONE
      // property read, so this whole branch is byte-identical default-OFF.
      if (config.childSteerDrain !== undefined && step.result.kind === "completed") {
        // An interrupt/lifetime abort that landed by now SUPERSEDES the pending
        // steer (it is preserved via mailbox fallback, never applied).
        const superseded = config.signal.aborted || gate?.wasInterrupted() === true
        const decision = applySteerSafePoint(config, wm, steerSafePoint, superseded)
        if (decision.continue) continue // re-stream the SAME turn with the injection
      }
      return step.result
    }
  }
}
