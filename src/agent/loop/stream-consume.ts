import type { StreamEvent } from "@/llm"
import {
  parseRateLimitSnapshot,
  proactiveDelayMs,
  snapshotToNotice,
} from "@/llm/ratelimit-snapshot"
import {
  attrs,
  createTurnTimingCapture,
  endSpan,
  SPAN_NAMES,
  type Span,
  startSpan,
} from "@/observability"
import { abortReasonOf, errMessage, LLMError } from "@/shared"
import { buildTtftAttrs } from "../loop-helpers"
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
  readStickyModelForMode,
  resolveSkillTurnOverride,
} from "./skill-gate"
import type { StreamConsumeResult } from "./types"

async function* teeUsage(
  config: AgentConfig,
  src: AsyncIterable<StreamEvent>,
  recorder: TurnSession["recorder"],
  collector: TurnState["collector"],
  taskSpend: TurnState["taskSpend"],
): AsyncIterable<StreamEvent> {
  const guarded =
    config.streamWatchdog !== undefined && config.streamTimeoutPolicy !== undefined
      ? config.streamWatchdog.wrap(src, config.streamTimeoutPolicy, config.signal)
      : src
  for await (const ev of guarded) {
    if (ev.type === "usage") emitUsage(config, ev, recorder, collector, taskSpend)
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

export const streamConsume = async (
  session: TurnSession,
  state: TurnState,
  ctx: ReturnType<typeof buildTurnContext>,
): Promise<StreamConsumeResult> => {
  const { config, specs, recorder, skillGate, rateLimitProactive } = session
  const { collector, toolChoiceState, onTurnTiming, taskSpend } = state
  const { messages, system } = ctx
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
        tools: specs,
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
  if (rateLimitProactive !== undefined) {
    const snapshot = rateLimitProactive.store.current()
    if (snapshot !== undefined) {
      const delayMs = proactiveDelayMs(snapshot)
      if (delayMs > 0) {
        config.stream.emit(snapshotToNotice(snapshot))
        await rateLimitProactive.sleep(delayMs)
      }
    }
  }
  try {
    const outcome = await streamingTurn({
      events: teeUsage(
        config,
        turnLlm.llm.stream({
          messages,
          system,
          tools: specs,
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
    endSpan(samplingSpan, samplingStatus, attrs(buildTtftAttrs(timing)))
  }
}
