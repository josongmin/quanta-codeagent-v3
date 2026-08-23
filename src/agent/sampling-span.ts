import type { Message, SystemBlock } from "@/llm"
import {
  attrs,
  ERROR_ATTRS,
  endSpan,
  GEN_AI_ATTRS,
  getSpanSink,
  providerOf,
  type Span,
  type SpanStatus,
  type TurnTiming,
  type TurnTimingCapture,
} from "@/observability"
import {
  emitGenAiClientMetrics,
  type GenAiMetricInput,
} from "@/observability/metrics/instrument-genai"
import { redactForSpan, redactThenPreview } from "./span-content-redact"

/**
 * LLM-sampling SPAN assembly (OTel-GenAI, ADR-0539).
 *
 * ONE responsibility: everything that turns one `run_sampling_request` into its
 * OTel record. That is the attribute payload (`buildSamplingSpanAttrs` and its
 * identity / TTFT / provider-name / content-capture contributors), the usage
 * projection the stream layer feeds it (`samplingUsageFromEvent`), and the two
 * terminal writers — `closeSamplingSpan` (attrs + status + `endSpan`, plus the
 * T-C2 GenAI client metrics that MUST carry the same dims) and
 * `finalizeSamplingSpan` (the caller-owned-span variant).
 *
 * Two invariants make this a single home rather than scattered helpers: the
 * span plane and the metric plane resolve the provider through the SAME
 * normalizer so they can never disagree, and NOTHING here reads `process.env` —
 * the default-OFF content-capture gate is pre-resolved by the caller and
 * arrives as `contentCaptureEnabled`, with redaction delegated to the shared
 * `span-content-redact.ts` home.
 *
 * Split out of `loop-helpers.ts` (god-module ratchet) — pure move, no logic
 * change; every name stays re-exported from there.
 */

/**
 * Build the OTel TTFT attribute payload for `run_sampling_request` span close
 * (RFC-0002 §11 / Cursor `setTtftMs` reject-and-skip contract). Returns a
 * single-keyed object when `ttftMs` is a finite non-negative value; an empty
 * object otherwise (the attribute is OMITTED on the span — matching the
 * Cursor "guarded value only" rule). Pure given `TurnTiming`.
 *
 * Extracted from `streamConsume.finally`; the inline derivation was a 2-line
 * ternary — moving it here gives the seam a unit-testable boundary and lets
 * `streamConsume` read it as one call.
 */
export const buildTtftAttrs = (timing: TurnTiming): Record<string, number> =>
  timing.ttftMs !== null ? { [GEN_AI_ATTRS.response.timeToFirstTokenMs]: timing.ttftMs } : {}

/**
 * Map an INTERNAL provider slug → the pinned `gen_ai.provider.name` enum
 * (`63f8200…`, gen-ai-spans.md registry: `openai` / `anthropic` /
 * `azure.ai.openai` / …). Our router emits auth-flavored slugs (e.g.
 * `chatgpt-oauth`, the ChatGPT-OAuth subscription transport over the OpenAI API)
 * that are NOT enum members — a backend keying `gen_ai.provider.name` on the
 * enum would bucket them as an unknown provider.
 *
 * Known internal auth-flavored slugs are mapped to their base enum provider
 * (`chatgpt-oauth` → `openai`; it speaks the OpenAI API). Every other slug is
 * passed through UNCHANGED — the enum members (`openai`/`anthropic`) already
 * conform, and for a genuinely unknown slug a truthful non-enum value beats a
 * wrong guess. Shared by the span attr AND the T-C2 metric dim (both resolve the
 * provider through this normalizer) so the two planes always agree.
 */
export const normalizeProviderName = (slug: string): string => {
  switch (slug) {
    case "chatgpt-oauth":
      return "openai"
    default:
      return slug
  }
}

/** Usage captured from the provider's `usage` stream event (model + tokens). */
export interface SamplingUsage {
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheCreationTokens?: number
  /** OpenAI-Responses-ONLY reasoning-token split (portion of `outputTokens`).
   *  Omitted for providers with no split (Anthropic) — never guessed. */
  readonly reasoningTokens?: number
}

/** Project a provider `usage` stream event into the {@link SamplingUsage} shape
 *  (omitting absent cache fields). Keeps the hot stream-consume callback a plain
 *  one-liner — the conditional shaping lives here, not inline in the loop. */
