import type { SystemPromptInput } from "@/llm"
import { runCloseoutCritic } from "../closeout-critic"
import {
  dropOldestSalvage,
  estimateTokens,
  reactiveCompact,
  resolveCompactionLimitTokens,
} from "../compaction"
import { metaUser, runGuardChain } from "../guards"
import type { AssembledMessage, RecoveryAction } from "../recovery"
import {
  decideFromStopPolicy,
  decideOnAssembled,
  decideOnStreamError,
  extractRefusalRationale,
} from "../recovery"
import { backoffDelayMs } from "../retry"
import type { ToolHistoryEntry } from "../session-resources"
import { stripOrphanToolUse } from "../turn-closeout"
import type { TurnSession, TurnState } from "../turn-context"
import { emitCompactionEvent } from "./compaction-wire"
import { resetEffortClassifier } from "./context-assembler"
import { emitRecovery, objectiveBudgetExhausted } from "./emit-helpers"
import { sleep } from "./sleep"
import type { StreamSuccess, TurnResult } from "./types"

type Step = { done: false } | { done: true; result: TurnResult }

export const CONTINUE: Step = { done: false }

export const EMPTY_TOOL_HISTORY: readonly ToolHistoryEntry[] = Object.freeze([])

export const applyNonSuccessRecoveryAction = async (
  session: TurnSession,
  state: TurnState,
  action: RecoveryAction,
  result: StreamSuccess | { error: unknown; message: string },
  ctxSystem: SystemPromptInput,
): Promise<Step | null> => {
  const { config } = session
  const { wm, breaker } = state
  if (action.do === "error") {
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
  if (action.do === "backoff") {
    emitRecovery(config, "backoff", `attempt ${action.attempt}`)
    await sleep(backoffDelayMs(action.attempt), config.signal)
    return CONTINUE
  }
  if (action.do !== "compact") return null
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
      ? await dropOldestSalvage({
          messages: snapshot,
          llm: summarizerLlm,
          system: ctxSystem,
          // Target the SAME compaction limit the loop uses (model-derived when
          // a window is known; explicit override wins). The hard-drop fallback
          // stops shedding as soon as the transcript would re-fit, so it never
          // drops more than necessary. Omitted limit ⇒ the fallback drops to
          // the floor (forward progress guaranteed).
          targetTokens: resolveCompactionLimitTokens(config.compaction?.thresholdTokens),
        })
      : await reactiveCompact({ messages: snapshot, llm: summarizerLlm, system: ctxSystem })
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
  // re-establishes the baseline against the new prefix.
  if (state.tokenBaseline !== undefined) state.tokenBaseline.current = undefined
  resetEffortClassifier(config.effortClassifier)
  try {
    const provenance: import("../recovery-reason").RecoveryProvenance = {
      reason: "ptl_reactive",
      tokensBefore: before,
      tokensAfter: after,
      turnsDropped: Math.max(snapshot.length - compacted.messages.length, 0),
      turnsKept: compacted.messages.length,
      compactedAt: Date.now(),
    }
    const threadId = config.sessionId ?? ""
    await config.hooks?.emit({ type: "post_compact", threadId, provenance })
    if (
      config.objective !== undefined &&
      threadId.length > 0 &&
      !objectiveBudgetExhausted(config, threadId)
    ) {
      config.objective.setNextActions(threadId, [
        "Resuming after mid-turn compaction (PTL recovery)",
      ])
    }
  } catch {
    // No-throw.
  }
  return CONTINUE
}

/**
 * Closeout-critic seam (P12). Invoked at the EXACT moment the loop is about to
 * seal a `{kind:"completed"}` turn, BEFORE that result is returned. Default-OFF
 * and FAIL-OPEN by construction:
 *
 *   - `runCloseoutCritic` short-circuits to `undefined` BEFORE any await when
 *     the knob is OFF (`config.closeoutCritic === undefined` / `enabled !==
 *     true`) or the critic port is absent — so the completion path stays
 *     byte-identical (no allocation here either: `config.closeoutCritic` read
 *     + a single sync call that returns immediately; the `req` object is built
 *     lazily only AFTER the OFF gate, so OFF allocates nothing extra).
 *   - a returned observation is surfaced as an EXISTING `recovery` event under
 *     the `closeout` reason — advisory data only. It is NEVER inspected for
 *     control flow; the loop seals `completed` regardless of the verdict.
 *   - this helper itself never throws (the underlying helper catches every
 *     critic failure and converts it to an observation detail).
 *
 * Returns `undefined` SYNCHRONOUSLY when the knob is OFF / port absent — so the
 * caller skips the `await` entirely and the completion seal stays byte-identical
 * (no microtask boundary, no `wm.append` reordering, no allocation). Only when
 * the critic is wired does it return a real promise the caller awaits.
 */
const maybeRunCloseoutCritic = (
  session: TurnSession,
  message: AssembledMessage,
  history: readonly ToolHistoryEntry[],
): Promise<void> | undefined => {
  const { config } = session
  const cfg = config.closeoutCritic
  // OFF gate FIRST — byte-identical: no `req` allocation, no emit, no promise,
  // no await when OFF / port absent.
  if (cfg === undefined || cfg.enabled !== true || cfg.critic === undefined) return undefined
  return (async () => {
    const observation = await runCloseoutCritic(cfg, {
      finalText: extractRefusalRationale(message),
      history: history.map((h) => ({ name: h.name })),
      signal: config.signal,
    })
    if (observation !== undefined) emitRecovery(config, "closeout", observation.detail)
  })()
}

export const applyAction = async (
  session: TurnSession,
  state: TurnState,
  action: RecoveryAction,
  result: StreamSuccess | { error: unknown; message: string },
  ctxSystem: SystemPromptInput,
  history: readonly ToolHistoryEntry[],
): Promise<Step> => {
  const { config, guards } = session
  const { wm, toolChoiceState } = state
  const nonSuccessStep = await applyNonSuccessRecoveryAction(
    session,
    state,
    action,
    result,
    ctxSystem,
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

export const resolveTurnAction = (
  policy: import("../stop-reason").StopReasonPolicy | undefined,
  result: StreamSuccess | { error: unknown; message: string },
  rec: import("../recovery").RecoveryState,
): RecoveryAction => {
  if ("error" in result) return decideOnStreamError(result.error, result.message, rec)
  const override = decideFromStopPolicy(policy, result.stopReason)
  return override ?? decideOnAssembled(result.stopReason, result.message, rec)
}
