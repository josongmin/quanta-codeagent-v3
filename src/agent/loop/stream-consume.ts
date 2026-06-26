import type { StreamEvent } from "@/llm"
import {
  parseRateLimitSnapshot,
  proactiveDelayMs,
  snapshotToNotice,
} from "@/llm/ratelimit-snapshot"
import { attrs, createTurnTimingCapture, SPAN_NAMES, type Span, startSpan } from "@/observability"
import { abortReasonOf, errMessage, LLMError, runtimeConfig } from "@/shared"
import { estimateTokens, TokenBaselineBox } from "../compaction"
import { closeSamplingSpan, type SamplingUsage, samplingUsageFromEvent } from "../loop-helpers"
import type { buildTurnContext } from "../prompt"
import { createStreamDispatcher, type TurnTimingAnchors } from "../stream-callbacks"
import { streamingTurn } from "../streaming-dispatch"
import { consumeTurnSignals, resolveToolChoice } from "../tool-choice"
import { buildToolInputSeam } from "../tool-input-streaming"
import type { TurnSession, TurnState } from "../turn-context"
import type { AgentConfig } from "../types"
import {
  emitLlmContinuation,
  emitLlmRequest,
  emitUsage,
  finalizeTurnPolicy,
  isSessionApprovalRequiredError,
} from "./emit-helpers"
import {
  applyEffortClassifierFloor,
  filterSpecsByScope,
  readStickyModelForMode,
  resolveSkillTurnOverride,
} from "./skill-gate"
import type { StreamConsumeResult } from "./types"

/**
 * D5 (jun-7) — fold the provider's usage into the token-baseline box.
 *
 * S2 (jun-7 FINAL): the provider-aware cache arithmetic + the empty-model guard
 * + the `>= sentEstimate` exactness gate are now OWNED by {@link
 * TokenBaselineBox.capture} (the single owner of the D5 invariants). This stays
 * exported as a thin delegate so the red-on-injection capture test can exercise
 * the arithmetic without driving the whole stream. `undefined` box ⇒ no-op.
 */
export const captureTokenBaseline = (
  box: TurnState["tokenBaseline"],
  ev: {
    inputTokens: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    model: string
  },
  sentEstimate: number,
): void => {
  if (box === undefined) return
  TokenBaselineBox.wrap(box).capture(ev, sentEstimate)
}

async function* teeUsage(
  config: AgentConfig,
  src: AsyncIterable<StreamEvent>,
  recorder: TurnSession["recorder"],
  collector: TurnState["collector"],
  taskSpend: TurnState["taskSpend"],
  // D5 (jun-7) — the token-baseline box + the chars/4 estimate of the SENT
  // prompt. When the provider's authoritative `inputTokens` is at least our
  // estimate (the `exact` contract), record it paired with the send-time wm
  // count so the next turn's compaction trigger anchors on the provider's truth.
  tokenBaselineBox: TurnState["tokenBaseline"],
  sentEstimate: number,
  // Capture the provider's usage event so the sampling SPAN can carry model +
  // token attrs (the event otherwise only reaches the recorder/collector).
  onUsage?: (ev: Extract<StreamEvent, { type: "usage" }>) => void,
): AsyncIterable<StreamEvent> {
  const guarded =
    config.streamWatchdog !== undefined && config.streamTimeoutPolicy !== undefined
      ? config.streamWatchdog.wrap(src, config.streamTimeoutPolicy, config.signal)
      : src
  for await (const ev of guarded) {
    if (ev.type === "usage") {
      emitUsage(config, ev, recorder, collector, taskSpend)
      captureTokenBaseline(tokenBaselineBox, ev, sentEstimate)
      onUsage?.(ev)
    }
    if (ev.type === "llm_continuation") emitLlmContinuation(config, ev)
    if (ev.type === "output_progress") {
      config.stream.emit({
        type: "output_progress",
        outputTokens: ev.outputTokens,
        exact: ev.exact,
      })
    }
    yield ev
  }
}

/** F3 proactive rate-limit backoff: emit the reached-window notice in BOTH modes
 *  (proactive backoff AND notice-only), but apply the pre-request `sleep` ONLY
 *  under proactive — so `QUANTA_RATELIMIT_NOTICE` alone renders the notice without
 *  ever delaying the request (byte-identical no-sleep). Extracted from
 *  `streamConsume` to keep that turn function under the god-FUNCTION size cap. */
const applyProactiveRateLimitBackoff = async (
  config: AgentConfig,
  rl: NonNullable<TurnSession["rateLimitProactive"]>,
): Promise<void> => {
  const snapshot = rl.store.current()
  if (snapshot === undefined) return
  const delayMs = proactiveDelayMs(snapshot)
  if (delayMs <= 0) return
  config.stream.emit(snapshotToNotice(snapshot))
  if (rl.proactive) await rl.sleep(delayMs)
}