export const samplingUsageFromEvent = (ev: {
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheCreationTokens?: number
  readonly reasoningTokens?: number
}): SamplingUsage => ({
  model: ev.model,
  inputTokens: ev.inputTokens,
  outputTokens: ev.outputTokens,
  ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
  ...(ev.cacheCreationTokens !== undefined ? { cacheCreationTokens: ev.cacheCreationTokens } : {}),
  ...(ev.reasoningTokens !== undefined ? { reasoningTokens: ev.reasoningTokens } : {}),
})

/** Correlation + error-class attrs for the sampling span (T-C3 + T-B5), split
 *  out to keep `buildSamplingSpanAttrs` under the cognitive-complexity cap.
 *
 *  · `gen_ai.conversation.id` (T-C3): a STABLE grouping id so a GenAI backend
 *    folds every turn of one instance/attempt into a single session thread —
 *    same across turns (identity is per-instance/attempt), different across
 *    instances. Omitted when no identity is supplied (byte-identical).
 *  · `error.type` (T-B5): Conditionally-Required on the chat span when the
 *    operation errors. A GENERAL OTel attr (bare `error.type`, NOT
 *    `gen_ai.error.type`), carrying the bounded error CLASS (a `LLMErrorKind`
 *    slug) or the semconv `"_OTHER"` fallback — NEVER a raw message, so error
 *    dashboards keyed on it stay low-cardinality. Only stamped on `"error"`
 *    status (an `"aborted"` is a HITL hand-off / user cancel, not an error). */
const samplingIdentityAttrs = (
  status: SpanStatus,
  errorKind: string | undefined,
  conversationId: string | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {}
  if (conversationId !== undefined && conversationId !== "")
    out[GEN_AI_ATTRS.conversation.id] = conversationId
  if (status === "error")
    out[ERROR_ATTRS.type] = errorKind !== undefined && errorKind !== "" ? errorKind : "_OTHER"
  return out
}

/** gen_ai.* attributes for a `run_sampling_request` (`chat`, kind=CLIENT) span:
 *  TTFT (existing) PLUS the GenAI operation discriminator, the requested model +
 *  its provider, the response model, token usage, and the finish reason. The
 *  sampling span previously carried only TTFT — so a trace could not answer
 *  "which operation / which model+provider / how many tokens / why did it stop"
 *  per LLM call. Empty-safe: omits any field whose source was absent (no usage
 *  event ⇒ early abort; no finish reason). All keys are canonical `GEN_AI_ATTRS`
 *  so `attrs()` accepts them.
 *
 *  `gen_ai.response.finish_reasons` is emitted as a homogeneous string ARRAY per
 *  the OTel GenAI semconv (a turn may report several reasons; the exporter's
 *  Wave-1 `arrayValue` support serializes it) — NOT a bare scalar. */
/** Named-opts bag for {@link buildSamplingSpanAttrs}. Every forwarded field is
 *  required-nullable (`T | undefined`) mirroring {@link FinalizeSamplingSpanArgs}
 *  so the sole internal caller ({@link closeSamplingSpan}) forwards its own
 *  `T | undefined` values without an `exactOptionalPropertyTypes` cast. */
export interface SamplingSpanAttrsArgs {
  readonly timing: TurnTiming
  readonly usage: SamplingUsage | undefined
  readonly finishReason: string | undefined
  /** Truncated previews (built by the caller ONLY when a span sink is active)
   *  of the last input message we sent and the model's response — so clicking a
   *  `run_sampling_request` span in the live trace UI reveals what was asked /
   *  what came back. Omitted (undefined) on the default-OFF path. */
  readonly promptPreview: string | undefined
  readonly completionPreview: string | undefined
  /** The REQUESTED model + provider (from the turn's `LLMPort`), distinct from
   *  the RESPONSE model in `usage`. `gen_ai.request.model` is the model we asked
   *  for; `gen_ai.provider.name` is its provider slug (adapter-reported when
   *  available, else derived from the model prefix). Both omitted when unknown. */
  readonly requestModel: string | undefined
  readonly provider: string | undefined
  /** Terminal status of the sampling request. When `"error"` the semconv makes
   *  `error.type` Conditionally-Required — we stamp it here (T-B5). `"ok"` /
   *  `"aborted"` never carry `error.type` (an abort is a HITL hand-off / user
   *  cancel, not an operation error). */
  readonly status: SpanStatus
  /** T-B5 low-cardinality error CLASS (a `LLMErrorKind` slug like `"network"` /
   *  `"rate_limit"`), used verbatim as `error.type` when `status==="error"`.
   *  Absent ⇒ the semconv canonical fallback `"_OTHER"`. NEVER a raw error
   *  message — the value is a bounded enum so error dashboards stay
   *  low-cardinality. */
  readonly errorKind: string | undefined
  /** T-B5 stable conversation grouping id (`gen_ai.conversation.id`): the SAME
   *  value for every turn of one instance/attempt, DIFFERENT across instances
   *  (sourced from the session/instance identity). Omitted (undefined / empty)
   *  ⇒ key not stamped, so non-bench or identity-less callers stay
   *  byte-identical. */
  readonly conversationId: string | undefined
}

