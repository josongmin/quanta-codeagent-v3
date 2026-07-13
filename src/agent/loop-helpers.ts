import {
  buildGitDirectiveCollector,
  type DirectiveEmitterPort,
  type DirectiveSink,
  defaultEmitter,
  type GitDirectiveCollector,
} from "@/git/directive-emit"
import type { Message, SystemBlock } from "@/llm"
import {
  attrs,
  ERROR_ATTRS,
  endSpan,
  GEN_AI_ATTRS,
  getSpanSink,
  previewPayload,
  providerOf,
  type Span,
  type SpanStatus,
  type TurnTiming,
} from "@/observability"
import {
  emitGenAiClientMetrics,
  type GenAiMetricInput,
} from "@/observability/metrics/instrument-genai"
import { type TickOutcome, tickScheduler } from "@/scheduler/automation-engine"
import { type RedactionHit, type RedactionOrigin, redactSecrets } from "@/security"
import { gateOn, writeStderr, writeStdout } from "@/shared"
import { defaultGitRunner } from "@/tool/git"
import { buildCapEnforcer } from "./cap-enforcer"
import { DedupGate } from "./dispatch-dedup"
import { type TurnDiffSession, wireGitObservability } from "./git-observability"
import type { HookBus, HookPromptInject } from "./hooks"
import type { LocalizePhaseState } from "./localize-phase-guard"
import type { AgentMode } from "./prompt"
import type { ReproDoubtState } from "./repro-doubt-guard"
import { buildLocalizePhase, buildReproDoubt } from "./session-resources"
import { extractSeedMessages, isUserInputSubmission } from "./submission"
import type { AgentConfig } from "./types"

/**
 * Pure-helper companions extracted from `loop.ts` to reduce the LOC of the
 * three god functions (runAgentInner / maybeCompact / streamConsume) without
 * changing any observable behavior. Every helper here either:
 *
 *   - takes explicit deps (no closure capture, no `this`), OR
 *   - constructs a closure with a single explicit dep so the boundary stays
 *     unit-testable in isolation,
 *
 * and is structurally equivalent to the inline block it replaced. The
 * default-OFF byte-identical contract is preserved: an absent/disabled
 * configuration sees the SAME early return / no-op the inline block produced.
 */

/**
 * Derive the canonical session seed message buffer (RFC §6.3, ADR-0062 §A3).
 * When the typed Submission envelope projects to a user-input shape, append
 * the projected messages to `cfg.messages`. Otherwise return `cfg.messages`
 * verbatim. Pure; the caller's `cfg.messages` array is never mutated.
 *
 * Extracted from `runAgentInner` (inline at the top of the function); the
 * inline block was 5 LOC of derivation logic — moving it here lets the loop
 * function read `const seedMessages = buildSeedMessages(cfg)` as a single
 * line.
 */
export const buildSeedMessages = (cfg: AgentConfig): Message[] => {
  const submissionSeed =
    cfg.submission && isUserInputSubmission(cfg.submission)
      ? extractSeedMessages(cfg.submission)
      : undefined
  return submissionSeed ? [...cfg.messages, ...submissionSeed] : cfg.messages
}

/**
 * ADR-0125 turn-diff loop wiring — opt-in factory for the per-session
 * `TurnDiffSession`. Returns `undefined` when
 * `cfg.gitObservability?.enabled !== true` (default-OFF, no `git rev-parse`
 * spawn). When enabled, a caller-supplied `session` (test-injection seam,
 * mirrors `dedupGate`) is honored verbatim; otherwise the helper constructs
 * one via `wireGitObservability` against `defaultGitRunner` + `cfg.cwd` +
 * `cfg.signal`.
 *
 * Extracted from `runAgentInner`; the inline block was 6 LOC of a single
 * conditional expression — moving it here lets the loop function read it as
 * one line.
 */
