import type { StreamEvent } from "@/llm"
import {
  parseCountRemainingPercent,
  parseDualWindowSnapshot,
  parseRateLimitSnapshot,
  proactiveDelayMs,
  snapshotToNotice,
} from "@/llm/ratelimit-snapshot"
import { attrs, createTurnTimingCapture, SPAN_NAMES, type Span, startSpan } from "@/observability"
import { abortReasonOf, errMessage, LLMError } from "@/shared"
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

/** jul-03 B3 — provider rate-limit remaining% from a response's headers, ACROSS
 *  providers. Two REAL header-derived sources, in precedence order:
 *    1. Codex dual-window `x-codex-*-used-percent` ⇒ remaining% = 100 − used
 *       (PRIMARY/fast window governs, falling back to the secondary). A DIRECT
 *       provider percentage, so it is the primary source.
 *    2. OpenAI / Anthropic `x-ratelimit-{remaining,limit}-*` COUNTS ⇒ remaining%
 *       = remaining / limit * 100 (tightest window governs) — the broadened
 *       source (jul-03 B3) so the guard is armed on those providers too, not just
 *       Codex.
 *  Returns `undefined` when NEITHER family reports a well-formed signal (NO
 *  invented number: the caller then keeps its last value / fails open). */
const providerRemainingPercentFromHeaders = (
  get: (name: string) => string | null,
  now: () => number,
): number | undefined => {
  const snap = parseDualWindowSnapshot(get, now)
  const used = snap?.primary?.usedPercent ?? snap?.secondary?.usedPercent
  if (used !== undefined) return 100 - used
  // Broadened source: count/limit-based providers (OpenAI/Anthropic) send raw
  // COUNTS, not a used-percent, so the Codex path above leaves `used` undefined.
  return parseCountRemainingPercent(get)
}

/** jul-03 B3 — feed the live provider rate-limit window into the BudgetMeter tap
 *  the memory write-guard reads, ACROSS providers (Codex used-percent AND
 *  OpenAI/Anthropic count/limit — see {@link providerRemainingPercentFromHeaders}).
 *  NO-OP when no meter is wired OR no provider reported a recognized signal this
 *  response (byte-identical). Kept SEPARATE from the local cost fraction.
 *
 *  EXPORTED (jul-03 B3 audit) so the header→meter seam — the LIVE half of the
 *  provider rate-limit guard chain that the `buildToolingCore` wire test cannot
 *  reach (it seeds the meter by calling `observeProviderRateLimitRemainingPercent`
 *  directly) — is unit-pinned: deleting this feed from the loop must turn a test
 *  RED. Without this, the whole headers → guard chain could rot silently and the
 *  provider arm would fail-open forever (wired-but-inert). */
export const feedProviderRateLimitToMeter = (
  config: AgentConfig,
  get: (name: string) => string | null,
  now: () => number,
): void => {
  const meter = config.budgetMeter
  if (meter === undefined) return
  const remaining = providerRemainingPercentFromHeaders(get, now)
  if (remaining === undefined) return
  meter.observeProviderRateLimitRemainingPercent(remaining)
}

/**
 * jul-03 B3 (audit gap #2 — DECOUPLE) — build the per-response `onResponseHeaders`
 * hook, wired on the UNION of its two independent consumers so neither is silently
 * coupled to the other's knob:
 *   - The F3 rate-limit-notice / proactive-backoff snapshot store — present ONLY
 *     when `QUANTA_RATELIMIT_NOTICE` / `_PROACTIVE` armed `rateLimitProactive`.
 *   - The memory write-guard's PROVIDER rate-limit tap on the `BudgetMeter` —
 *     present whenever a `budgetMeter` is wired (the write-guard's activation gate,
 *     `QUANTA_MEMORY_WRITE_GUARD_PCT`, constructs it). BEFORE this decoupling the
 *     feed lived INSIDE the `rateLimitProactive`-gated hook, so a run that armed
 *     ONLY the write guard never wired the hook ⇒ the provider tap stayed
 *     `undefined` ⇒ the provider arm fail-open FOREVER (arming coupled to an
 *     UNRELATED knob). Now the hook wires when EITHER consumer needs it.
 *
 * Returns `undefined` when NEITHER consumer is active, so the stream input omits
 * `onResponseHeaders` entirely (byte-identical to the pre-B3 no-hook path). The
 * clock is `rateLimitProactive.now` when present (its injected test clock),
 * else `Date.now`; the provider feed only reads header PERCENT/COUNT fields, so
 * the clock affects nothing it consumes (it drives reset-ms parsing the feed
 * discards) — kept only for the store update's determinism.
 */