export const buildSamplingSpanAttrs = (
  args: SamplingSpanAttrsArgs,
): Record<string, string | number | readonly string[]> => {
  const {
    timing,
    usage,
    finishReason,
    promptPreview,
    completionPreview,
    requestModel,
    provider,
    status,
    errorKind,
    conversationId,
  } = args
  const out: Record<string, string | number | readonly string[]> = {
    // `chat` is the canonical GenAI operation for a provider sampling request.
    [GEN_AI_ATTRS.operation.name]: "chat",
    ...buildTtftAttrs(timing),
    // T-C3 conversation grouping id + T-B5 error.type — see the helper.
    ...samplingIdentityAttrs(status, errorKind, conversationId),
  }
  if (requestModel !== undefined && requestModel !== "") {
    out[GEN_AI_ATTRS.request.model] = requestModel
  }
  // Provider: stamped INDEPENDENTLY of `requestModel` so the SPAN plane never
  // diverges from the T-C2 METRIC dim (which emits provider whenever
  // `resolveProviderSlug` yields a value — even on a model-less close). Both
  // planes share the SAME `resolveProviderSlug`: caller-supplied slug wins (so a
  // chatgpt-oauth surface isn't mis-derived), else derive from the model prefix
  // (providerOf), NORMALIZED to the pinned `gen_ai.provider.name` enum
  // (chatgpt-oauth → openai). Iff a provider is resolvable ⇒ both planes agree.
  const providerSlug = resolveProviderSlug(requestModel, provider)
  if (providerSlug !== undefined) out[GEN_AI_ATTRS.provider.name] = providerSlug
  if (promptPreview !== undefined) out[GEN_AI_ATTRS.prompt] = promptPreview
  if (completionPreview !== undefined) out[GEN_AI_ATTRS.response.completion] = completionPreview
  if (usage !== undefined) {
    // Absorb a malformed usage event: a non-finite token count (NaN/Infinity)
    // must NOT reach the OTel attribute layer (it throws InvalidAttrValueError)
    // nor poison downstream sums — coerce it to 0.
    const fin = (n: number): number => (Number.isFinite(n) ? n : 0)
    out[GEN_AI_ATTRS.response.model] = usage.model
    out[GEN_AI_ATTRS.usage.inputTokens] = fin(usage.inputTokens)
    out[GEN_AI_ATTRS.usage.outputTokens] = fin(usage.outputTokens)
    if (usage.cacheReadTokens !== undefined)
      out[GEN_AI_ATTRS.usage.cacheReadInputTokens] = fin(usage.cacheReadTokens)
    if (usage.cacheCreationTokens !== undefined)
      out[GEN_AI_ATTRS.usage.cacheCreationInputTokens] = fin(usage.cacheCreationTokens)
  }
  // Emit finish_reasons as a homogeneous string ARRAY (semconv) — the exporter
  // serializes it via OTLP `arrayValue`.
  if (finishReason !== undefined) out[GEN_AI_ATTRS.response.finishReason] = [finishReason]
  return out
}

/** T-D0/T-D1 content-capture knob. Mirrors the OTel-GenAI spec env
 *  `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` — DEFAULT-OFF opt-in
 *  (`gateOn` ⇒ only a recognized truthy token arms it). When ON (and a span sink
 *  is live) `closeSamplingSpan` attaches the REDACTED structured
 *  `gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions`
 *  content attrs AND the (also-redacted, also-knobbed) prompt/completion previews.
 *  Unset / falsy ⇒ NO content leaves the process (byte-identical). */