export const buildTurnDiffSession = (cfg: AgentConfig): TurnDiffSession | undefined => {
  if (cfg.gitObservability?.enabled !== true) return undefined
  return (
    cfg.gitObservability.session ??
    wireGitObservability({ runner: defaultGitRunner, cwd: cfg.cwd, signal: cfg.signal }).turnDiff
  )
}

/**
 * ADR-0133 — wire the session-scoped pending list of hook-emitted
 * `promptHook` responses. Returns the list (so the loop can drain/snapshot
 * it per turn) and attaches a `subagentPendingPrompt` push port to `cfg`
 * IFF the caller did not already provide one. Idempotent against a
 * caller-supplied port.
 *
 * Extracted from `runAgentInner`; the inline block was 6 LOC of allocation
 * + side-effect — kept as a single explicit-side-effect call (`cfg` is
 * mutated only when the caller's `subagentPendingPrompt` was absent, exactly
 * matching the pre-refactor behavior).
 */
export const wireHookPromptPending = (cfg: AgentConfig): HookPromptInject[] => {
  const hookPromptPending: HookPromptInject[] = []
  if (cfg.subagentPendingPrompt === undefined) {
    cfg.subagentPendingPrompt = {
      push: (entry: HookPromptInject) => hookPromptPending.push(entry),
    }
  }
  return hookPromptPending
}

/**
 * ADR-0078 point #2 — scan every text block of the final transcript at the
 * persistence boundary and fold the redaction hits into the run rollup.
 * Counting only — the block text is NOT mutated here so the memory_distill
 * path (point #3) still redacts the SAME raw secret independently (each
 * origin fires once per secret).
 *
 * Pure given explicit deps. Caller must gate on `redactionEnabled && cfg.store`
 * — the helper does NOT re-check that condition (the caller's branch already
 * cleared it).
 *
 * Extracted from `runAgentInner.finish()`; the inline block was a 7-line
 * nested loop — moving it here lets `finish()` read it as a single
 * conditional call.
 */
export const scanEnvelopeForRedactions = (
  messages: readonly Message[],
  recordRedaction: (origin: RedactionOrigin, hits: readonly RedactionHit[]) => void,
): void => {
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type !== "text") continue
      const r = redactSecrets(b.text, { origin: "envelope_jsonl" })
      if (!r.unchanged) recordRedaction("envelope_jsonl", r.hits)
    }
  }
}

/**
 * ADR-0133 — bridge the typed `pre_compact` hook event onto the
 * `compactIfNeeded` preCompactHook contract. Absent `hooks` ⇒ returns
 * `undefined` (compactIfNeeded fast-paths past the extra await — byte-
 * identical to the pre-ADR-0133 path). When wired, a hook that returns
 * `{ abort: { reason } }` causes `compactIfNeeded` to skip THIS compaction
 * (returns `{compacted:false}` — same shape the breaker observes as no
 * progress).
 *
 * Extracted from `maybeCompact`; the inline block was 14 LOC of a single
 * arrow expression. Moving it here lets `maybeCompact` read it as one line.
 */
export type PreCompactHookFn = (q: {
  messagesToCompact: number
  isFirstCompaction: boolean
}) => Promise<{ abortReason: string | null }>

export const buildPreCompactHook = (hooks: HookBus | undefined): PreCompactHookFn | undefined => {
  if (hooks === undefined) return undefined
  return async (q) => {
    const emit = await hooks.emit({
      type: "pre_compact",
      messagesToCompact: q.messagesToCompact,
      isFirstCompaction: q.isFirstCompaction,
    })
    return { abortReason: emit.abort?.reason ?? null }
  }
}

/** ADR-0409 — sibling of {@link buildPreCompactHook} for the `post_compact`
 *  HookBus event. Fires AFTER a compaction settles with the typed
 *  {@link RecoveryProvenance} (reason / tokens before-after / turns
 *  dropped-kept / summary + resume strings). The bus already fast-paths the
 *  zero-subscriber case, so an unsubscribed event is byte-identical to the
 *  pre-ADR-0409 path. NO-THROW: the emit itself runs inside compaction's own
 *  try/catch around `postCompactEmit`. Returns `undefined` when no hook bus
 *  is wired so `compactIfNeeded` omits the field entirely (legacy fast-path). */
