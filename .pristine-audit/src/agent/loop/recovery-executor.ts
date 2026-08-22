import type { SystemPromptInput } from "@/llm"
import { errMessage, logger } from "@/shared"
import {
  dropOldestSalvage,
  estimateTokens,
  reactiveCompact,
  resolveCompactionLimitTokens,
  TokenBaselineBox,
} from "../compaction"
import { metaUser, runGuardChain } from "../guards"
import { buildPostCompactEmit } from "../loop-helpers"
import type { RecoveryAction } from "../recovery"
import { extractRefusalRationale, neutralizedRefusalTurn } from "../recovery"
import { backoffDelayMs } from "../retry"
import type { ToolHistoryEntry } from "../session-resources"
import { stripOrphanToolUse } from "../turn-closeout"
import type { TurnSession, TurnState } from "../turn-context"
import { maybeRunCloseoutCritic } from "./closeout-critic-wire"
import { emitCompactionEvent } from "./compaction-wire"
import { resetEffortClassifier } from "./context-assembler"
import {
  emitRecovery,
  markObjectiveUsageLimitedFrom429,
  objectiveBudgetExhausted,
  resolveWindowModel,
} from "./emit-helpers"
import { sleep } from "./sleep"
import type { StreamSuccess, TurnResult } from "./types"

type Step = { done: false } | { done: true; result: TurnResult }

export const CONTINUE: Step = { done: false }

// Test seam for the reactive DROP-OLDEST salvage. Production ALWAYS uses the real
// `dropOldestSalvage`; a test that needs to observe the call (ALBB-07 spies on the
// `targetTokens` this executor computes from the active-model window) injects a
// spy HERE instead of `mock.module("@/agent/compaction")` — bun's module mock
// leaks process-globally and binds at collection, silently polluting sibling test
// files that use the real compaction (drop-oldest-salvage-hellgate). This seam
// contains the spy to the one file that sets it.
let salvageImpl = dropOldestSalvage
/** @internal test-only — inject a `dropOldestSalvage` spy/stub. Pair with reset. */
export const __setDropOldestSalvageForTest = (fn: typeof dropOldestSalvage): void => {
  salvageImpl = fn
}
/** @internal test-only — restore the real `dropOldestSalvage`. */
export const __resetDropOldestSalvageForTest = (): void => {
  salvageImpl = dropOldestSalvage
}

export const EMPTY_TOOL_HISTORY: readonly ToolHistoryEntry[] = Object.freeze([])