// Span-content (Plane B) redaction is the ONE shared helper (jul-28): the tool
// span path (dispatch.ts) redacts identically. See span-content-redact.ts.

/** Map a single content block to the pinned GenAI `parts[]` element
 *  (`{type:"text",content}|{type:"tool_call",…}|{type:"tool_call_response",…}`).
 *  Text/tool_result content is REDACTED; tool_call arguments are stringified +
 *  redacted (they can carry secrets a model echoed). Non-text blocks the pin has
 *  no shape for (image/document/thinking) collapse to a redaction-neutral marker
 *  so no raw bytes leak. */
const contentPart = (b: Message["content"][number]): Record<string, unknown> | undefined => {
  if (b.type === "text") return { type: "text", content: redactForSpan(b.text) }
  if (b.type === "tool_use")
    return {
      type: "tool_call",
      id: b.id,
      name: b.name,
      arguments: redactThenPreview(b.input),
    }
  if (b.type === "tool_result")
    return {
      type: "tool_call_response",
      id: b.tool_use_id,
      response: redactForSpan(b.content),
    }
  // image / document / thinking — no pinned part shape; emit a typed marker
  // (never the raw bytes) so the attr stays lossless-by-type but leak-free.
  return { type: "text", content: `[${b.type}]` }
}

/** Build the pinned structured-message JSON string for a message list (the
 *  `gen_ai.{input,output}.messages` value — on spans MAY be a JSON string per the
 *  pin). Every text/arg/response leaf is redacted via {@link redactForSpan}. */
const messagesToJson = (messages: readonly Message[]): string =>
  JSON.stringify(
    messages.map((m) => ({ role: m.role, parts: m.content.map(contentPart).filter(Boolean) })),
  )

/** T-D1 content-capture attrs (knob-gated + redacted). Returns the structured
 *  `gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions`
 *  attrs, all redacted. Empty-safe: omits any leg whose source was absent. The
 *  caller only invokes this when the knob AND the sink are on, so an OFF run
 *  never allocates here. */
const buildContentCaptureAttrs = (
  messages: readonly Message[],
  responseMessage: unknown,
  system: readonly SystemBlock[] | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {}
  if (messages.length > 0) out[GEN_AI_ATTRS.input.messages] = messagesToJson(messages)
  // The response is a single assistant Message (structurally) — wrap it in the
  // same output-messages array shape. Non-Message shapes (test doubles) fall back
  // to a redacted preview so nothing raw leaks.
  if (responseMessage !== undefined) {
    const asMsg = responseMessage as Partial<Message>
    out[GEN_AI_ATTRS.output.messages] =
      Array.isArray(asMsg.content) && typeof asMsg.role === "string"
        ? messagesToJson([asMsg as Message])
        : JSON.stringify([
            {
              role: "assistant",
              parts: [{ type: "text", content: redactThenPreview(responseMessage) }],
            },
          ])
  }
  if (system !== undefined && system.length > 0) {
    out[GEN_AI_ATTRS.systemInstructions] = redactForSpan(system.map((s) => s.text).join("\n"))
  }
  return out
}

/** Resolve the `gen_ai.provider.name` dim/attr value: the adapter-reported slug
 *  when present, else derived from the model name. `undefined` when neither a
 *  provider nor a model is known (so the attr/dim is omitted). Shared by the span
 *  attr and the T-C2 metric so both agree on the provider slug. */
const resolveProviderSlug = (
  requestModel: string | undefined,
  provider: string | undefined,
): string | undefined => {
  if (provider !== undefined && provider !== "") return normalizeProviderName(provider)
  if (requestModel !== undefined && requestModel !== "")
    return normalizeProviderName(providerOf(requestModel))
  return undefined
}

/** Build the T-C2 metric input from the close params. Extracted to keep
 *  `closeSamplingSpan` under the cognitive-complexity cap. */
const buildGenAiMetricInput = (
  timing: TurnTiming,
  status: SpanStatus,
  usage: SamplingUsage | undefined,
  requestModel: string | undefined,
  provider: string | undefined,
  errorKind: string | undefined,
): GenAiMetricInput => {
  const providerSlug = resolveProviderSlug(requestModel, provider)
  return {
    durationMs: timing.totalDurationMs,
    status,
    ...(requestModel !== undefined && requestModel !== "" ? { requestModel } : {}),
    ...(providerSlug !== undefined ? { provider: providerSlug } : {}),
    ...(errorKind !== undefined && errorKind !== "" ? { errorKind } : {}),
    ...(usage !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage !== undefined ? { outputTokens: usage.outputTokens } : {}),
  }
}