export const buildPostCompactEmit = (
  hooks: HookBus | undefined,
  threadId: string,
):
  | ((provenance: import("@/agent/recovery-reason").RecoveryProvenance) => Promise<void>)
  | undefined => {
  if (hooks === undefined) return undefined
  return async (provenance) => {
    await hooks.emit({ type: "post_compact", threadId, provenance })
  }
}

/**
 * T3 — pre-flight dedup gate. ON by default with `DEFAULT_DEDUP_GATE_CAPS` so
 * a pallets-style env-loop thrash is structurally braked. Honors a
 * caller-supplied `cfg.dedupGate` (test injection / explicit override) and
 * falls back to constructing from `cfg.dedupGateConfig.caps`. Setting
 * `dedupGateConfig.disabled:true` opts out entirely. Side-effect: attaches the
 * constructed gate to `cfg.dedupGate` (so `dispatchTool` sees it through the
 * AgentConfig channel) — only when the caller did not already supply one.
 * Returns the gate (or `undefined` when disabled) so the caller can branch on
 * activeness without re-reading `cfg`.
 *
 * Extracted from `runAgentInner`; the inline block was 4 LOC across a `const
 * +if`. Moving it here lets the loop function read it as one line.
 */
export const attachDedupGate = (cfg: AgentConfig): DedupGate | undefined => {
  const dedupGate =
    cfg.dedupGate ??
    (cfg.dedupGateConfig?.disabled ? undefined : new DedupGate(cfg.dedupGateConfig?.caps))
  if (dedupGate !== undefined && cfg.dedupGate === undefined) cfg.dedupGate = dedupGate
  return dedupGate
}

/**
 * ADR-0062 rule #3 — cap-as-instruction enforcement (DEFAULT-OFF). Built only
 * when `cfg.capEnforce === true` OR `QUANTA_CAP_ENFORCE=1` env flag is set
 * (checked inside `buildCapEnforcer`). A caller-supplied `cfg.capEnforcer`
 * (e.g. test injection) is honored without re-building. Side-effect: attaches
 * to `cfg.capEnforcer` iff absent — exactly the same pattern as
 * `attachDedupGate`.
 *
 * Extracted from `runAgentInner`; the inline block was 4 LOC.
 */
export const attachCapEnforcer = (cfg: AgentConfig): void => {
  const capEnforcer = cfg.capEnforcer ?? buildCapEnforcer(cfg.capEnforce)
  if (capEnforcer !== undefined && cfg.capEnforcer === undefined) {
    cfg.capEnforcer = capEnforcer
  }
}

/**
 * Agentless "localize-first" absorption (Tier 0) — build the localize-phase
 * guard state when `cfg.localizePhase.phase1Turns` is a positive integer
 * (`buildLocalizePhase` validates the active domain), attach it to
 * `cfg.localizePhaseState` so the sibling dispatch module reads it via the
 * AgentConfig channel. Returns the state (or `undefined`) so the loop can
 * still bump `state.turn` per iteration without re-reading `cfg`.
 *
 * Extracted from `runAgentInner`; the inline block was 4 LOC.
 */
export const attachLocalizePhase = (cfg: AgentConfig): LocalizePhaseState | undefined => {
  const state = buildLocalizePhase(cfg)
  if (state !== undefined && cfg.localizePhaseState === undefined) {
    cfg.localizePhaseState = state
  }
  return state
}

/**
 * repro-doubt absorption (jun-20) — build the guard state when
 * `cfg.reproDoubt.stuckRuns` is active and attach it to `cfg.reproDoubtState` so
 * the sibling dispatch module advances it per tool call (via the AgentConfig
 * channel, exactly like `attachLocalizePhase`). Unlike localize-phase the loop
 * does NOT bump this state — dispatch advances it on each tool dispatch — so the
 * return value is informational only. Default-OFF: `undefined` when inactive.
 */