export const streamConsume = async (
  session: TurnSession,
  state: TurnState,
  ctx: ReturnType<typeof buildTurnContext>,
): Promise<StreamConsumeResult> => {
  const { config, specs, recorder, skillGate, rateLimitProactive } = session
  const { collector, toolChoiceState, onTurnTiming, taskSpend } = state
  const { messages, system } = ctx
  // ADR-0512 L1 — availability filter. When skill-scope v2 is ON, the model
  // sees ONLY the tools in scope (nav-base ∪ active skill allowlist); OFF ⇒
  // `specs` unchanged (byte-identical). Reuses `skillGate.allow` so the visible
  // set and the dispatch gate share one predicate.
  const visibleSpecs = runtimeConfig().skillScopeV2 ? filterSpecsByScope(specs, skillGate) : specs
  const toolChoice = resolveToolChoice(consumeTurnSignals(toolChoiceState))
  session.ttfm?.markFirstDispatch()
  emitLlmRequest(
    config,
    finalizeTurnPolicy({
      promptPolicy: ctx.promptPolicy,
      toolChoice,
      ...(config.sessionId !== undefined ? { promptCacheKey: config.sessionId } : {}),
    }),
  )
  config.budgetMeter?.tick("model_call")
  const samplingSpan: Span = startSpan(SPAN_NAMES.runSamplingRequest, attrs({}))
  let samplingStatus: "ok" | "error" | "aborted" = "ok"
  // gen_ai.* span enrichment: capture the provider's usage (model + tokens) and
  // the finish reason so the sampling span answers which-model / how-many-tokens
  // / why-stopped — not just TTFT. Absent on early abort ⇒ omitted (empty-safe).
  let capturedUsage: SamplingUsage | undefined
  let capturedFinish: string | undefined
  // Captured for the trace-UI completion preview (built sink-gated in `finally`).
  let capturedMessage: unknown
  const captureUsage = (ev: Extract<StreamEvent, { type: "usage" }>): void => {
    capturedUsage = samplingUsageFromEvent(ev)
  }
  const stop = recorder?.llmStream()
  const stickyModelId = await readStickyModelForMode(config)
  const turnLlm = applyEffortClassifierFloor(
    resolveSkillTurnOverride(config, skillGate?.activeOverride(), stickyModelId),
    config.effortClassifier,
  )
  const turnTimingCapture = createTurnTimingCapture()
  const anchors: TurnTimingAnchors = { turnTimingCapture }
  const callbacks = createStreamDispatcher(session, state, anchors)
  if (config.onTurnStreamInput !== undefined) {
    try {
      config.onTurnStreamInput({
        messages,
        system,
        tools: visibleSpecs,
        ...(turnLlm.thinking !== undefined ? { thinking: turnLlm.thinking } : {}),
        ...(toolChoice.kind !== "auto" ? { toolChoice } : {}),
      })
    } catch (e) {
      config.stream.emit({
        type: "error",
        message: `onTurnStreamInput observer threw: ${errMessage(e)}`,
      })
    }
  }
  if (rateLimitProactive !== undefined)
    await applyProactiveRateLimitBackoff(config, rateLimitProactive)
  try {
    const outcome = await streamingTurn({
      events: teeUsage(
        config,
        turnLlm.llm.stream({
          messages,
          system,
          tools: visibleSpecs,
          ...(turnLlm.thinking !== undefined ? { thinking: turnLlm.thinking } : {}),
          ...(toolChoice.kind !== "auto" ? { toolChoice } : {}),
          ...(config.sessionId !== undefined && config.sessionId.length > 0
            ? { promptCacheKey: config.sessionId }
            : {}),
          signal: config.signal,
          turnTimingCapture,
          ...(rateLimitProactive !== undefined
            ? {
                onResponseHeaders: (get: (name: string) => string | null): void => {
                  rateLimitProactive.store.update(
                    parseRateLimitSnapshot(get, rateLimitProactive.now),
                  )
                },
              }
            : {}),
        }),
        recorder,
        collector,
        taskSpend,
        state.tokenBaseline,
        estimateTokens(messages),
        captureUsage,
      ),
      isConcurrencySafe: (name, input) => config.registry.isConcurrencySafe(name, input),
      isReadOnly: (name) => config.registry.isReadOnly(name),
      isEarlyDispatchSafe: (name) => config.registry.isEarlyDispatchSafe(name),
      onToolInput: buildToolInputSeam(config.registry),
      ...callbacks,
      signal: config.signal,
    })
    if (outcome.kind === "aborted") {
      samplingStatus = "aborted"
      return { aborted: true }
    }
    capturedFinish = outcome.stopReason
    capturedMessage = outcome.message
    return {
      message: outcome.message,
      stopReason: outcome.stopReason,
      resultBlocks: outcome.resultBlocks,
    }
  } catch (e) {
    if (isSessionApprovalRequiredError(e)) {
      samplingStatus = "error"
      throw e
    }
    if (
      config.signal.aborted ||
      (e instanceof LLMError && e.kind === "aborted") ||
      abortReasonOf(e) !== null
    ) {
      samplingStatus = "aborted"
      return { aborted: true }
    }
    samplingStatus = "error"
    const message = e instanceof LLMError ? e.message : errMessage(e)
    return { error: e, message }
  } finally {
    stop?.()
    turnTimingCapture.markStreamEnd()
    const timing = turnTimingCapture.snapshot()
    onTurnTiming?.(timing)
    // gen_ai.* attrs + trace-UI prompt/response previews (sink-gated).
    closeSamplingSpan(
      samplingSpan,
      samplingStatus,
      timing,
      capturedUsage,
      capturedFinish,
      messages,
      capturedMessage,
    )
  }
}