/** The redacted, knob-gated content bag for a span close: the truncated
 *  prompt/completion previews (T-D1 leak fix) PLUS the pinned structured content
 *  attrs (T-D1). Empty when the content-capture knob is OFF or the sink is
 *  inactive — so an OFF run allocates nothing and emits no content. */
const buildSpanContentBag = (
  captureContent: boolean,
  messages: readonly Message[],
  responseMessage: unknown,
  system: readonly SystemBlock[] | undefined,
): { promptPreview?: string; completionPreview?: string; attrs: Record<string, string> } => {
  if (!captureContent) return { attrs: {} }
  const promptPreview =
    messages.length > 0 ? redactThenPreview(messages[messages.length - 1]) : undefined
  const completionPreview =
    responseMessage !== undefined ? redactThenPreview(responseMessage) : undefined
  return {
    ...(promptPreview !== undefined ? { promptPreview } : {}),
    ...(completionPreview !== undefined ? { completionPreview } : {}),
    attrs: buildContentCaptureAttrs(messages, responseMessage, system),
  }
}

/** Close a `run_sampling_request` span with its full gen_ai.* attribute bag. Owns
 *  the trace-UI payload previews: when (and ONLY when) a span sink is active AND
 *  the content-capture knob is armed, it attaches a REDACTED truncated preview of
 *  the last input message and the model's response so an operator can click the
 *  span and see what was asked / returned — PLUS the pinned structured content
 *  attrs (T-D1). Default-OFF path pays nothing (no stringify, no redact).
 *  Extracted from `streamConsume` to keep that turn function under the
 *  god-FUNCTION size cap. */
/** Named-opts bag for {@link closeSamplingSpan}. The forwarded fields are
 *  required-nullable (`T | undefined`) mirroring {@link FinalizeSamplingSpanArgs}
 *  so the orchestrator forwards its own values without an
 *  `exactOptionalPropertyTypes` cast; `contentCaptureEnabled` stays optional
 *  (absent ⇒ false, default-OFF). */
export interface CloseSamplingSpanArgs {
  readonly span: Span
  readonly status: SpanStatus
  readonly timing: TurnTiming
  readonly usage: SamplingUsage | undefined
  readonly finishReason: string | undefined
  readonly messages: readonly Message[]
  readonly responseMessage: unknown
  /** The turn's requested model + provider (from the `LLMPort`) for
   *  `gen_ai.request.model` / `gen_ai.provider.name`. Omitted (undefined) for
   *  test doubles that don't expose a model. */
  readonly requestModel: string | undefined
  readonly provider: string | undefined
  /** T-B5 — low-cardinality error CLASS (a `LLMErrorKind` slug) when
   *  `status==="error"`; forwarded verbatim to `error.type`. Absent ⇒ `"_OTHER"`.
   *  Never a raw message. */
  readonly errorKind: string | undefined
  /** T-C3 — stable `gen_ai.conversation.id` (same for every turn of one
   *  instance/attempt). Omitted ⇒ key not stamped. */
  readonly conversationId: string | undefined
  /** T-D1 — the turn's system prompt blocks, used ONLY to build the (redacted)
   *  `gen_ai.system_instructions` content attr under the content-capture knob.
   *  Omitted ⇒ that attr is never stamped. */
  readonly system: readonly SystemBlock[] | undefined
  /** ADR-0144 — pre-computed from AgentConfig.contentCaptureEnabled so this
   *  function never reads process.env. Absent ⇒ false (default-OFF). */
  readonly contentCaptureEnabled?: boolean
}