export const attachReproDoubt = (cfg: AgentConfig): ReproDoubtState | undefined => {
  const state = buildReproDoubt(cfg)
  if (state !== undefined && cfg.reproDoubtState === undefined) {
    cfg.reproDoubtState = state
  }
  return state
}

/**
 * ADR-0234 git-directive emit wire — opt-in factory for the per-session
 * `GitDirectiveCollector`. Returns `undefined` when
 * `cfg.gitDirectiveEmit?.enabled !== true` (default-OFF, no collector built,
 * no emit wire installed).
 *
 * When enabled the resolution order is (in priority):
 *
 *   1. caller-supplied `cfg.gitDirectiveEmit.collector` (test injection
 *      seam — used verbatim, `emitter` + `sink` are ignored because the
 *      collector already owns its emitter).
 *   2. caller-supplied `cfg.gitDirectiveEmit.emitter` (test injection or
 *      a custom port the host wired) — wrapped in a fresh collector.
 *   3. built-in `defaultEmitter` against `cfg.gitDirectiveEmit.sink`
 *      (`"stdout"` default → `process.stdout`; `"stderr"` →
 *      `process.stderr`; inline function → adapter sink that calls it once
 *      per wire line — newline stripped so the host owns framing).
 *
 * `includeIntermediate` is forwarded to the constructed collector so a
 * live-progress surface (when the host opts in) sees record-time emits as
 * well as the deferred flush emits.
 *
 * Side-effect: attaches the constructed collector to `cfg.gitDirectiveEmit`
 * (mutates the `.collector` field IFF the caller did not supply one) so a
 * downstream tool wire (`gitTools({ gitDirectiveCollector })` at the
 * composition root) reads the SAME instance the loop will flush. Mirrors
 * the `attachDedupGate` / `attachCapEnforcer` pattern.
 *
 * Returns the collector (or `undefined` when disabled) so the loop can
 * call `collector.flush()` at turn end without re-reading `cfg`.
 */
export const buildGitDirectiveEmit = (cfg: AgentConfig): GitDirectiveCollector | undefined => {
  const block = cfg.gitDirectiveEmit
  if (block === undefined || block.enabled !== true) return undefined
  // Branch 1: caller-supplied collector — use verbatim.
  if (block.collector !== undefined) return block.collector
  // Branch 2/3: build or adopt an emitter, wrap in fresh collector.
  const emitter = block.emitter ?? defaultEmitterFor(block.sink ?? "stdout")
  const collectorOpts =
    block.includeIntermediate !== undefined
      ? { includeIntermediate: block.includeIntermediate }
      : {}
  const collector = buildGitDirectiveCollector(emitter, collectorOpts)
  // Mutate cfg so a downstream tool wire can read the SAME instance via
  // `cfg.gitDirectiveEmit.collector`. Only when the caller did not already
  // supply one (block.collector === undefined was checked above). The
  // mutation respects exactOptionalPropertyTypes by re-assigning the whole
  // block with the new collector folded in.
  cfg.gitDirectiveEmit = { ...block, collector }
  return collector
}

/** Resolve the configured sink into a concrete `DirectiveEmitterPort`. The
 *  inline-function form wraps the caller's callback in a sink adapter that
 *  strips the trailing newline (the protocol writes `<line>\n`; a function
 *  consumer typically wants the bare line). */