const buildResponseHeadersHook = (
  config: AgentConfig,
  rateLimitProactive: TurnSession["rateLimitProactive"],
): ((get: (name: string) => string | null) => void) | undefined => {
  const wantStore = rateLimitProactive !== undefined
  const wantMeterFeed = config.budgetMeter !== undefined
  if (!wantStore && !wantMeterFeed) return undefined
  const now = rateLimitProactive?.now ?? Date.now
  return (get: (name: string) => string | null): void => {
    if (rateLimitProactive !== undefined) {
      rateLimitProactive.store.update(parseRateLimitSnapshot(get, rateLimitProactive.now))
    }
    // Feed the REAL provider rate-limit window into the BudgetMeter tap the memory
    // write-guard reads — ACROSS providers (Codex used-percent AND OpenAI/Anthropic
    // count/limit). NO-OP without a meter OR a recognized header (byte-identical).
    // Kept SEPARATE from the local cost fraction — this is the provider signal.
    feedProviderRateLimitToMeter(config, get, now)
  }
}

/** Fire the optional per-turn stream-input observer, isolating a thrown observer
 *  as a soft stream error (never fails the turn). Extracted from `streamConsume`
 *  to keep it under the god-FUNCTION size cap — behavior identical. */
const notifyTurnStreamInput = (
  config: AgentConfig,
  input: Parameters<NonNullable<AgentConfig["onTurnStreamInput"]>>[0],
): void => {
  if (config.onTurnStreamInput === undefined) return
  try {
    config.onTurnStreamInput(input)
  } catch (e) {
    config.stream.emit({
      type: "error",
      message: `onTurnStreamInput observer threw: ${errMessage(e)}`,
    })
  }
}

type StreamTurnErrorOutcome =
  | { status: "aborted"; rethrow: true }
  | { status: "aborted"; result: StreamConsumeResult }
  | { status: "error"; result: StreamConsumeResult }

/** Classify a thrown streaming-turn error into (sampling-span status, control
 *  flow). An approval-required PAUSE is an intentional HITL hand-off — record it
 *  as "aborted" (paused), NOT "error", and rethrow so the caller pauses the turn.
 *  Abort signals ⇒ soft aborted; anything else ⇒ a hard error result. Extracted
 *  to keep `streamConsume` under the god-FUNCTION cap — behavior identical. */
const classifyStreamTurnError = (e: unknown, config: AgentConfig): StreamTurnErrorOutcome => {
  if (isSessionApprovalRequiredError(e)) return { status: "aborted", rethrow: true }
  if (
    config.signal.aborted ||
    (e instanceof LLMError && e.kind === "aborted") ||
    abortReasonOf(e) !== null
  )
    return { status: "aborted", result: { aborted: true } }
  const message = e instanceof LLMError ? e.message : errMessage(e)
  return { status: "error", result: { error: e, message } }
}

export const streamConsume = async (
  session: TurnSession,
  state: TurnState,
  ctx: ReturnType<typeof buildTurnContext>,
): Promise<StreamConsumeResult> => {
  const { config, specs, recorder, skillGate, rateLimitProactive } = session
  const { collector, toolChoiceState, onTurnTiming, taskSpend } = state
  const { messages, system } = ctx
  // ADR-0512 L1 — availability filter. The model must never SEE a tool the
  // dispatch gate (`handleSkillScope` → `skillGate.allow`) will deny, or it
  // fumbles into a guaranteed "not permitted" tool_result (see-but-can't-call).
  // The dispatch deny fires whenever a `skillGate` with an armed allowlist is
  // active — INDEPENDENT of `skillScopeV2` — so the visible-spec filter must fire
  // on the SAME condition. Both sites share the `skillGate.allow` predicate via
  // `filterSpecsByScope`, so visible == dispatchable in BOTH flag states. When no
  // skill is armed (`skillGate` absent, or `allow` returns true for every tool)
  // `filterSpecsByScope` returns the SAME `specs` reference (byte-identical). v2
  // ON is unchanged (it already filtered). NOTE: the flag still gates the v2
  // escalation UX in `handleSkillScope`; only the VISIBILITY filter is unified.
  const visibleSpecs = filterSpecsByScope(specs, skillGate)
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
  // jul-03 B3 (audit gap #2) — the response-header hook now wires on the UNION of
  // its consumers (rate-limit store OR the write-guard's provider tap), so the
  // memory guard's provider arm is fed independently of the rate-limit knob.
  const onResponseHeaders = buildResponseHeadersHook(config, rateLimitProactive)
  notifyTurnStreamInput(config, {
    messages,
    system,
    tools: visibleSpecs,
    ...(turnLlm.thinking !== undefined ? { thinking: turnLlm.thinking } : {}),
    ...(toolChoice.kind !== "auto" ? { toolChoice } : {}),
  })
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
          ...(onResponseHeaders !== undefined ? { onResponseHeaders } : {}),
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
    const outcome = classifyStreamTurnError(e, config)
    samplingStatus = outcome.status
    if ("rethrow" in outcome) throw e
    return outcome.result
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