export const closeSamplingSpan = (args: CloseSamplingSpanArgs): void => {
  const {
    span,
    status,
    timing,
    usage,
    finishReason,
    messages,
    responseMessage,
    requestModel,
    provider,
    errorKind,
    conversationId,
    system,
  } = args
  const contentCaptureEnabled = args.contentCaptureEnabled ?? false
  // T-D1 preview-leak fix + content capture: the prompt/completion previews were
  // gated on sink-active ONLY. Since T-B flips the sink true on ordinary
  // (no-endpoint) runs, that emitted raw-ish truncated previews UN-KNOBBED.
  // Re-gate them (and the pinned structured content attrs) behind the SAME
  // content-capture knob AND redact them, so NO content leaves the process unless
  // the operator opted in. Off ⇒ empty bag (byte-identical, zero-alloc).
  const captureContent = getSpanSink() !== null && contentCaptureEnabled
  const content = buildSpanContentBag(captureContent, messages, responseMessage, system)
  endSpan(
    span,
    status,
    attrs({
      ...buildSamplingSpanAttrs({
        timing,
        usage,
        finishReason,
        promptPreview: content.promptPreview,
        completionPreview: content.completionPreview,
        requestModel,
        provider,
        status,
        errorKind,
        conversationId,
      }),
      ...content.attrs,
    }),
  )
  // T-C2 — the two OTel-GenAI client Histograms (operation.duration `s` +
  // token.usage `{token}`, the latter split by gen_ai.token.type input/output).
  // Emitted to the process-default METRIC sink (a DIFFERENT plane from the span
  // sink above), which is `null` on export-OFF runs ⇒ byte-identical no-op.
  emitGenAiClientMetrics(
    buildGenAiMetricInput(timing, status, usage, requestModel, provider, errorKind),
  )
}

/** The captured-during-the-turn inputs the `streamConsume.finally` block feeds
 *  into the sampling-span close. Grouped so the orchestration below is one call
 *  rather than a dozen inline statements in the hot turn function. */
export interface FinalizeSamplingSpanArgs {
  /** The recorder's `llmStream()` stop handle (idempotent; absent ⇒ no-op). */
  readonly stop: (() => void) | undefined
  readonly timingCapture: TurnTimingCapture
  readonly onTurnTiming: ((timing: TurnTiming) => void) | undefined
  readonly status: SpanStatus
  readonly usage: SamplingUsage | undefined
  readonly finishReason: string | undefined
  readonly messages: readonly Message[]
  readonly responseMessage: unknown
  readonly requestModel: string | undefined
  readonly provider: string | undefined
  /** T-B5 classified error CLASS (present only on the hard-error path). */
  readonly errorKind: string | undefined
  /** The session identity used for the T-C3 conversation id (see below). */
  readonly sessionId: string | undefined
  readonly system: readonly SystemBlock[] | undefined
  /** ADR-0144 — forwarded from AgentConfig.contentCaptureEnabled; keeps the
   *  span-close path process.env-free. Absent ⇒ false (default-OFF). */
  readonly contentCaptureEnabled?: boolean
}

/**
 * Orchestrate the sampling-span close at the end of a turn: stop the recorder's
 * llm-stream mark, snapshot the turn timing (and fan it out to `onTurnTiming`),
 * derive the stable T-C3 `gen_ai.conversation.id`, then hand everything to
 * {@link closeSamplingSpan}. Extracted VERBATIM from `streamConsume.finally` so
 * that hot turn function stays under the god-FUNCTION line cap — behavior is
 * byte-identical.
 *
 * T-C3 conversation id: the SAME source the session (`invoke_agent`) span stamps
 * — `sessionId` when it is a REAL identity. The `"default"`/empty fallback is a
 * non-identity (shared across unrelated sessions), so it is OMITTED rather than
 * stamped as a bogus shared conversation id, keeping the chat span's
 * `gen_ai.conversation.id` byte-consistent with the session root.
 */
export const finalizeSamplingSpan = (span: Span, args: FinalizeSamplingSpanArgs): void => {
  args.stop?.()
  args.timingCapture.markStreamEnd()
  const timing = args.timingCapture.snapshot()
  args.onTurnTiming?.(timing)
  const conversationId =
    args.sessionId !== undefined && args.sessionId !== "" && args.sessionId !== "default"
      ? args.sessionId
      : undefined
  closeSamplingSpan({
    span,
    status: args.status,
    timing,
    usage: args.usage,
    finishReason: args.finishReason,
    messages: args.messages,
    responseMessage: args.responseMessage,
    requestModel: args.requestModel,
    provider: args.provider,
    errorKind: args.errorKind,
    conversationId,
    system: args.system,
    ...(args.contentCaptureEnabled !== undefined
      ? { contentCaptureEnabled: args.contentCaptureEnabled }
      : {}),
  })
}
