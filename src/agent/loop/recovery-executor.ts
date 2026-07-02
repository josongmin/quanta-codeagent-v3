import { isRefusalStopReason, type SystemPromptInput } from "@/llm"
import { runCloseoutCritic } from "../closeout-critic"
import {
  dropOldestSalvage,
  estimateTokens,
  reactiveCompact,
  resolveCompactionLimitTokens,
  TokenBaselineBox,
} from "../compaction"
import { metaUser, runGuardChain } from "../guards"
import type { AssembledMessage, RecoveryAction, RecoveryState } from "../recovery"
import {
  decideFromStopPolicy,
  decideOnAssembled,
  decideOnStreamError,
  extractRefusalRationale,
  neutralizedRefusalTurn,
  RECOVERY_CAPS,
} from "../recovery"
import { DEFAULT_REFUSAL_FALLBACK_PROMPT } from "../refusal-fallback"
import { backoffDelayMs } from "../retry"
import type { ToolHistoryEntry } from "../session-resources"
import { stripOrphanToolUse } from "../turn-closeout"
import type { TurnSession, TurnState } from "../turn-context"
import type { AgentConfig } from "../types"
import { emitCompactionEvent } from "./compaction-wire"
import { resetEffortClassifier } from "./context-assembler"
import { emitRecovery, objectiveBudgetExhausted, resolveWindowModel } from "./emit-helpers"
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
          // the floor (forward progress guaranteed). The model id MUST be passed
          // (mirrors compaction-wire's proactive path) — without it the target
          // silently collapses to the 120k legacy floor and over-sheds on a
          // large-window model.
          targetTokens: resolveCompactionLimitTokens(
            config.compaction?.thresholdTokens,
            resolveWindowModel(config.llm),
          ),
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
  // re-establishes the baseline against the new prefix. SSOT (jul-2): route through
  // the owner method instead of poking `.current` raw — `invalidateOnContentChange`
  // is the unconditional clear (identical effect to the prior raw assignment) so
  // every invalidation site now goes through {@link TokenBaselineBox}.
  if (state.tokenBaseline !== undefined)
    TokenBaselineBox.wrap(state.tokenBaseline).invalidateOnContentChange()
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

/**
 * T08 — refusal-fallback decision inputs threaded into {@link resolveTurnAction}.
 * Kept as a tiny plain struct (no `AgentConfig` / `TurnState`) so the decision
 * stays a PURE, unit-testable function. `budgetOk` is a thunk so the (possibly
 * `taskBudget`-derived) check is evaluated only on a refusal-class stop.
 */
export interface RefusalFallbackInput {
  readonly enabled: boolean
  readonly prompt: string
  readonly budgetOk: () => boolean
}

/** Build the refusal-fallback input from config + live turn state, or
 *  `undefined` when the feature is OFF (so {@link resolveTurnAction} is
 *  byte-identical). Pure aside from reading the (already-accumulated) spend. */
export const buildRefusalFallbackInput = (
  config: AgentConfig,
  state: TurnState,
): RefusalFallbackInput | undefined => {
  const cfg = config.refusalFallback
  if (cfg === undefined || cfg.enabled !== true) return undefined
  return {
    enabled: true,
    prompt: cfg.prompt ?? DEFAULT_REFUSAL_FALLBACK_PROMPT,
    budgetOk: () => refusalForkBudgetOk(config, state),
  }
}

/** A refusal fork roughly DOUBLES the turn's token cost (re-prompt + re-stream).
 *  Gate it on the SOFT task budget: when a finite, positive `taskBudget` is set
 *  and the cumulative spend has already reached it, decline the fork (terminal).
 *  No `taskBudget` (or non-positive) ⇒ no ceiling to exceed ⇒ allowed. The
 *  boundary is the budget itself — NOT an arbitrary fraction
 *  ([[no-heuristics-only-validated]]). */
const refusalForkBudgetOk = (config: AgentConfig, state: TurnState): boolean => {
  const tb = config.taskBudget
  if (tb === undefined || !Number.isFinite(tb.tokens) || tb.tokens <= 0) return true
  const spent = state.taskSpend?.tokens ?? tb.spent ?? 0
  return spent < tb.tokens
}

export const resolveTurnAction = (
  policy: import("../stop-reason").StopReasonPolicy | undefined,
  result: StreamSuccess | { error: unknown; message: string },
  rec: RecoveryState,
  refusal?: RefusalFallbackInput,
): RecoveryAction => {
  if ("error" in result) return decideOnStreamError(result.error, result.message, rec)
  const stop = result.stopReason
  // T08 — refusal-fallback recovery. Provider-blind: the `isRefusalStopReason`
  // seam folds Anthropic `refusal` and OpenAI `content_filtered` onto one check,
  // so this branch is identical for both vendors. Checked BEFORE the legacy
  // mapping so a recovered/exhausted refusal never runs `decideOnAssembled`'s
  // mutating empty/nudge accounting (which would corrupt same-turn budgets).
  //
  // GUARD — only recover a CLEAN, text-only refusal. A refusal-class stop that
  // ALSO carried a `tool_use` block already (partially) dispatched those calls
  // in `streamingTurn`: `content_filtered` does NOT take the in-stream
  // short-circuit (only `refusal` does, streaming-dispatch.ts), so its deferred
  // MUTATING tools run. Neutralizing such a turn would discard executed-tool
  // results AND risk a re-execution on the re-prompt (double side effect). So a
  // tool-carrying refusal falls through to the legacy mapping (terminal for
  // `refusal`; pre-existing tool-proceed for `content_filtered`) — byte-identical
  // to the OFF path for that case.
  if (
    refusal?.enabled === true &&
    isRefusalStopReason(stop) &&
    !result.message.content.some((b) => b.type === "tool_use")
  ) {
    if (rec.refusalFallbacks < RECOVERY_CAPS.refusalFallbacks && refusal.budgetOk()) {
      rec.refusalFallbacks += 1
      return { do: "refusal_fallback", text: refusal.prompt, message: result.message }
    }
    // One-shot spent OR a fork would exceed budget ⇒ TERMINAL refusal. Surfaced
    // as `refusal` (not a generic error) for BOTH providers so a re-refusal —
    // including `content_filtered`, which the legacy mapping would let slip
    // through as `proceed` when no stop-policy is wired — never silently
    // completes and reads consistently to the host.
    return { do: "refusal", rationale: extractRefusalRationale(result.message) }
  }
  // OFF / non-refusal / tool-carrying refusal ⇒ legacy mapping verbatim
  // (byte-identical default).
  return decideFromStopPolicy(policy, stop) ?? decideOnAssembled(stop, result.message, rec)
}