export const applyNonSuccessRecoveryAction = async (
  session: TurnSession,
  state: TurnState,
  action: RecoveryAction,
  result: StreamSuccess | { error: unknown; message: string },
  ctxSystem: SystemPromptInput,
  activeModel: string,
): Promise<Step | null> => {
  const { config } = session
  const { wm } = state
  // RFC-06 A4.3 — measured `usage_limited` PRODUCER. A same-turn recovery caused
  // by a provider 429 carries the classified `LLMError` (with the server's
  // `retry-after` delta) on `result.error`. Feed that MEASURED signal into the
  // objective as a transient usage window BEFORE dispatching the action, so a
  // `backoff` (retry pending) AND a terminal `error` (retries exhausted) both
  // mark the goal `usage_limited` until capacity returns. Gated + no-throw (see
  // `markObjectiveUsageLimitedFrom429`): default-OFF is byte-identical (the gate
  // returns before any objective mutation). Distinct from `recordUsage` (the
  // self-report ledger) — no double-count.
  markObjectiveUsageLimitedFrom429(config, config.sessionId ?? "", result)
  if (action.do === "error") {
    // Loop-control fix (jun-25, FIX-2): when the `error` terminal was minted
    // from a SUCCESSFULLY-assembled turn (the malformed-tool-use seal — the
    // model emitted visible text but no valid tool_use), preserve that final
    // assistant turn in working memory (mirrors the refusal path, and the C5
    // regression invariant) so the transcript / resume keeps the model's last
    // words rather than ending on the injected meta nudge. A THROWN stream
    // error carries no assembled message (`"error" in result`) ⇒ nothing to
    // append (byte-identical to the prior behaviour for that case).
    if (!("error" in result)) {
      wm.append(stripOrphanToolUse(result.message))
    }
    return { done: true, result: { kind: "error", reason: action.reason } }
  }
  if (action.do === "refusal") {
    const success = result as StreamSuccess
    const sealed = stripOrphanToolUse(success.message)
    wm.append(sealed)
    return {
      done: true,
      result: { kind: "refusal", rationale: action.rationale, message: sealed },
    }
  }
  if (action.do === "refusal_fallback") {
    // T08 — fork the refused turn off the transcript (replace it with a neutral
    // marker so role-alternation holds and the retry never re-anchors on the
    // prior "no"), then re-prompt ONCE with the fallback prompt. SAME turn (no
    // increment): the one-shot cap lives in `rec.refusalFallbacks`, already
    // consumed in `resolveTurnAction`, so this can never spin. Surfaced as a
    // `recovery`/`nudge` event with a `model_refusal_fallback` detail so the
    // recovery is visible (north-star) without minting a new event vocabulary.
    wm.append(neutralizedRefusalTurn())
    wm.append(metaUser(action.text))
    // Surface the refused rationale (clipped) in the recovery detail so the
    // recovery is observable ("why did it refuse") without leaking the full
    // refusal into the transcript (north-star: agent-state visibility).
    const why = extractRefusalRationale(action.message).slice(0, 120)
    emitRecovery(
      config,
      "nudge",
      `model_refusal_fallback (neutralizedByFork)${why.length > 0 ? `: ${why}` : ""}`,
    )
    return CONTINUE
  }
  if (action.do === "backoff") {
    emitRecovery(config, "backoff", `attempt ${action.attempt}`)
    await sleep(backoffDelayMs(action.attempt), config.signal)
    return CONTINUE
  }
  if (action.do !== "compact") return null
  return applyCompactRecovery(session, state, ctxSystem, activeModel)
}

/**
 * §PTL / §13.3 — the reactive-compaction recovery arm of {@link
 * applyNonSuccessRecoveryAction} (extracted to keep that dispatcher under the
 * god-function size gate). Runs the breaker check, the reactive squeeze (or the
 * drop-oldest salvage when the knob is ON), replaces the transcript, invalidates
 * the token baseline, then fires the observable post-compact hook + advisory.
 * Returns the loop Step — CONTINUE, or a terminal error when the breaker aborts
 * or the squeeze fails. Pure dispatch of what was the `compact` branch inline.
 */