const defaultEmitterFor = (
  sink: "stdout" | "stderr" | ((line: string) => void),
): DirectiveEmitterPort => {
  if (sink === "stdout") {
    return defaultEmitter({
      write(chunk: string): boolean {
        writeStdout(chunk)
        return true
      },
    })
  }
  if (sink === "stderr") {
    return defaultEmitter({
      write(chunk: string): boolean {
        writeStderr(chunk)
        return true
      },
    })
  }
  // Function sink — adapter wraps once per write, stripping the trailing
  // newline. A throwing callback is caught at the emitter boundary (see
  // defaultEmitter implementation) and surfaces as a typed invalid-directive
  // error rather than propagating.
  const fnSink: DirectiveSink = {
    write(chunk: string): boolean {
      const trimmed = chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk
      sink(trimmed)
      return true
    },
  }
  return defaultEmitter(fnSink)
}

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
export const buildSamplingSpanAttrs = (
  timing: TurnTiming,
  usage?: SamplingUsage,
  finishReason?: string,
  /** Truncated previews (built by the caller ONLY when a span sink is active)
   *  of the last input message we sent and the model's response — so clicking a
   *  `run_sampling_request` span in the live trace UI reveals what was asked /
   *  what came back. Omitted (undefined) on the default-OFF path. */
  promptPreview?: string,
  completionPreview?: string,
  /** The REQUESTED model + provider (from the turn's `LLMPort`), distinct from
   *  the RESPONSE model in `usage`. `gen_ai.request.model` is the model we asked
   *  for; `gen_ai.provider.name` is its provider slug (adapter-reported when
   *  available, else derived from the model prefix). Both omitted when unknown. */
  requestModel?: string,
  provider?: string,
  /** Terminal status of the sampling request. When `"error"` the semconv makes
   *  `error.type` Conditionally-Required — we stamp it here (T-B5). `"ok"` /
   *  `"aborted"` never carry `error.type` (an abort is a HITL hand-off / user
   *  cancel, not an operation error). Defaulted to `"ok"` so existing callers
   *  (and the empty-safe test doubles) stay byte-identical. */
  status: SpanStatus = "ok",
  /** T-B5 low-cardinality error CLASS (a `LLMErrorKind` slug like `"network"` /
   *  `"rate_limit"`), used verbatim as `error.type` when `status==="error"`.
   *  Absent ⇒ the semconv canonical fallback `"_OTHER"`. NEVER a raw error
   *  message — the value is a bounded enum so error dashboards stay
   *  low-cardinality. */
  errorKind?: string,
  /** T-B5 stable conversation grouping id (`gen_ai.conversation.id`): the SAME
   *  value for every turn of one instance/attempt, DIFFERENT across instances
   *  (sourced from the session/instance identity). Omitted (undefined / empty)
   *  ⇒ key not stamped, so non-bench or identity-less callers stay
   *  byte-identical. */
  conversationId?: string,
): Record<string, string | number | readonly string[]> => {
  const out: Record<string, string | number | readonly string[]> = {
    // `chat` is the canonical GenAI operation for a provider sampling request.
    [GEN_AI_ATTRS.operation.name]: "chat",
    ...buildTtftAttrs(timing),
    // T-C3 conversation grouping id + T-B5 error.type — see the helper.
    ...samplingIdentityAttrs(status, errorKind, conversationId),
  }
  if (requestModel !== undefined && requestModel !== "") {
    out[GEN_AI_ATTRS.request.model] = requestModel
    // Provider: prefer the adapter-reported slug; else derive from the model
    // name (providerOf covers the openai/anthropic split). A caller-supplied
    // provider wins so a chatgpt-oauth surface isn't mis-derived.
    out[GEN_AI_ATTRS.provider.name] =
      provider !== undefined && provider !== "" ? provider : providerOf(requestModel)
  }
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
const CONTENT_CAPTURE_ENV = "QUANTA_OTEL_CAPTURE_CONTENT"
const contentCaptureEnabled = (): boolean => gateOn(process.env, CONTENT_CAPTURE_ENV)

/** Redact a text payload for the OBSERVE/OTLP content plane (Plane B). The
 *  cassette (Plane A) stays UNredacted — this function is only reached on the
 *  span-content path, never on the recording path. Origin `tool_result` is the
 *  general content-observation origin the rollup already understands. */
const redactForSpan = (text: string): string => redactSecrets(text, { origin: "tool_result" }).text

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
      arguments: redactForSpan(previewPayload(b.input)),
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
              parts: [{ type: "text", content: redactForSpan(previewPayload(responseMessage)) }],
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
  if (provider !== undefined && provider !== "") return provider
  if (requestModel !== undefined && requestModel !== "") return providerOf(requestModel)
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
    messages.length > 0 ? redactForSpan(previewPayload(messages[messages.length - 1])) : undefined
  const completionPreview =
    responseMessage !== undefined ? redactForSpan(previewPayload(responseMessage)) : undefined
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
export const closeSamplingSpan = (
  span: Span,
  status: SpanStatus,
  timing: TurnTiming,
  usage: SamplingUsage | undefined,
  finishReason: string | undefined,
  messages: readonly Message[],
  responseMessage: unknown,
  /** The turn's requested model + provider (from the `LLMPort`) for
   *  `gen_ai.request.model` / `gen_ai.provider.name`. Omitted (undefined) for
   *  test doubles that don't expose a model. */
  requestModel?: string,
  provider?: string,
  /** T-B5 — low-cardinality error CLASS (a `LLMErrorKind` slug) when
   *  `status==="error"`; forwarded verbatim to `error.type`. Absent ⇒ `"_OTHER"`.
   *  Never a raw message. */
  errorKind?: string,
  /** T-C3 — stable `gen_ai.conversation.id` (same for every turn of one
   *  instance/attempt). Omitted ⇒ key not stamped. */
  conversationId?: string,
  /** T-D1 — the turn's system prompt blocks, used ONLY to build the (redacted)
   *  `gen_ai.system_instructions` content attr under the content-capture knob.
   *  Omitted ⇒ that attr is never stamped. */
  system?: readonly SystemBlock[],
): void => {
  // T-D1 preview-leak fix + content capture: the prompt/completion previews were
  // gated on sink-active ONLY. Since T-B flips the sink true on ordinary
  // (no-endpoint) runs, that emitted raw-ish truncated previews UN-KNOBBED.
  // Re-gate them (and the pinned structured content attrs) behind the SAME
  // content-capture knob AND redact them, so NO content leaves the process unless
  // the operator opted in. Off ⇒ empty bag (byte-identical, zero-alloc).
  const captureContent = getSpanSink() !== null && contentCaptureEnabled()
  const content = buildSpanContentBag(captureContent, messages, responseMessage, system)
  endSpan(
    span,
    status,
    attrs({
      ...buildSamplingSpanAttrs(
        timing,
        usage,
        finishReason,
        content.promptPreview,
        content.completionPreview,
        requestModel,
        provider,
        status,
        errorKind,
        conversationId,
      ),
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

// ─── ADR-0240 §B — Automation engine tick wire ─────────────────────────

/** Handle returned by `startAutomationEngineTicker`. Idempotent stop. */
export interface AutomationEngineTickerHandle {
  stop: () => void
}

/** Injection seam for `setInterval` / `clearInterval`. Tests pass fakes; the
 *  composition root defaults to `globalThis.setInterval` / `clearInterval`. */
export interface AutomationTickerDeps {
  readonly setInterval: (cb: () => void, ms: number) => unknown
  readonly clearInterval: (handle: unknown) => void
}

const defaultTickerDeps: AutomationTickerDeps = {
  setInterval: (cb, ms) => globalThis.setInterval(cb, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
}

/** Arm a `setInterval`-backed background drain for `automationEngine`.
 *
 *  Returns `undefined` when wire is incomplete (default-OFF byte-identical):
 *   - slot absent
 *   - `handler` absent
 *   - `tickIntervalMs` absent / 0 / negative / NaN
 *
 *  Each tick invokes `tickScheduler({ engine, now, handler })`. The optional
 *  `onTick` observer is consulted AFTER each tick; throws from the observer
 *  AND from the handler are absorbed — the timer keeps ticking. */
export const startAutomationEngineTicker = (
  cfg: AgentConfig,
  deps: AutomationTickerDeps = defaultTickerDeps,
): AutomationEngineTickerHandle | undefined => {
  const slot = cfg.automationEngine
  if (slot === undefined) return undefined
  const { engine, handler, tickIntervalMs, onTick, now, eligibility } = slot
  if (handler === undefined) return undefined
  if (tickIntervalMs === undefined || !Number.isFinite(tickIntervalMs) || tickIntervalMs <= 0) {
    return undefined
  }
  const clock: () => number = now ?? Date.now

  let stopped = false
  let handle: unknown = null

  const tick = (): void => {
    if (stopped) return
    tickScheduler({
      engine,
      now: clock(),
      handler,
      // ADR-0453 — forward the optional autorun-eligibility gate (absent ⇒ no
      // consult ⇒ byte-identical tick).
      ...(eligibility !== undefined ? { eligibility } : {}),
    })
      .then((outcome: TickOutcome) => {
        if (onTick !== undefined) {
          try {
            onTick(outcome)
          } catch {
            // observer throw absorbed — timer keeps ticking
          }
        }
      })
      .catch(() => {
        // tickScheduler is no-throw by contract; this is defense in depth
      })
  }

  handle = deps.setInterval(tick, tickIntervalMs)

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      if (handle !== null) {
        try {
          deps.clearInterval(handle)
        } catch {
          // already cleared by host shutdown
        }
        handle = null
      }
    },
  }
}

// ─── ADR-0240 §C — Identity per-turn reminder ──────────────────────────

const REMINDER_AUTO_ON_MODES: ReadonlySet<AgentMode> = new Set([
  "architect" as AgentMode,
  "editor" as AgentMode,
])

/** Decide whether the per-turn identity reminder should be spliced for the
 *  given `mode`. Default-OFF when the slot is absent. Mode-conditional
 *  auto-ON for `architect | editor` when `perTurnReminderEnabled` is
 *  `undefined`. Explicit `true` enables every mode; explicit `false`
 *  disables every mode. */
export const shouldSpliceIdentityReminder = (cfg: AgentConfig, mode: AgentMode): boolean => {
  const slot = cfg.identityModeVariant
  if (slot === undefined) return false
  const knob = slot.perTurnReminderEnabled
  if (knob === false) return false
  if (knob === true) return true
  return REMINDER_AUTO_ON_MODES.has(mode)
}

/** Render the per-turn identity reminder text for the given `mode`. Returns
 *  `undefined` when the splice should not fire (knob off / slot absent /
 *  empty identity / registry throw). The text is wrapped in
 *  `<system-reminder>...</system-reminder>` markers; body is the variant's
 *  `identity` lines joined by `\n`. Pure given the registry.
 *
 *  ALBB-14 — the registry-throw branch USED to swallow silently (bare
 *  `catch { return undefined }`), so a knob-ON splice whose `variantFor` threw
 *  vanished with no trace (the knob-on-but-inert failure class). The optional
 *  `onRegistryThrow` observer makes that path observable WITHOUT changing the
 *  return contract: when `shouldSpliceIdentityReminder` said "yes" but the
 *  registry throws, the observer fires with the error. Absent observer ⇒
 *  byte-identical to the prior swallow (still returns `undefined`, never
 *  throws) — the §C unit tests that call this with 2 args are unaffected. */
export const buildIdentityReminderText = (
  cfg: AgentConfig,
  mode: AgentMode,
  onRegistryThrow?: (e: unknown) => void,
): string | undefined => {
  if (!shouldSpliceIdentityReminder(cfg, mode)) return undefined
  const slot = cfg.identityModeVariant
  if (slot === undefined) return undefined
  let identity: readonly string[] | undefined
  try {
    const activeMode = slot.activeMode?.() ?? mode
    const variant = slot.registry.variantFor(activeMode)
    identity = variant.identity
  } catch (e) {
    // Observable-drop: the splice was requested (knob true / mode auto-ON) but
    // the registry blew up. Surface it so an opted-in operator sees WHY the
    // reminder disappeared instead of a silent no-op. Never rethrows.
    onRegistryThrow?.(e)
    return undefined
  }
  if (identity === undefined || identity.length === 0) return undefined
  return `<system-reminder>\n${identity.join("\n")}\n</system-reminder>`
}