const applyCompactRecovery = async (
  session: TurnSession,
  state: TurnState,
  ctxSystem: SystemPromptInput,
  activeModel: string,
): Promise<Step> => {
  const { config } = session
  const { wm, breaker } = state
  emitRecovery(config, "compact")
  const verdict = breaker?.check()
  if (verdict?.abort) return { done: true, result: { kind: "error", reason: verdict.reason } }
  const snapshot = [...wm.snapshot()]
  // FULL-snapshot read: O(1) `tokenTotal()` byte-identical to the re-scan when
  // the counter is wired (knob ON); falls back to `estimateTokens` when OFF.
  const before =
    (wm as typeof wm & { tokenTotal?(): number }).tokenTotal?.() ?? estimateTokens(snapshot)
  const summarizerLlm = config.compaction?.summarizerLlm ?? config.llm
  // §13.3 (jun-08) — DROP-OLDEST salvage. DEFAULT-OFF: when the knob is absent
  // we call `reactiveCompact` exactly as before (byte-identical — same single
  // squeeze, same `{ok:false}`→abort on failure). When ON, `dropOldestSalvage`
  // wraps the SAME reactive squeeze but, on failure, sheds the oldest retained
  // turn and retries instead of aborting. Both return the same `{ok, messages,
  // summaryTokens}` shape so the wire below is unchanged.
  const compacted =
    config.compaction?.dropOldestSalvage === true
      ? await salvageImpl({
          messages: snapshot,
          llm: summarizerLlm,
          system: ctxSystem,
          // Target the SAME compaction limit the loop uses (model-derived when
          // a window is known; explicit override wins). The hard-drop fallback
          // stops shedding as soon as the transcript would re-fit, so it never
          // drops more than necessary. Omitted limit ⇒ the fallback drops to
          // the floor (forward progress guaranteed). The model id MUST be passed
          // (mirrors compaction-wire's proactive path) — without it the target
          // silently collapses to the 120k legacy floor and over-sheds on a
          // large-window model.
          targetTokens: resolveCompactionLimitTokens(
            config.compaction?.thresholdTokens,
            // claim 2 (ALBB-07) — thread the ALREADY-RESOLVED active turn model
            // (skill/sticky swap) into the window resolve, mirroring the PROACTIVE
            // SSOT (`compaction-wire.ts` `resolveWindowModel(config.llm,
            // activeModel)`). A bare `resolveWindowModel(config.llm)` defaults to
            // the BASE model → under-sheds when a smaller-window model is active.
            resolveWindowModel(config.llm, activeModel),
          ),
          // ALBB-20 #13 — thread the turn's cancellation signal into the summarizer
          // LLM stream so a reactive compaction is interruptible on Ctrl+C/deadline.
          // Absent ⇒ byte-identical (signal-presence gated).
          ...(config.signal !== undefined ? { signal: config.signal } : {}),
        })
      : await reactiveCompact({
          messages: snapshot,
          llm: summarizerLlm,
          system: ctxSystem,
          // ALBB-20 #13 — interruptible reactive summarizer (see above).
          ...(config.signal !== undefined ? { signal: config.signal } : {}),
        })
  // ALBB-08 Claim 3 (INTENTIONAL skip, measure-first) — a reactive empty/refused
  // summary (`!compacted.ok`) returns BEFORE `recordReactive` below, so it accrues
  // NO reactive strike. Unlike the PROACTIVE path (which loops pre-sampling and so
  // MUST strike — ALBB-08 Fix 1), the reactive path terminates HERE in a hard
  // `kind:"error"`: the turn ends, there is no spin to break. Adding a strike would
  // be an arbitrary threshold with no repro of a reactive-refusal loop to justify
  // it; if one ever surfaces, move a `recordReactive(before, before)` ahead of this
  // return. The reactive breaker cap already backstops repeated reactive failures.
  if (!compacted.ok) return { done: true, result: { kind: "error", reason: compacted.reason } }
  const after = estimateTokens(compacted.messages)
  breaker?.recordReactive(before, after)
  emitCompactionEvent(config, {
    kind: "compaction_event",
    trigger: "mid_turn",
    reason: "context_limit",
    tokensBefore: before,
    tokensAfter: after,
    messagesRemoved: Math.max(snapshot.length - compacted.messages.length, 0),
    at: Date.now(),
  })
  wm.replace(compacted.messages)
  // D5 (jun-7) — reactive compaction replaced the transcript prefix, so any
  // token-baseline measured against the OLD prefix is now stale (its index would
  // mis-map once the transcript regrows). Invalidate it; a fresh exact usage
  // re-establishes the baseline against the new prefix. SSOT (jul-2): route through
  // the owner method instead of poking `.current` raw — `invalidateOnContentChange`
  // is the unconditional clear (identical effect to the prior raw assignment) so
  // every invalidation site now goes through {@link TokenBaselineBox}.
  if (state.tokenBaseline !== undefined)
    TokenBaselineBox.wrap(state.tokenBaseline).invalidateOnContentChange()
  resetEffortClassifier(config.effortClassifier)
  const provenance: import("../recovery-reason").RecoveryProvenance = {
    reason: "ptl_reactive",
    tokensBefore: before,
    tokensAfter: after,
    turnsDropped: Math.max(snapshot.length - compacted.messages.length, 0),
    turnsKept: compacted.messages.length,
    compactedAt: Date.now(),
  }
  const threadId = config.sessionId ?? ""
  // claim 1 (ALBB-07) — post-compact hook + advisory next-actions, OBSERVABLE.
  //
  // The `post_compact` HookBus emit routes through the SHARED
  // `buildPostCompactEmit` SSOT (identical shape to the PROACTIVE path's
  // `compaction-wire.ts` — no duplicated inline emit that can drift). Formerly
  // this whole block sat inside a bare `try { … } catch {}` that swallowed a
  // throwing subscriber (or a throwing `setNextActions`) with NO `logger.warn`
  // and NO stream event — invisible to the agent-state stream. Now a throw from
  // EITHER side is surfaced: a `logger.warn` AND a `recovery` event (reusing the
  // existing `emitRecovery` seam — no new event vocabulary) so the failed
  // post-compact is observable (north-star). The loop MUST still complete
  // (no-throw contract preserved); on the happy path (no throw) this is
  // byte-identical (a `post_compact` emit + the same advisory `setNextActions`).
  const postCompactEmit = buildPostCompactEmit(config.hooks, threadId)
  if (postCompactEmit !== undefined) {
    try {
      await postCompactEmit(provenance)
    } catch (e) {
      surfacePostCompactFailure(session, "post_compact hook", e)
    }
  }
  if (
    config.objective !== undefined &&
    threadId.length > 0 &&
    !objectiveBudgetExhausted(config, threadId)
  ) {
    try {
      config.objective.setNextActions(threadId, [
        "Resuming after mid-turn compaction (PTL recovery)",
      ])
    } catch (e) {
      surfacePostCompactFailure(session, "post_compact setNextActions", e)
    }
  }
  return CONTINUE
}

/** claim 1 (ALBB-07) — make a swallowed reactive post-compact failure OBSERVABLE
 *  without breaking the no-throw contract: a `logger.warn` (operator log) AND a
 *  `recovery` stream event (agent-state surface; reuses {@link emitRecovery}, no
 *  new event type). `stage` names which sub-step failed (hook vs setNextActions)
 *  so the surfaced detail answers "why is the resume nudge missing". Never
 *  rethrows. */
const surfacePostCompactFailure = (session: TurnSession, stage: string, e: unknown): void => {
  logger.warn(`loop.reactiveCompact.${stage}: ${errMessage(e)}`)
  emitRecovery(session.config, "compact", `${stage} failed: ${errMessage(e)}`)
}

export const applyAction = async (
  session: TurnSession,
  state: TurnState,
  action: RecoveryAction,
  result: StreamSuccess | { error: unknown; message: string },
  ctxSystem: SystemPromptInput,
  history: readonly ToolHistoryEntry[],
  activeModel: string,
): Promise<Step> => {
  const { config, guards } = session
  const { wm, toolChoiceState } = state
  const nonSuccessStep = await applyNonSuccessRecoveryAction(
    session,
    state,
    action,
    result,
    ctxSystem,
    activeModel,
  )
  if (nonSuccessStep !== null) return nonSuccessStep
  const success = result as StreamSuccess
  const message = success.message
  if (guards.length > 0) {
    const blocked = runGuardChain(guards, {
      action,
      message,
      wm,
      history,
      toolChoiceState,
      emit: (reason) => emitRecovery(config, reason),
    })
    if (blocked !== undefined) return CONTINUE
  }
  if (action.do === "completed") {
    const criticDone = maybeRunCloseoutCritic(session, message, history)
    if (criticDone !== undefined) await criticDone
    wm.append(message)
    return { done: true, result: { kind: "completed", message } }
  }
  if (action.do === "nudge") {
    emitRecovery(config, action.reason)
    if (action.keepMessage) wm.append(message)
    wm.append(metaUser(action.text))
    return CONTINUE
  }
  const toolCalls = message.content.filter((b) => b.type === "tool_use")
  if (toolCalls.length === 0) {
    const criticDone = maybeRunCloseoutCritic(session, message, history)
    if (criticDone !== undefined) await criticDone
    wm.append(message)
    return { done: true, result: { kind: "completed", message } }
  }
  wm.append(message)
  return { done: true, result: { kind: "tools", message, resultBlocks: success.resultBlocks } }
}
