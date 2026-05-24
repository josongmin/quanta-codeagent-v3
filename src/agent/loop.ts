import type { LLMPort, Message, StreamEvent, SystemPromptInput } from "@/llm"
import { createWorkingMemory, type WorkingMemory } from "@/memory"
import {
  attrs,
  createTurnTimingCapture,
  endSpan,
  GEN_AI_ATTRS,
  SPAN_NAMES,
  type Span,
  startSpan,
  type TurnTiming,
} from "@/observability"
import { normalizeRedactionConfig, redactSecrets } from "@/security"
import { errMessage, LLMError } from "@/shared"
import { defaultGitRunner } from "@/tool/git"
import { buildCapEnforcer } from "./cap-enforcer"
import { compactIfNeeded, estimateTokens, reactiveCompact } from "./compaction"
import { CompactionBreaker } from "./compaction-breaker"
import {
  appendSummary,
  type ConversationSummaryArchive,
  createArchive,
} from "./conversation-summary-archive"
import { DedupGate } from "./dispatch-dedup"
import { effortToTokenBudget } from "./effort"
import { buildSessionFeatures } from "./features"
// ADR-0125 turn-diff loop wiring (default-OFF). Opt-in via
// `config.gitObservability.enabled === true`. Constructs a per-session
// `TurnDiffSession` from the composite helper and calls startTurn/endTurn at
// the per-turn boundary so a host sees the SHAPE of what each turn changed.
import { type TurnDiffSession, wireGitObservability } from "./git-observability"
import { buildGuardChain, metaUser, runGuardChain } from "./guards"
import { renderIdeContext } from "./ide-context"
import { persistSession, recallContext } from "./memory"
import { runMemoryConsolidatorHook } from "./memory-consolidator-hook"
import { AgentRecorder } from "./metrics"
import { buildTurnContext } from "./prompt"
import {
  type AssembledMessage,
  decideOnAssembled,
  decideOnStreamError,
  freshRecovery,
  type RecoveryAction,
  type RecoveryReason,
} from "./recovery"
// R2-B P1 — parameter-bundle refactor. `TurnSession` (session-lifetime
// readonly resources) and `TurnState` (turn-lifetime mutable state) cut
// `runTurn` from ~20 positional params to 3, `streamConsume` to 4, and
// `applyAction` to 6. Pure structural change — every body still reads the
// SAME fields (just via `session.config` / `state.wm` / …), so the
// default-OFF byte-identical contract is preserved.
import type { SkillGate, SkillTurnOverride, TurnSession, TurnState } from "./turn-context"

// Backward-compatible re-exports: the stream-error/recovery FSM moved to
// `./recovery` (SRP decomposition) but historically lived in `loop.ts`.
// Existing consumers (`tests/unit/recovery*.test.ts`) import these from
// `@/agent/loop`, so re-export them to keep the public surface stable.
export {
  decideOnAssembled,
  decideOnStreamError,
  extractRefusalRationale,
  freshRecovery,
  type RecoveryState,
} from "./recovery"

// L4 control-op cluster (2026-05-23): submission interrupt + cancel_subagent
// + conversation-action behavioral wiring + queued-follow-up popReady.
import {
  type CancelSubagentOutcome,
  cancelSubagent,
  isCancelSubagentOp,
  isInterruptOp,
  isSetModeOp,
  type ResponseQueuedReason,
} from "./control-op-handler"
import { decideAction } from "./conversation-action"
import { threadId as makeThreadId } from "./follow-up-queue"
import { planToStreamMirror } from "./plan/stream-mirror"
import { backoffDelayMs } from "./retry"
import {
  buildCloseoutGuard,
  buildEffectiveConfig,
  buildLocalizePhase,
  buildPersistDeps,
  buildVerifyGuard,
  buildWorkMetricsResources,
  createRedactionRollup,
  emitWorkMetrics,
  sessionSpanAttrs,
  stampTurn,
  type ToolHistoryEntry,
  turnSpanAttrs,
} from "./session-resources"
import {
  classifyErrorReason,
  completedCategory,
  interruptedCategory,
  refusalCategory,
  type StopCategory,
} from "./stop-category"
import { createStreamDispatcher, type TurnTimingAnchors } from "./stream-callbacks"
import { streamingTurn } from "./streaming-dispatch"
import { extractSeedMessages, isUserInputSubmission } from "./submission"
import { consumeTurnSignals, createToolChoiceTurnState, resolveToolChoice } from "./tool-choice"
import { buildToolInputSeam } from "./tool-input-streaming"
import { makeTurnHeader } from "./turn-kind"
import type { AgentConfig, AgentOutcome, MemoryCitation, StopReason } from "./types"
import type { TurnWorkMetricsCollector } from "./work-metrics-collector"
import type { WorkingStateSession } from "./working-state"

/** Shared frozen empty history for the guard-OFF path. `toolHistory` is
 *  `undefined` when `config.verifyGuard` is absent; passing this shared
 *  constant (instead of a fresh `[]` literal per turn) keeps the default-OFF
 *  path allocation-free AND behaviorally byte-identical (decideVerifyGuard is
 *  never reached when the guard is off — `applyAction` only needs a readonly
 *  empty array to satisfy the type). */
const EMPTY_TOOL_HISTORY: readonly ToolHistoryEntry[] = Object.freeze([])

/**
 * ReAct loop. One `while` over turns; each turn = one LLM stream with tool
 * calls dispatched AS THEY STREAM IN. There is no transition state machine —
 * the FSM/workflow weight is what RFC §1.2 rejects, not the surface below.
 * This slice's ACTUAL surface:
 *
 * - same-turn recovery (RFC §13.1 "루프 견고화"): transient stream errors
 *   retry with bounded backoff, max_output_tokens injects a continue meta,
 *   malformed tool_use is corrected once, empty turns are capped. Same-turn
 *   retries do NOT consume the `maxTurns` counter.
 * - compaction (RFC §13.1, ADR-0004 신호): proactive at turn-top under token
 *   pressure (`compactIfNeeded`) + reactive on a PTL trigger (`reactiveCompact`)
 *   that resumes the same turn after compacting. A session `CompactionBreaker`
 *   (Tier 0 safety hardening, ADR-0011) aborts a compact↔PTL thrash spin.
 * - hooks + memory/metrics wiring: `HookBus` events, working-memory + long-term
 *   recall/persist (`recallContext`/`persistSession`), `AgentRecorder` counters.
 * - ADR-0004 cached prompt: the loop consumes `buildTurnContext`'s
 *   `{ system, messages }` (static cache-prefix system + a single trailing
 *   `<system-reminder>` for the per-turn dynamic context); it does NOT
 *   re-assemble the system prompt per turn.
 * - ADR-0011: streaming tool execution — a concurrency-safe tool is
 *   dispatched the instant its `tool_use` block finishes streaming (overlapping
 *   the rest of the model stream); a non-safe call is a head-of-line barrier
 *   run after the stream completes. `tool_result` blocks stay in the model's
 *   original call order. Optional subagent/skill tools + an "auto"-mode LLM
 *   permission classifier are materialized once via `buildSessionFeatures`.
 *
 * With NO Tier-1 config and a turn that yields 0 or only non-safe tool calls,
 * behaviour is byte-for-byte identical to the pre-absorption batched path.
 */

/** Bridge a `{type:"usage"}` StreamEvent (W-A2, currently dropped by
 *  `assembleFromEvents`) to the homomorphic `AgentEvent` so recorders capture
 *  token/usage. 1:1 field map; this is the ONLY new emit and is independent of
 *  all existing control flow / emit ordering.
 *
 *  Claude Desktop `getContextUsage` parity: also fans the same numbers out into
 *  the optional `AgentRecorder`'s canonical OTel GenAI counters so the CLI
 *  status line (or a future Tauri sidebar) can read live token consumption.
 *  Recorder absent ⇒ no-op (byte-identical to the pre-wired path). */
const emitUsage = (
  config: AgentConfig,
  ev: Extract<StreamEvent, { type: "usage" }>,
  recorder: AgentRecorder | undefined,
  collector: TurnWorkMetricsCollector | undefined,
): void => {
  config.stream.emit({
    type: "usage",
    inputTokens: ev.inputTokens,
    outputTokens: ev.outputTokens,
    model: ev.model,
    ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
  })
  recorder?.tokensUsed(ev.inputTokens, ev.outputTokens, ev.cacheReadTokens)
  // RFC may-22 Phase 1: BudgetMeter ticks for token accounting. Optional
  // chain ⇒ absence is byte-identical. Counts the SAME numbers we already
  // record above so meter snapshot agrees with recorder.tokensUsed().
  config.budgetMeter?.tick("input_tokens", ev.inputTokens)
  config.budgetMeter?.tick("output_tokens", ev.outputTokens)
  // absorb #6: per-turn work-metrics — only when caller wired a sink.
  collector?.recordUsage({
    tokensInput: ev.inputTokens,
    tokensOutput: ev.outputTokens,
    ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
  })
}

/** Pure side-effect emit of a `{type:"recovery"}` AgentEvent at a recovery
 *  point the loop ALREADY reaches (backoff/compact/nudge/empty/malformed). It
 *  MUST NOT influence loop control flow or the default-OFF byte-identical
 *  contract: it is an AgentEvent, only observed when a stream/recorder is
 *  attached (NullStream swallows it). */
const emitRecovery = (config: AgentConfig, reason: RecoveryReason, detail?: string): void => {
  config.stream.emit({
    type: "recovery",
    reason,
    ...(detail !== undefined ? { detail } : {}),
  })
}

/** Best-available configured model id for the pre-stream `llm_request`
 *  marker (RFC-0002 §5.2/§9). `LLMPort` now exposes the configured model id
 *  as a typed optional (`LLMPort.model?: string`), so read it directly — both
 *  shipped adapters (Anthropic/OpenAI) and `FallbackLLM` populate it, so the
 *  request marker carries the SAME model the adapter sends. Lightweight test
 *  doubles legitimately omit `model`; the `"unknown"` fallback is the genuine
 *  (intended) degrade for that case only. Pure read. */
const configuredModel = (llm: AgentConfig["llm"]): string => {
  const m = llm.model
  return m !== undefined && m !== "" ? m : "unknown"
}

/** Pure side-effect emit of a `{type:"llm_request"}` AgentEvent IMMEDIATELY
 *  before the turn's model stream is consumed (RFC-0002 §5.2/§9/§11). The
 *  recorder pairs it with the turn's trailing `llm_usage` via the SAME llm
 *  span. Like `emitRecovery`/`emitUsage` this is observation-only: NullStream
 *  swallows it, control flow / emit ordering / the default-OFF byte-identical
 *  contract are untouched. */
const emitLlmRequest = (config: AgentConfig): void => {
  config.stream.emit({
    type: "llm_request",
    model: configuredModel(config.llm),
    ...(config.llm.provider !== undefined ? { provider: config.llm.provider } : {}),
    ...(config.llm.authMode !== undefined ? { authMode: config.llm.authMode } : {}),
  })
}

/**
 * L4 control-op cluster (2026-05-23) — emit a `subagent_cancel` AgentEvent
 * with the registry-routing outcome. Pure observation; the parent turn keeps
 * running regardless of `outcome`. Outcomes are 1:1 mapped to the AgentEvent
 * field set (`stopped|not_found|registry_absent`).
 */
const emitSubagentCancel = (
  config: AgentConfig,
  subagentId: string,
  outcome: CancelSubagentOutcome,
  source: "submission_op" | "conversation_action",
): void => {
  config.stream.emit({
    type: "subagent_cancel",
    subagentId,
    outcome:
      outcome === "registry_absent"
        ? "registry_absent"
        : outcome === "stopped"
          ? "stopped"
          : "not_found",
    source,
  })
}

/**
 * L4 control-op cluster (2026-05-23) — emit a `response_queued` AgentEvent
 * with a closed `reason` literal from {@link ResponseQueuedReason}. Pure
 * observation; the loop's decision to defer (and the next action it takes)
 * is independent of this emit. The literal is read from a constant array
 * at the call site so adding a reason flushes out every emit site at
 * compile time.
 */
const emitResponseQueued = (
  config: AgentConfig,
  reason: ResponseQueuedReason,
  hint?: string,
): void => {
  config.stream.emit({
    type: "response_queued",
    reason,
    ...(hint !== undefined ? { hint } : {}),
  })
}

/**
 * L4 control-op cluster (2026-05-23) — emit a typed `interrupted` AgentEvent
 * BEFORE the loop's `finish("aborted", ...)` return. Lets a surface (jsonl
 * recorder / TUI) render "submission interrupt" vs "raw signal abort"
 * distinctly without re-classifying error/recovery emits. `reason` is the
 * verbatim cancel reason from a `conversation_action_cancel`, optional and
 * absent for the submission-op source.
 */
const emitInterrupted = (
  config: AgentConfig,
  source: "submission_interrupt" | "conversation_action_cancel",
  reason?: string,
): void => {
  config.stream.emit({
    type: "interrupted",
    source,
    ...(reason !== undefined ? { reason } : {}),
  })
}

/** Pass-through wrapper over the model stream that tees `usage` events to the
 *  W-C `emitUsage` bridge (RFC-0002) WITHOUT consuming any other event —
 *  `streamingTurn` has no `onUsage` collaborator, so the bridge lives here so
 *  token/usage recording is preserved verbatim under streaming tool exec. */
async function* teeUsage(
  config: AgentConfig,
  src: AsyncIterable<StreamEvent>,
  recorder: AgentRecorder | undefined,
  collector: TurnWorkMetricsCollector | undefined,
): AsyncIterable<StreamEvent> {
  for await (const ev of src) {
    if (ev.type === "usage") emitUsage(config, ev, recorder, collector)
    yield ev
  }
}

/** A successfully streamed turn: the assembled message + normalized stop
 *  reason + the tool_result blocks (already dispatched by `streamingTurn`, in
 *  original model-call order). */
type StreamSuccess = {
  message: AssembledMessage
  stopReason: string
  resultBlocks: AssembledMessage["content"]
}
type StreamConsumeResult = StreamSuccess | { error: unknown; message: string } | { aborted: true }

/** Skill tool-scoping ENFORCEMENT (ADR-0011). Once a skill that
 *  declared a `tools:` allowlist is invoked, subsequent tool calls are
 *  restricted to that allowlist (+ the skill meta-tools) until another skill
 *  resets it. Built only when ≥1 discovered skill declared an allowlist;
 *  absent ⇒ no scoping (loop byte-identical). */
const SKILL_META_TOOLS = new Set(["Skill", "ToolSearch"])

// R2-B P1 — `SkillTurnOverride` (and the local-only `SkillGate`) moved into
// `./turn-context` so the `TurnSession` bundle can reference them without a
// loop.ts ↔ turn-context.ts value cycle. Re-export `SkillTurnOverride` for
// backward compat — `features.ts` imports it via `from "./loop"`.
export type { SkillTurnOverride } from "./turn-context"

/** Build the skill gate when EITHER a tool allowlist OR a model/effort override
 *  is declared by ≥1 discovered skill. Absent both ⇒ `undefined` (loop
 *  byte-identical). The tool-scoping (`allow`) is driven solely by allowlists;
 *  overrides ride independently so a skill can override model/effort WITHOUT
 *  narrowing tools (and vice-versa). */
const buildSkillGate = (
  allowlists: Map<string, string[]> | undefined,
  overrides: Map<string, SkillTurnOverride> | undefined,
): SkillGate | undefined => {
  const hasAllow = allowlists !== undefined && allowlists.size > 0
  const hasOverride = overrides !== undefined && overrides.size > 0
  if (!hasAllow && !hasOverride) return undefined
  let active: Set<string> | undefined
  let activeOverride: SkillTurnOverride | undefined
  return {
    allow: (name) => active === undefined || SKILL_META_TOOLS.has(name) || active.has(name),
    observe: (name, input, ok) => {
      if (name !== "Skill" || !ok) return
      const raw =
        typeof input === "object" && input !== null && "name" in input
          ? (input as { name: unknown }).name
          : undefined
      const skill = typeof raw === "string" ? raw.trim().replace(/^\//, "") : ""
      const allow = allowlists?.get(skill)
      if (allow) active = new Set(allow)
      // Inheritance: a freshly-activated skill REPLACES the prior override
      // (skill > session config > default). A skill with no override clears it
      // back to "no skill override" so the session/default path resumes.
      activeOverride = overrides?.get(skill)
    },
    activeOverride: () => activeOverride,
  }
}

/** Resolve the per-turn LLM port + thinking budget given the active skill's
 *  override (if any). Pure: no clock, no IO. Precedence is skill > session
 *  config > default — here we only fold in the SKILL layer (the session/default
 *  thinking budget is whatever the loop already passes, i.e. none today, so an
 *  absent override is byte-identical). A `model` override swaps the port to the
 *  matching `config.modelCandidates` entry by id; an unknown id (or no
 *  candidate registry) leaves `config.llm` untouched (advisory degrade — the
 *  model id alone cannot construct a port). An `effort` override becomes a
 *  `thinking:{type:"enabled",budget_tokens}` field: a numeric effort is the raw
 *  budget, a named tier maps via `effortToTokenBudget` (the `"default"` tier and
 *  a non-positive/absent budget ⇒ no `thinking` field, byte-identical). */
const resolveSkillTurnOverride = (
  config: AgentConfig,
  override: SkillTurnOverride | undefined,
): { llm: LLMPort; thinking?: { type: "enabled"; budget_tokens: number } } => {
  if (override === undefined) return { llm: config.llm }
  const swapped =
    override.model !== undefined
      ? config.modelCandidates?.find((c) => c.id === override.model)?.port
      : undefined
  const llm = swapped ?? config.llm
  const budget =
    typeof override.effort === "number"
      ? override.effort
      : override.effort !== undefined
        ? effortToTokenBudget(override.effort)
        : undefined
  if (budget !== undefined && budget > 0) {
    return { llm, thinking: { type: "enabled", budget_tokens: budget } }
  }
  return { llm }
}

/**
 * Consume one LLM stream WITH interleaved tool execution (streaming tool
 * exec, ADR-0011). Delegates the stream/dispatch interleaving + ordering
 * + head-of-line barrier + abort/tombstone handling to the pure
 * `streamingTurn` engine; this seam only binds the loop's collaborators
 * (registry, dispatch, stream emits, metrics, the session auto-classifier) and
 * preserves the exact recovery contract: a thrown stream error returns
 * `{ error }` so `decideOnStreamError` + bounded backoff still drive same-turn
 * retry without consuming a `maxTurns` slot. The early dispatches are pure
 * latency win — when the recovery decision is `nudge`/`completed`/`compact`
 * the (read-only, since only concurrency-safe calls start early) results are
 * simply discarded, exactly as the pre-absorption path discarded un-dispatched
 * calls.
 */
const streamConsume = async (
  session: TurnSession,
  state: TurnState,
  messages: Message[],
  system: SystemPromptInput,
): Promise<StreamConsumeResult> => {
  // R2-B P1: destructure into the same local names the original body used so
  // every reference below stays byte-identical (config/recorder/skillGate/…).
  // R2-B P3: `classifier`/`workingState`/`toolHistory`/`onRedaction` are
  // captured by the dispatch factory (`./stream-callbacks#createStreamDispatcher`)
  // off the same `session`/`state` bundles, so they're no longer destructured
  // here — the local references were move-only, with no behavioural change.
  const { config, specs, recorder, skillGate } = session
  const { collector, toolChoiceState, onTurnTiming } = state
  // ADR-0079 — resolve the pre-call tool_choice from the loop-owned turn state.
  // `consumeTurnSignals` reads + clears the 1-turn-TTL flags armed by the
  // verify/closeout guards on the PRIOR stream's finish-intent; `resolveToolChoice`
  // applies the 4-way precedence. `auto` ⇒ field omitted from `StreamInput` so the
  // wire payload is byte-identical to the pre-feature path (the adapter only
  // emits provider `tool_choice` for `any`/`none`).
  const toolChoice = resolveToolChoice(consumeTurnSignals(toolChoiceState))
  // RFC-0002 §5.2/§9/§11 — `llm_request` marker, emitted IMMEDIATELY BEFORE
  // this turn's model stream is opened/consumed (the same point `llm_usage`
  // is later teed from the provider `usage` event). The recorder gives both
  // the SAME per-turn llm span so probe/§9 can pair request↔usage. Pure
  // observation: NullStream swallows it; the stream open + recovery control
  // flow below is byte-identical to the pre-emit path.
  emitLlmRequest(config)
  // RFC may-22 Phase 1: BudgetMeter tick — one model_call per stream open.
  // SAME-TURN retries open a new stream so they count distinctly, which
  // matches `maxModelCalls` semantics (a single turn may legitimately spend
  // multiple model calls via backoff). Default-OFF: undefined meter ⇒ no-op.
  config.budgetMeter?.tick("model_call")
  // Codex 10-step span tree — `run_sampling_request`. Opens one OTel span
  // per provider stream call (a SAME-TURN retry IS a new sampling request,
  // so it gets its own span — consistent with Codex's tree). Closes after
  // the stream completes / aborts / throws. No attrs at open: the cwd
  // attribute Codex emits maps to `quanta.conversation.id` (already on the
  // session span) so the run-sampling span body stays clean.
  const samplingSpan: Span = startSpan(SPAN_NAMES.runSamplingRequest, attrs({}))
  let samplingStatus: "ok" | "error" | "aborted" = "ok"
  const stop = recorder?.llmStream()
  // ADR-0011 §6.2 (L4): apply the ACTIVE skill's model/effort override to THIS
  // turn. The gate armed `activeOverride` when a skill was last invoked, so the
  // override naturally scopes to the turns AFTER activation and is re-read each
  // turn (a sibling skill with no override clears it back to session/default).
  // Absent gate / absent override ⇒ `{ llm: config.llm }` with no `thinking`,
  // i.e. byte-identical to the pre-feature stream call.
  const turnLlm = resolveSkillTurnOverride(config, skillGate?.activeOverride())
  // ADR-0077 Plane-B (L4 wire): timing capture shared with the adapter.
  // The adapter stamps `requestSentAt` at the actual POST boundary; the
  // stream dispatcher stamps `firstTokenAt` on the first output chunk and
  // this `finally` block stamps `streamEndAt` after the stream drains.
  const turnTimingCapture = createTurnTimingCapture()
  // R2-B P3 — hoist the dispatch closure + 4 stream callbacks into the
  // `createStreamDispatcher` factory (`./stream-callbacks`). Pure mechanical
  // extract: every closure body is byte-identical to the prior inline form,
  // every collaborator (`config`/`recorder`/`classifier`/`skillGate`/
  // `workingState`/`collector`/`toolHistory`/`onRedaction`) is read off the
  // SAME `TurnSession`/`TurnState` bundles.
  const anchors: TurnTimingAnchors = { turnTimingCapture }
  const callbacks = createStreamDispatcher(session, state, anchors)
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
          // Thread the loop's abort signal (user Ctrl+C / cancel) into the LLM
          // stream so an in-flight provider request aborts on cancel instead of
          // hanging the socket until completion/timeout. Same signal already
          // passed to streamingTurn + tool ctx below.
          signal: config.signal,
          turnTimingCapture,
        }),
        recorder,
        collector,
      ),
      isConcurrencySafe: (name, input) => config.registry.isConcurrencySafe(name, input),
      // L3 wire (absorb #1, ADR-0060): route streaming `tool_use_*` events to
      // each tool's optional `onInputStart/Delta/Available` callbacks. The
      // seam is a one-`Map.get` fast-path no-op for tools that declare none,
      // so this is byte-identical for every existing built-in.
      onToolInput: buildToolInputSeam(config.registry),
      ...callbacks,
      signal: config.signal,
    })
    if (outcome.kind === "aborted") {
      samplingStatus = "aborted"
      return { aborted: true }
    }
    return {
      message: outcome.message as AssembledMessage,
      stopReason: outcome.stopReason,
      resultBlocks: outcome.resultBlocks as AssembledMessage["content"],
    }
  } catch (e) {
    samplingStatus = "error"
    const message = e instanceof LLMError ? e.message : (e as Error).message
    return { error: e, message }
  } finally {
    stop?.()
    // ADR-0077 Plane-B (L4 wire): stamp the final anchor and surface the
    // snapshot via the optional sink + OTel attr. The capture is shared with
    // the adapter, so `requestSentAt` reflects the actual wire POST boundary.
    turnTimingCapture.markStreamEnd()
    const timing: TurnTiming = turnTimingCapture.snapshot()
    onTurnTiming?.(timing)
    // OTel: emit the TTFT attribute on the sampling-span close ONLY when
    // we have a guarded value (the absent / non-finite / negative case
    // omits the attr, matching the Cursor `setTtftMs` reject-and-skip
    // contract). Other attrs stay empty (default-OFF byte-identical for
    // the no-TTFT case).
    const ttftAttr =
      timing.ttftMs !== null ? { [GEN_AI_ATTRS.response.timeToFirstTokenMs]: timing.ttftMs } : {}
    // Single close site for `run_sampling_request`. Default-OFF (no sink) ⇒
    // no-op (sentinel short-circuits both the close branch and the duration
    // math). Note: this runs AFTER `stop?.()` so the recorder's llm-span
    // close precedes the OTel span close — matching the existing recorder-
    // first convention used elsewhere in the loop.
    endSpan(samplingSpan, samplingStatus, attrs(ttftAttr))
  }
}

/** A short out-of-band user message used to steer the model on a same-turn
 *  retry (output-limit / malformed-tool / empty). Kept terse on purpose.
 *  Body moved to `./guards/shared.ts` so the adapters can share it; the
 *  symbol stays imported here so every call site below is byte-identical. */

/** Recalled long-term memory text for this session, or `undefined` when no
 *  store is configured or nothing relevant is found. The user's last text
 *  seeds the query. Folded into the turn context by `buildTurnContext`, not
 *  spliced into the system string here (that splicing is the seam's job). */
const resolveMemoryContext = async (
  config: AgentConfig,
  wm: WorkingMemory<Message>,
  recorder: AgentRecorder | undefined,
  citations: MemoryCitation[],
): Promise<string | undefined> => {
  if (!config.store) return undefined
  const lastUser = [...wm.snapshot()].reverse().find((m) => m.role === "user")
  const queryText = lastUser?.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join(" ")
    .trim()
  // R-Phase1 P0-3: memory recall is best-effort — a failing embedder or store
  // must not break the turn. Convert the throw into an `error` AgentEvent (so
  // probe/triage can see the failure) and degrade to "no memory context", same
  // observable as a configured-but-empty store.
  try {
    const block = await recallContext(
      {
        store: config.store,
        ...(config.embedder ? { embedder: config.embedder } : {}),
        ...(recorder ? { onStats: (s) => recorder.memoryRecall(s) } : {}),
        // ADR-0082 — provenance seam: every record that landed in the rendered
        // recall block becomes one citation. Memory rides the reminder tail
        // today, so `where` is fixed to "reminder_tail" (the only render path).
        onPlaced: (placed) => {
          for (const p of placed) {
            citations.push({
              recordId: p.recordId,
              score: p.score,
              where: "reminder_tail",
              tokensApprox: p.tokensApprox,
            })
          }
        },
      },
      queryText || undefined,
      {
        limit: config.memory?.recallLimit ?? 5,
        ...(config.memory?.recallTiers ? { tiers: config.memory.recallTiers } : {}),
      },
    )
    return block ?? undefined
  } catch (e) {
    const message = errMessage(e)
    config.stream.emit({ type: "error", message: `memory recall failed: ${message}` })
    return undefined
  }
}

/** Proactive top-of-turn compaction when compaction config is present. No-op
 *  (same array reference) otherwise, so unconfigured suites are unaffected.
 *
 *  ADR-0075 (Cursor absorption): when `config.onPreCompact` is set the
 *  threshold-and-boundary-passing case routes through that callback before the
 *  summarizer runs. `defer_one_turn` skips THIS turn (the breaker still
 *  observes no progress; the cycle re-evaluates next turn). When
 *  `config.compaction.archive === true` a session-scoped
 *  {@link ConversationSummaryArchive} is updated and a `context_compacted`
 *  AgentEvent is emitted IMMEDIATELY AFTER the legacy
 *  `recovery:{reason:"compact"}` line — so existing consumers see the same
 *  ordered marker and new consumers can correlate the archive entry. Default-
 *  OFF: with no archive flag the archive arg is undefined and the new emit
 *  path is fully skipped (byte-identical). */
const maybeCompact = async (
  config: AgentConfig,
  system: SystemPromptInput,
  wm: WorkingMemory<Message>,
  breaker: CompactionBreaker | undefined,
  archive: ConversationSummaryArchive | undefined,
  turn: number,
): Promise<void> => {
  if (!config.compaction) return
  // Capture the optional callback into a local so the spread below carries a
  // narrowed (non-undefined) reference into the closure without a non-null
  // assertion. Absent ⇒ `preflight` is omitted entirely from `compactIfNeeded`'s
  // input (byte-identical legacy fast-path).
  const onPreCompact = config.onPreCompact
  const snapshot = [...wm.snapshot()]
  const before = estimateTokens(snapshot)
  // ADR-0075 — build the {from,to}TurnId pair UP FRONT so a successful
  // compaction can stamp the archive without re-deriving identifiers from a
  // mutated `wm`. `toTurnId` is the turn we're entering; `fromTurnId` is the
  // earliest still-archivable turn id. The loop has no per-message turn-id
  // mechanism today, so we use the run's turn counter as a stable string and
  // record the same `t<n>` for both ends — the archive consumer cares about
  // grouping + ordering across the session, not granularity within a turn.
  // (Future ADR-0034 wiring may upgrade these to real envelope turn_ids
  // without a contract break.)
  const turnId = config.run?.turn !== undefined ? `t${config.run.turn}` : `t${turn}`
  // Stable for the from-side: every successful compaction folds everything
  // older than the suffix, so the first-archive entry's `fromTurnId` is the
  // session origin, and subsequent ones cover the gap between archives.
  // We derive that gap from the LAST archived entry — falling back to the
  // session origin `t0` when none exists.
  const fromTurnId = archive?.summaries.at(-1)?.toTurnId ?? "t0"
  // R-Phase1 P0-2: proactive compaction failures (summarizer LLM throws / times
  // out / rate-limits) must surface as an `error` AgentEvent for trajectory +
  // probe, NOT propagate as an uncaught exception that aborts the turn before
  // any observability lands. We degrade gracefully (skip compaction this turn);
  // the reactive PTL path remains as the safety net for actual token-budget
  // overruns. RFC §1.2 default-OFF byte-identical preserved — when compaction
  // is unconfigured, the try-catch never runs.
  let result: Awaited<ReturnType<typeof compactIfNeeded>>
  // ADR-0133 — first-compaction flag derived from the same archive used to
  // stamp `fromTurnId` below. When `archive` is absent (compaction.archive
  // not opted in) we conservatively pass `false`: a hook that reacts on
  // "first compact" needs the archive to be the SSOT for "have we ever
  // compacted before"; without one we cannot prove first-ness, so don't
  // claim it.
  const isFirstCompaction = archive !== undefined && archive.summaries.length === 0
  // ADR-0133 — bridge the typed `pre_compact` hook event onto the
  // `compactIfNeeded` preCompactHook contract. Absent `config.hooks` ⇒
  // OMIT the bridge entirely (compactIfNeeded fast-paths past the extra
  // await — byte-identical to the pre-ADR-0133 path). When wired, a hook
  // that returns `{ abort: { reason } }` causes `compactIfNeeded` to skip
  // THIS compaction (returns `{compacted:false}` — same shape the breaker
  // observes as no progress).
  const hooks = config.hooks
  const preCompactHook =
    hooks !== undefined
      ? async (q: {
          messagesToCompact: number
          isFirstCompaction: boolean
        }): Promise<{ abortReason: string | null }> => {
          const emit = await hooks.emit({
            type: "pre_compact",
            messagesToCompact: q.messagesToCompact,
            isFirstCompaction: q.isFirstCompaction,
          })
          return { abortReason: emit.abort?.reason ?? null }
        }
      : undefined
  try {
    result = await compactIfNeeded({
      messages: snapshot,
      // ADR-0011: optional dedicated summarizer model; absent ⇒ main
      // llm (byte-identical). Summarization is low-stakes; a cheaper/faster
      // model spares the main model on every compaction.
      llm: config.compaction.summarizerLlm ?? config.llm,
      system,
      isFirstCompaction,
      ...(config.compaction.thresholdTokens !== undefined
        ? { thresholdTokens: config.compaction.thresholdTokens }
        : {}),
      ...(config.compaction.keepRecentTurns !== undefined
        ? { keepRecentTurns: config.compaction.keepRecentTurns }
        : {}),
      // ADR-0075 — Cursor HITL hook. Absent `onPreCompact` ⇒ NO preflight
      // attribute set (compactIfNeeded fast-paths past the await, byte-
      // identical legacy). When set, the host gets the typed
      // {@link PreCompactRequestQuery}; the loop maps its
      // {@link PreCompactDecision} 1-to-1 to the `compactIfNeeded` preflight
      // protocol. Any exception thrown from the host callback propagates
      // into the surrounding try/catch and degrades to the existing
      // proactive-error path (compaction deferred this turn).
      ...(onPreCompact !== undefined
        ? {
            preflight: async (q: {
              currentTokens: number
              threshold: number
              proposedKeep: number
              proposedSummaryTokens: number
            }): Promise<"approve" | "defer_one_turn" | "force_now"> =>
              onPreCompact({ turnId, ...q }),
          }
        : {}),
      ...(preCompactHook !== undefined ? { preCompactHook } : {}),
    })
  } catch (e) {
    const message = errMessage(e)
    config.stream.emit({
      type: "error",
      message: `proactive compaction failed: ${message}`,
    })
    return
  }
  if (result.compacted) {
    // R-Phase2 P1-1: emit a `recovery:"compact"` event with `detail:"proactive"`
    // so trajectory consumers can distinguish proactive (top-of-turn threshold)
    // compactions from reactive (PTL-driven) ones. The reactive site already
    // emits the `compact` reason; this closes the symmetry. Pure observation
    // (NullStream swallows), no control-flow impact.
    emitRecovery(config, "compact", "proactive")
    // Tier 0 safety hardening (ADR-0011): feed the thrash counter. A proactive compact
    // that fails to meaningfully shrink is a no-progress strike.
    breaker?.recordProactive(before, estimateTokens(result.messages))
    wm.replace(result.messages)
    // ADR-0075 archive + marker. Strictly AFTER `wm.replace`: a subscriber
    // that reacts to `context_compacted` by reading `wm` (e.g. a debug UI
    // snapshotting "history at compaction time") must see the post-compaction
    // buffer, not a half-applied state. Same reason `recordProactive` runs
    // before `replace` — the breaker observes the SIZES and the marker
    // observes the result. The legacy recovery emit comes FIRST so consumers
    // that only watch the existing channel keep working byte-identically.
    if (archive !== undefined) {
      const summaryText = extractSummaryText(result.messages[0])
      const entry = {
        fromTurnId,
        toTurnId: turnId,
        summary: summaryText,
        ts: Date.now(),
        tokens: result.summaryTokens,
      }
      appendSummary(archive, entry)
      config.stream.emit({ type: "context_compacted", ...entry })
    }
  }
}

/** Pull the human-readable summary text out of the synthetic
 *  `<conversation summary>` user message that `compactIfNeeded` produces.
 *  Defensive: returns `""` for any malformed shape — the archive caller
 *  still records the entry (the loop's invariant is that
 *  `result.compacted:true` implies a synthetic text block, but we don't want a
 *  one-off LLM oddity to throw on the archive path). The strip preserves the
 *  exact text the summarizer emitted; we drop only the `<conversation summary>\n`
 *  wrapper because it is presentational, not part of the archive payload. */
const SUMMARY_WRAPPER_RE = /^<conversation summary>\n/
const extractSummaryText = (msg: Message | undefined): string => {
  if (!msg || msg.content.length === 0) return ""
  const first = msg.content[0]
  if (!first || first.type !== "text") return ""
  return first.text.replace(SUMMARY_WRAPPER_RE, "")
}

/** The STATIC system blocks for this session (no per-turn dynamic context);
 *  used only to feed the proactive summarizer a grounded system prompt. */
const staticSystemFor = (config: AgentConfig): SystemPromptInput =>
  buildTurnContext({
    baseMessages: [],
    cwd: config.cwd,
    planMode: config.planMode ?? false,
    system: config.system,
  }).system

/** Abort-aware sleep used by the in-loop turn-retry backoff. Resolves early
 *  (no throw) if the signal trips so the caller's next abort check handles it. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve()
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })

/** Outcome of one logical turn. Only `tools` advances the maxTurns counter;
 *  `retry` re-enters the SAME turn (transient/PTL/output/malformed/empty
 *  recovery) without consuming a turn slot. */
type TurnResult =
  | { kind: "tools"; message: AssembledMessage; resultBlocks: AssembledMessage["content"] }
  | { kind: "completed"; message?: AssembledMessage }
  | { kind: "aborted" }
  | { kind: "error"; reason: string }
  // ADR-0076 Gap-1 SOTA++ — terminal, distinct from `error`. The `rationale`
  // is the visible-text content of the refusing assistant message; the
  // outer loop routes this to `finish("refusal", …, {rationale})` so the
  // AgentOutcome carries a typed `refusal` field for the host.
  | { kind: "refusal"; rationale: string; message: AssembledMessage }

/**
 * Drive one logical turn to a terminal {@link TurnResult}, performing all
 * SAME-TURN recovery internally (RFC-minimal, no turn increment for any of it):
 *
 *  - transient stream error → bounded exponential-backoff retry of the turn;
 *  - PTL → reactive compaction then retry the turn (compaction can't help ⇒
 *    `error`);
 *  - `max_tokens` stop → inject "continue" meta + keep partial, re-stream;
 *  - stop says tool_use but zero parsed tool_use blocks → inject "re-issue"
 *    meta, retry once, then treat as a normal (text) turn;
 *  - empty turn → nudge meta, retry; capped to avoid an infinite empty spin.
 *
 * `messages` is the CANONICAL history and is mutated in place with REAL
 * conversation only (assistant turns, same-turn recovery meta). The per-turn
 * dynamic `<system-reminder>` is rebuilt by the seam on every (re)attempt and
 * stays ephemeral — it is the request tail, never persisted (so it can never
 * accumulate across turns/retries and always trails the conversation).
 */
/** ADR-0080 — capture the IDE snapshot for this turn-context build and PREPEND
 *  the rendered `<ide-context>` block to the latest NON-reminder user message
 *  (IDE state is user-side context, not a harness reminder). No provider ⇒ ctx
 *  unchanged (byte-identical). A provider rejection is caught at the boundary,
 *  surfaced as an `error` AgentEvent, and treated as a null snapshot (no block)
 *  so an IDE bug never aborts the turn — this is a boundary, NOT a fallback. */
const injectIdeContext = async (
  config: AgentConfig,
  ctx: ReturnType<typeof buildTurnContext>,
): Promise<ReturnType<typeof buildTurnContext>> => {
  const provider = config.ideContextProvider
  if (provider === undefined) return ctx
  let block = ""
  try {
    block = renderIdeContext(await provider.snapshot(config.signal))
  } catch (e) {
    config.stream.emit({
      type: "error",
      message: `ide-context provider failed: ${errMessage(e)}`,
    })
    return ctx
  }
  if (block === "") return ctx
  const messages = ctx.messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== "user") continue
    const idx = m.content.findIndex((b) => b.type === "text")
    const tb = idx >= 0 ? m.content[idx] : undefined
    if (tb?.type !== "text" || tb.text.startsWith("<system-reminder>")) continue
    // Clone message + text block — `baseMessages` shares object refs with `wm`,
    // so mutating in place would corrupt canonical history.
    const newContent = [...m.content]
    newContent[idx] = { ...tb, text: `${block}\n\n${tb.text}` }
    messages[i] = { ...m, content: newContent }
    break
  }
  return ctx
}

/** ADR-0078 — when secret redaction is DISABLED (opt-out, validated at startup
 *  to carry an `acknowledgedRisk`), the model is never silently unprotected: a
 *  banner is prepended to the latest non-reminder user turn so every turn shows
 *  the disabled posture + the acknowledged risk. Redaction ENABLED (the default)
 *  ⇒ ctx returned unchanged (byte-identical). */
const injectRedactionBanner = (
  config: AgentConfig,
  ctx: ReturnType<typeof buildTurnContext>,
): ReturnType<typeof buildTurnContext> => {
  if (config.redaction?.disabled !== true) return ctx
  const ack = config.redaction.acknowledgedRisk ?? ""
  const banner = `<system-reminder>\nSecret redaction DISABLED for this session — tool output and model context may contain raw secrets. Acknowledged risk: ${ack}\n</system-reminder>`
  const messages = ctx.messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== "user") continue
    const idx = m.content.findIndex((b) => b.type === "text")
    const tb = idx >= 0 ? m.content[idx] : undefined
    if (tb?.type !== "text" || tb.text.startsWith("<system-reminder>")) continue
    const newContent = [...m.content]
    newContent[idx] = { ...tb, text: `${banner}\n\n${tb.text}` }
    messages[i] = { ...m, content: newContent }
    break
  }
  return ctx
}

/** Rebuild the per-attempt request context: memory recall, proactive
 *  compaction (mutates `messages` in place), then the buildTurnContext SEAM.
 *
 *  ADR-0133 — `hookPromptInjects` is the per-turn pending list of hook-
 *  emitted promptHook responses (from `subagent_start` / `subagent_stop` /
 *  `turn_start` etc. that fired since the LAST prepareTurnContext call). The
 *  caller (runAgentInner) DRAINS this list AFTER a successful build so a
 *  same-turn retry (PTL recovery) sees the SAME injects, but the NEXT
 *  outer turn starts fresh. Empty list / undefined ⇒ no block, byte-
 *  identical legacy. */
const prepareTurnContext = async (
  config: AgentConfig,
  wm: WorkingMemory<Message>,
  recorder: AgentRecorder | undefined,
  breaker: CompactionBreaker | undefined,
  activeSkills: { name: string; description: string }[] | undefined,
  workingState: WorkingStateSession | undefined,
  archive: ConversationSummaryArchive | undefined,
  turn: number,
  citations: MemoryCitation[],
  hookPromptInjects: readonly import("./hooks").HookPromptInject[] | undefined,
): Promise<ReturnType<typeof buildTurnContext>> => {
  const memoryContext = await resolveMemoryContext(config, wm, recorder, citations)
  await maybeCompact(config, staticSystemFor(config), wm, breaker, archive, turn)
  // Codex absorption — memory L3: snapshot the session WorkingState on every attempt
  // so the per-turn reminder reflects mutations the tool just made earlier in
  // the same turn. Absent ⇒ block omitted, byte-identical.
  const wsSnapshot = workingState?.snapshot()
  const ctx = buildTurnContext({
    baseMessages: [...wm.snapshot()],
    cwd: config.cwd,
    planMode: config.planMode ?? false,
    system: config.system,
    ...(config.mode !== undefined ? { mode: config.mode } : {}),
    ...(memoryContext !== undefined ? { memoryContext } : {}),
    ...(config.repoRules !== undefined ? { repoRules: config.repoRules } : {}),
    // File-scoped rules (Cursor `.cursor/rules` parity). Loaded once by the
    // caller; selection (alwaysApply ∪ glob-matched) is computed per turn in
    // `buildTurnContext` from `changedPaths`. Absent ⇒ no block, byte-identical.
    ...(config.globRules !== undefined ? { globRules: config.globRules.rules } : {}),
    ...(config.globRules?.changedPaths !== undefined
      ? { changedPaths: config.globRules.changedPaths }
      : {}),
    // Cached at session start by `buildSessionFeatures`; passed through every
    // turn without re-discovery (Codex anti-reread). Absent ⇒ no block in the
    // rendered reminder (byte-identical for skill-less sessions).
    ...(activeSkills !== undefined ? { activeSkills } : {}),
    ...(wsSnapshot !== undefined ? { workingState: wsSnapshot } : {}),
    ...(hookPromptInjects !== undefined && hookPromptInjects.length > 0
      ? { hookPromptInjects }
      : {}),
  })
  // ADR-0080 — fold the IDE snapshot into the built context (no provider ⇒
  // returned unchanged, byte-identical). ADR-0078 — prepend the redaction-
  // disabled banner when opted out (enabled ⇒ unchanged).
  return injectRedactionBanner(config, await injectIdeContext(config, ctx))
}

type Step = { done: false } | { done: true; result: TurnResult }
const CONTINUE: Step = { done: false }

/** Apply one decided {@link RecoveryAction}. Returns `{done:false}` to
 *  re-enter the SAME turn (after mutating `messages`/sleeping/compacting) or
 *  `{done:true}` with the terminal {@link TurnResult}. The `proceed` branch
 *  uses the tool_result blocks `streamingTurn` already produced (dispatch
 *  happened DURING the stream) instead of dispatching here. */
/** Verify-guard hook (Tier 0 safety hardening). Observed bench failure: the agent edits a
 *  source file then declares "done" with ZERO verification calls after the edit
 *  → a wrong fix ships. When `config.verifyGuard` is set and the model is about
 *  to finish right after an unverified mutating tool, convert the completion
 *  into the SAME nudge action the recovery machinery already understands
 *  (`keepMessage:true` so the final assistant turn is preserved, no maxTurns
 *  consumption, recovery emitted) up to `maxTrips`. `config.verifyGuard`
 *  absent ⇒ this is never called (default-OFF, byte-identical). */
// `isFinishAttempt` moved to `./guards/shared.ts` (re-imported at top so any
// other call site stays byte-identical). The legacy `verifyGuardStep` +
// `closeoutGuardStep` bodies are now `createVerifyGuard.decide` +
// `createCloseoutGuard.decide` in `./guards/`, run through `runGuardChain`
// from inside `applyAction`. Default-OFF: when neither guard is configured,
// `buildGuardChain` returns `[]`, `runGuardChain([])` returns `undefined`
// after a zero-iteration `for…of`, and the completed/nudge/proceed path
// proceeds byte-for-byte identical to the pre-chain loop.

const applyAction = async (
  session: TurnSession,
  state: TurnState,
  action: RecoveryAction,
  result: StreamSuccess | { error: unknown; message: string },
  ctxSystem: SystemPromptInput,
  history: readonly ToolHistoryEntry[],
): Promise<Step> => {
  // R2-B P1: destructure to the same local names the original body used.
  const { config, guards } = session
  const { wm, breaker, toolChoiceState } = state
  if (action.do === "error") return { done: true, result: { kind: "error", reason: action.reason } }
  if (action.do === "refusal") {
    // ADR-0076 Gap-1 SOTA++ — terminal `refusal` action. Append the final
    // refusing assistant message to working memory so the transcript carries
    // the visible refusal text (mirrors the `completed` path; otherwise a
    // resume / probe would not see the refusal in `outcome.messages`). The
    // `rationale` was extracted by `decideOnAssembled`; we pass the assembled
    // message along so the outer loop can route to `finish("refusal", …)`.
    const success = result as StreamSuccess
    wm.append(success.message)
    return {
      done: true,
      result: { kind: "refusal", rationale: action.rationale, message: success.message },
    }
  }
  if (action.do === "backoff") {
    // RFC-0002 §5.2 recovery trace. Pure observation (NullStream swallows it):
    // emitted at the recovery point the loop already reached; the sleep + retry
    // control flow below is byte-identical to the pre-emit path.
    emitRecovery(config, "backoff", `attempt ${action.attempt}`)
    await sleep(backoffDelayMs(action.attempt), config.signal)
    return CONTINUE
  }
  if (action.do === "compact") {
    emitRecovery(config, "compact")
    // Tier 0 safety hardening (ADR-0011): trip the breaker BEFORE another reactive
    // squeeze so a compact↔PTL thrash spin aborts with a clear reason
    // instead of looping until maxTurns / a provider 400.
    const verdict = breaker?.check()
    if (verdict?.abort) return { done: true, result: { kind: "error", reason: verdict.reason } }
    const snapshot = [...wm.snapshot()]
    const before = estimateTokens(snapshot)
    const compacted = await reactiveCompact({
      messages: snapshot,
      // ADR-0011: dedicated summarizer model when configured;
      // absent (or no compaction block) ⇒ main llm (byte-identical).
      llm: config.compaction?.summarizerLlm ?? config.llm,
      system: ctxSystem,
    })
    if (!compacted.ok) return { done: true, result: { kind: "error", reason: compacted.reason } }
    breaker?.recordReactive(before, estimateTokens(compacted.messages))
    wm.replace(compacted.messages)
    return CONTINUE
  }
  // From here the stream succeeded: `result` carries the assembled message
  // and the (already dispatched) tool_result blocks.
  const success = result as StreamSuccess
  const message = success.message
  // Tier 0 safety hardening: a finish attempt right after an unverified edit
  // is forced into one more turn (`VerifyGuard`); a finish attempt without
  // any prior unverified edit gets a single-shot closeout reminder
  // (`CloseoutGuard`). The chain encodes the precedence (verify before
  // closeout, see `./guards/build.ts`); default-OFF ⇒ the array is empty and
  // `runGuardChain` returns `undefined` after zero iterations (byte-identical
  // to the pre-chain loop). The `isFinishAttempt` predicate lives inside each
  // adapter so non-finish actions short-circuit cheap (no chain allocation).
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
    // C5 fix: the completed-via-exhaustion branch (malformed-retry-exhausted /
    // empty-turn-exhausted) previously returned WITHOUT appending the final
    // assistant `message` to working memory, while the normal proceed/no-tools
    // completion DOES append it. That dropped the final assistant turn from
    // `AgentOutcome.messages`, so a state.ts resume lost it. Mirror the proceed
    // path: append the final assistant turn before returning completed.
    wm.append(message)
    return { done: true, result: { kind: "completed", message } }
  }
  if (action.do === "nudge") {
    emitRecovery(config, action.reason)
    if (action.keepMessage) wm.append(message)
    wm.append(metaUser(action.text))
    return CONTINUE
  }
  // action.do === "proceed"
  wm.append(message)
  const toolCalls = message.content.filter((b) => b.type === "tool_use")
  if (toolCalls.length === 0) return { done: true, result: { kind: "completed", message } }
  return { done: true, result: { kind: "tools", message, resultBlocks: success.resultBlocks } }
}

const runTurn = async (
  turn: number,
  session: TurnSession,
  state: TurnState,
): Promise<TurnResult> => {
  // R2-B P1: destructure to the same local names the original body used so the
  // body below stays byte-identical (config / wm / recorder / …). Same fields,
  // same `undefined`s — only the call shape changed.
  const { config, recorder, activeSkills, archive, hookPromptPending } = session
  const { wm, rec, breaker, toolHistory, workingState, citations } = state
  // ADR-0133 — snapshot the pending promptHook list ONCE for this turn so a
  // same-turn retry sees the SAME injects (a vanishing block mid-PTL would
  // confuse the model). The session-level array continues to accumulate
  // injects from subagent_start/_stop fired during THIS turn's dispatch;
  // those land in the NEXT runTurn's snapshot. Empty / absent ⇒ undefined ⇒
  // prepareTurnContext omits the field (byte-identical legacy).
  const turnInjects: readonly import("./hooks").HookPromptInject[] | undefined =
    hookPromptPending !== undefined && hookPromptPending.length > 0
      ? [...hookPromptPending]
      : undefined
  // Drain immediately after snapshotting so injects are seen ONCE (not
  // re-injected in every later turn). New pushes from subagent_start/_stop
  // during THIS turn's dispatch will populate the list for the NEXT turn.
  if (hookPromptPending !== undefined) hookPromptPending.length = 0
  // Bounded: every iteration either returns or strictly consumes a SAME-TURN
  // budget (decideOn* mutate `rec`), so the loop cannot spin forever.
  for (;;) {
    if (config.signal.aborted) return { kind: "aborted" }

    // Rebuilt every attempt: ctx.messages = canonical history + one ephemeral
    // reminder tail (the per-turn dynamic context, never persisted).
    const ctx = await prepareTurnContext(
      config,
      wm,
      recorder,
      breaker,
      activeSkills,
      workingState,
      archive,
      turn,
      citations,
      turnInjects,
    )
    const result = await streamConsume(session, state, ctx.messages, ctx.system)
    if ("aborted" in result) return { kind: "aborted" }

    const action =
      "error" in result
        ? decideOnStreamError(result.error, result.message, rec)
        : decideOnAssembled(result.stopReason, result.message, rec)

    const step = await applyAction(
      session,
      state,
      action,
      result,
      ctx.system,
      // Audit [LOW]: the guard-OFF path used to allocate a throwaway `[]`
      // EVERY turn (contradicting the byte-identical zero-allocation intent).
      // Reuse one shared frozen empty array when the guard is off.
      toolHistory ?? EMPTY_TOOL_HISTORY,
    )
    if (step.done) return step.result
  }
}

// (The `handle_tool_call` span is wrapped in `dispatch.ts` — closer to the
// actual tool-execution surface so the span open / close stays adjacent to
// the call sites that produce its status.)

/**
 * L4 control-op cluster (2026-05-23) — restore the follow-up queue snapshot
 * at session start. When the host wired BOTH `followUpQueue` AND
 * `followUpQueueSnapshotStore`, hydrate the queue from the snapshot so a
 * fresh process resumes pending follow-ups. Errors at the boundary collapse
 * to an `error` AgentEvent + the queue stays at its caller-supplied state
 * (no exception propagates — session-start must NOT crash on a corrupt
 * snapshot). Extracted to keep `runAgentInner` under the complexity budget.
 */
const restoreFollowUpQueueSnapshot = async (cfg: AgentConfig): Promise<void> => {
  if (!cfg.followUpQueue || !cfg.followUpQueueSnapshotStore) return
  try {
    const snap = await cfg.followUpQueueSnapshotStore.load()
    if (snap === undefined) return
    // Walk the snapshot and enqueue each entry verbatim — the caller already
    // pointed `cfg.followUpQueue` at theirs (which we MUST honor; replacing
    // it would lose the reference the surface uses to enqueue new follow-ups).
    for (const t of snap.threads) {
      const tid = makeThreadId(t.threadId)
      for (const e of t.entries) {
        cfg.followUpQueue.enqueue(tid, {
          content: e.content,
          submittedAt: e.submittedAt,
          submittedTurnId: e.submittedTurnId,
          metadata: e.metadata,
        })
      }
    }
  } catch (e) {
    const message = errMessage(e)
    cfg.stream.emit({
      type: "error",
      message: `followUpQueueSnapshotStore.load failed: ${message}`,
    })
  }
}

/**
 * L4 control-op cluster (2026-05-23) — persist the post-session queue state
 * so a new process resumes pending follow-ups. Errors at the boundary
 * collapse to an `error` AgentEvent — they must NOT block the outcome (the
 * session is already finishing).
 */
const saveFollowUpQueueSnapshot = async (cfg: AgentConfig): Promise<void> => {
  if (!cfg.followUpQueue || !cfg.followUpQueueSnapshotStore) return
  try {
    await cfg.followUpQueueSnapshotStore.save(cfg.followUpQueue.toSnapshot())
  } catch (e) {
    const message = errMessage(e)
    cfg.stream.emit({
      type: "error",
      message: `followUpQueueSnapshotStore.save failed: ${message}`,
    })
  }
}

/**
 * ADR-0095 P7 — restore the structured plan snapshot at session start. Mirror
 * of {@link restoreFollowUpQueueSnapshot}: when the host wired BOTH
 * `planStore` AND `planSnapshotStore`, hydrate the store from the saved
 * snapshot so a fresh process resumes the plan. Errors collapse to an
 * `error` AgentEvent (no crash on corrupt snapshot — same boundary discipline
 * as the queue restore). After hydration, emit `plan_snapshot` so a
 * late-attaching surface paints the restored state.
 */
const restorePlanSnapshot = async (cfg: AgentConfig): Promise<void> => {
  if (!cfg.planStore || !cfg.planSnapshotStore) return
  try {
    const snap = await cfg.planSnapshotStore.load()
    if (snap === null || snap === undefined) return
    const r = cfg.planStore.restore(snap)
    if (!r.ok) {
      cfg.stream.emit({
        type: "error",
        message: `planSnapshotStore restore rejected: ${r.error.kind}`,
      })
      return
    }
    const current = cfg.planStore.current()
    if (current !== null) {
      cfg.stream.emit({ type: "plan_snapshot", plan: planToStreamMirror(current) })
    }
  } catch (e) {
    cfg.stream.emit({
      type: "error",
      message: `planSnapshotStore.load failed: ${errMessage(e)}`,
    })
  }
}

/**
 * ADR-0095 P7 — persist the post-session plan snapshot. Mirror of
 * {@link saveFollowUpQueueSnapshot}: errors must NOT block the outcome.
 * If `planStore.current() === null` (no plan or plan-exit `rejected` cleared),
 * we save an empty/null snapshot so the next session starts clean.
 */
const savePlanSnapshot = async (cfg: AgentConfig): Promise<void> => {
  if (!cfg.planStore || !cfg.planSnapshotStore) return
  try {
    const snap = cfg.planStore.snapshot()
    await cfg.planSnapshotStore.save(snap)
  } catch (e) {
    cfg.stream.emit({
      type: "error",
      message: `planSnapshotStore.save failed: ${errMessage(e)}`,
    })
  }
}

/**
 * L4 control-op cluster (2026-05-23) — Codex `ensureReady()` gate mirror.
 * Observe typed control ops on the submission envelope AFTER `session_start`
 * but BEFORE the main turn loop. Two op kinds drive behavior here:
 *
 *   - `interrupt`        ⇒ emit `interrupted{source:submission_interrupt}`
 *                          + return `"aborted"` so the caller short-circuits
 *                          via `finish("aborted", 0, ...)`. The op's optional
 *                          `turnId` is informational — there IS no active
 *                          turn yet (we haven't entered the for-loop), so
 *                          the standard interrupt path collapses to "no
 *                          work, aborted".
 *   - `cancel_subagent`  ⇒ route to `cancelSubagent()` (which consults
 *                          `taskRegistry?.forceStop`); emit
 *                          `subagent_cancel{source:submission_op}` with the
 *                          routing outcome. Parent session CONTINUES into
 *                          the regular turn loop — cancelling a child is
 *                          NOT a parent-finish trigger (the headline
 *                          ADR-0011 contract). With no `cfg.subagent` the
 *                          outcome is `registry_absent` (still observed).
 *   - `shutdown` / `reload_user_config` / `user_input*` ⇒ no L4 behavior
 *                          is wired here (shutdown ⇒ the loop's normal
 *                          finish path; reload ⇒ deferred to a future
 *                          round; user_input ⇒ already seeded by the
 *                          submission adapter above).
 */
const handleSubmissionControlOp = (
  cfg: AgentConfig,
  taskRegistry: { forceStop(id: string): boolean } | undefined,
): "aborted" | "continue" => {
  if (!cfg.submission) return "continue"
  if (isInterruptOp(cfg.submission)) {
    emitInterrupted(cfg, "submission_interrupt")
    return "aborted"
  }
  if (isCancelSubagentOp(cfg.submission)) {
    const outcome = cancelSubagent(taskRegistry, cfg.submission.op.subagentId)
    emitSubagentCancel(cfg, cfg.submission.op.subagentId, outcome, "submission_op")
  }
  // ADR-0095 P7 — `set_mode` op consume. Observation-only at this layer: emit
  // `mode_changed` so surfaces can repaint; the actual posture change is the
  // caller's responsibility (the next-turn host wires the new mode into the
  // following `AgentConfig.mode`/`planMode`). Noop transitions (from === to)
  // suppress the emit to avoid heartbeat redundancy (Codex `response.in_progress`
  // discipline mirror). Closed-shape mode union — exhaustive.
  if (isSetModeOp(cfg.submission)) {
    const from: "default" | "plan" =
      cfg.mode === "plan" || cfg.planMode === true ? "plan" : "default"
    const to = cfg.submission.op.mode
    if (from !== to) {
      const reason = cfg.submission.op.reason
      cfg.stream.emit({
        type: "mode_changed",
        from,
        to,
        ...(reason !== undefined ? { reason } : {}),
      })
    }
  }
  return "continue"
}

/**
 * L4 control-op cluster (2026-05-23) — poll the typed
 * {@link FollowUpQueue} (ADR-0037) at the top of each turn. Three outcomes:
 *
 *   - queue unset                         ⇒ returns `null` (no-op).
 *   - thread paused                       ⇒ returns `null` AND emits
 *                                          `response_queued{reason}` so
 *                                          the surface can paint the
 *                                          back-pressure.
 *   - queue empty                         ⇒ returns `null` (no-op).
 *   - thread ready + head non-empty       ⇒ returns the head's content as
 *                                          a synthesized `user` Message
 *                                          (loop appends it to `wm`).
 *
 * Pure except for `popReady` mutation (the queue) and the optional
 * `response_queued` emit. Extracted from the loop body to keep
 * `runAgentInner` flat AND to make the seam unit-testable. Default-OFF: any
 * caller without a queue sees an immediate `null` return — zero cost.
 */
const pollFollowUpQueue = (cfg: AgentConfig, sessionId: string): Message | null => {
  const queue = cfg.followUpQueue
  if (queue === undefined) return null
  const tid = makeThreadId(sessionId)
  // Caller-supplied paused-reason inspector. Absent ⇒ null (always ready
  // when the queue is wired without a reason source — explicit by design).
  const reason = cfg.pausedReason?.(sessionId) ?? null
  if (reason !== null) {
    // Pause: emit a back-pressure event with the same closed reason
    // taxonomy the queue uses; do NOT pop. The follow-up stays at the
    // head, surfacing on the next ready turn.
    emitResponseQueued(cfg, reason)
    return null
  }
  const popped = queue.popReady(tid, null)
  if (popped === null) return null
  // Synthesize a user-turn Message from the ready follow-up's content. One
  // user message per dequeue — multi-line content is the surface's choice
  // (the queue stores `content: string` verbatim).
  return {
    role: "user",
    content: [{ type: "text", text: popped.ready.content }],
  }
}

/**
 * Outcome of the L4 conversation-action poll (2026-05-23). Closed 4-way
 * union; the loop branches on `kind`:
 *
 *   - `none`           ⇒ port returned undefined OR is unset; no action.
 *   - `injection`      ⇒ accepted_injection from `decideAction`; the loop
 *                        pushes `message` onto `wm` (mirrors steerBarrier).
 *   - `finish_aborted` ⇒ accepted_control + cancel; the loop unwinds via
 *                        `finish("aborted", ...)`. `reason` is the cancel
 *                        action's verbatim reason string (observability).
 *   - `continue`       ⇒ accepted_control + cancel_subagent / summarize /
 *                        resume OR rejected; the loop continues unchanged.
 *
 * `cancel_subagent` is routed inside the helper (via the shared
 * `cancelSubagent()` from `./control-op-handler`) and emits a
 * `subagent_cancel` AgentEvent — the loop just sees `continue`.
 */
type ConversationActionPollOutcome =
  | { kind: "none" }
  | { kind: "injection"; message: Message }
  | { kind: "finish_aborted"; reason: string }
  | { kind: "continue" }

/**
 * L4 control-op cluster (2026-05-23) — poll the typed
 * {@link ConversationActionPort} (ADR-0071) at turn entry. Drives behavior
 * for the four accepted_control kinds (cancel / cancel_subagent / summarize
 * / resume) plus the accepted_injection (user_message) path.
 *
 * Reads `cfg.activeTurnRef.current` for the active turn state — the loop
 * sets this immediately above the poll site, so currentTurn is non-null and
 * isInterrupted is false. With no `activeTurnRef` wired the helper returns
 * `none` (the action layer requires an `ActiveTurnState`).
 *
 * Errors at the port boundary collapse to `none` + an `error` AgentEvent —
 * a bug in a host-supplied port must NOT crash the turn loop.
 */
const pollConversationAction = async (
  cfg: AgentConfig,
  taskRegistry: { forceStop(id: string): boolean } | undefined,
): Promise<ConversationActionPollOutcome> => {
  const port = cfg.conversationActionPort
  if (port === undefined) return { kind: "none" }
  // Surface-supplied port — never trust it to be infallible.
  let action: ReturnType<typeof port.next>
  try {
    action = port.next()
  } catch (e) {
    const message = errMessage(e)
    cfg.stream.emit({ type: "error", message: `conversationActionPort.next failed: ${message}` })
    return { kind: "none" }
  }
  if (action === undefined) return { kind: "none" }
  if (cfg.activeTurnRef === undefined) {
    // The action layer requires an ActiveTurnState — surface that as an
    // observability event but don't crash the turn. Reasonable behavior:
    // the surface only set `conversationActionPort` without
    // `activeTurnRef` — programming error in wiring.
    cfg.stream.emit({
      type: "error",
      message: "conversationActionPort requires activeTurnRef to be wired",
    })
    return { kind: "none" }
  }
  // Reuse the loop's existing per-turn clock. `decideAction` is the same
  // pure function the unit tests exercise — same caller-supplied `now`,
  // same closed outcome union.
  const outcome = decideAction(
    action,
    cfg.activeTurnRef.current,
    { maxInputBytes: 64 * 1024 },
    Date.now(),
  )
  if (outcome.kind === "rejected") {
    // Emit observability only; the turn continues.
    cfg.stream.emit({
      type: "error",
      message: `conversation_action rejected: ${outcome.reason}`,
    })
    return { kind: "continue" }
  }
  if (outcome.kind === "accepted_injection") {
    return {
      kind: "injection",
      message: {
        role: "user",
        content: [{ type: "text", text: outcome.injection.content }],
      },
    }
  }
  // accepted_control — branch on the action kind for behavior.
  const act = outcome.action
  if (act.kind === "cancel") {
    emitInterrupted(cfg, "conversation_action_cancel", act.reason)
    return { kind: "finish_aborted", reason: act.reason }
  }
  if (act.kind === "cancel_subagent") {
    const result = cancelSubagent(taskRegistry, act.subagentId)
    emitSubagentCancel(cfg, act.subagentId, result, "conversation_action")
    // unknown_subagent (registry has no record) ⇒ also emit an error event
    // shaped like an `error` AgentEvent (tool_result error semantics —
    // distinct from the registry-absent case where the host never wired
    // subagents at all). The turn continues regardless.
    if (result === "not_found") {
      cfg.stream.emit({
        type: "error",
        message: `cancel_subagent: unknown subagent id ${act.subagentId}`,
      })
    }
    return { kind: "continue" }
  }
  // summarize / resume — no L4 behavior wired here yet; emit observability
  // and continue. The action layer already validated state-shape so the
  // surface knows it was accepted; future rounds will wire the behavior.
  cfg.stream.emit({
    type: "recovery",
    reason: "conversation_action_noop",
    detail: act.kind,
  })
  return { kind: "continue" }
}

export const runAgent = async (config: AgentConfig): Promise<AgentOutcome> => {
  // Codex 10-step span tree — root `session_loop` span. Wraps the WHOLE
  // session body in a try/finally so the span always closes, even on a
  // thrown LLMError / abort. Default-OFF (no sink) ⇒ both calls hit the
  // shared NOOP_SPAN sentinel and are zero-allocation. The span attrs use
  // canonical QUANTA_ATTRS keys; no raw strings.
  const sessionId = config.sessionId ?? "default"
  const sessionSpan: Span = startSpan(SPAN_NAMES.sessionLoop, sessionSpanAttrs(sessionId))
  // Outcome status is derived from `outcome.reason` (the normal-return path)
  // OR set to "error" by the catch branch (the thrown path). Tracked outside
  // the try/finally so the finally has a single closing point — eliminating
  // the "did we already close in catch?" question.
  let spanStatus: "ok" | "error" | "aborted" = "ok"
  try {
    const outcome = await runAgentInner(config)
    spanStatus =
      outcome.reason === "aborted" ? "aborted" : outcome.reason === "error" ? "error" : "ok"
    // ADR-0068 Wave D (L4 wire): session-end consolidator hook. Fires ONLY
    // when the session ended cleanly (spanStatus === "ok") AND the host
    // opted in via `cfg.memoryConsolidator`. The hook itself is no-throw —
    // every internal failure (port/store missing, distill throw, store
    // throw) is converted into a structured outcome surfaced as an `error`
    // AgentEvent + the session still returns its real outcome. Phase 2
    // (cross-session synthesizer) is NON-GOAL here per audit; the host
    // runs it on its own schedule (threshold / explicit trigger).
    if (spanStatus === "ok") {
      await runMemoryConsolidatorHook(
        {
          sessionOk: true,
          consolidator: config.memoryConsolidator,
          sessionId: config.sessionId,
          rolloutMessages: outcome.messages,
          turnCount: outcome.turns,
        },
        (event) => {
          if (event.kind === "error") {
            config.stream.emit({
              type: "error",
              message: `memory consolidator hook failed: ${event.message}`,
            })
          }
          // `skipped` / `distilled` outcomes are intentionally not
          // surfaced as AgentEvents — they are observability concerns
          // for the consolidator span (Wave D follow-up), not user-
          // facing outcomes.
        },
      )
    }
    return outcome
  } catch (e) {
    // An EXCEPTION escaping `runAgentInner` is exceptional (the loop
    // converts every recoverable failure into an outcome). Mark the span
    // accordingly and re-throw so the caller's handling is preserved.
    spanStatus = "error"
    throw e
  } finally {
    // Single close site — runs on normal return AND on throw.
    endSpan(sessionSpan, spanStatus, attrs({}))
  }
}

/** Inner session loop. Identical body to the pre-span path; only the outer
 *  `runAgent` wrapper handles the `session_loop` span. Kept as a separate
 *  function (instead of inlining the span wrap) so the body's control flow
 *  (the multiple `finish(...)` returns + the trailing `max_turns` return)
 *  stays untouched — adding a `try/finally` around it inline would have
 *  required restructuring every return path. */
const runAgentInner = async (config: AgentConfig): Promise<AgentOutcome> => {
  // Tier 1 capability (ADR-0011): materialize optional subsystems ONCE. With no
  // Tier-1 config `features.extraTools` is empty and `cfg === config` by
  // identity, so the loop is byte-for-byte identical to the pre-absorption path.
  const features = await buildSessionFeatures(config)
  // T3 — when the dedup gate is active (caller pre-supplied a gate OR we'll
  // construct one) the loop writes a per-turn stamped `run` AND attaches the
  // gate to the loop-local `cfg`, both of which would mutate the caller's
  // `AgentConfig` if `cfg` aliased `config`. So when the gate is active AND
  // `buildEffectiveConfig` returned the original by identity (no Tier-1
  // extra-tools rebuild), we take a shallow copy here. Gate disabled ⇒ no
  // copy, original alias preserved (byte-identical to the pre-T3 path).
  const dedupGateActive =
    config.dedupGate !== undefined || config.dedupGateConfig?.disabled !== true
  const baseCfg = buildEffectiveConfig(config, features.extraTools)
  const cfg: AgentConfig = dedupGateActive && baseCfg === config ? { ...baseCfg } : baseCfg
  const classifier = features.classifier
  const skillGate = buildSkillGate(features.skillAllowlists, features.skillOverrides)
  // Cached once at session start (Codex anti-reread). Passed straight into the
  // per-turn reminder by `prepareTurnContext`. Absent ⇒ no block emitted, so
  // skill-less sessions stay byte-identical end-to-end.
  const activeSkills = features.activeSkills
  const { stream } = cfg
  // ADR-0062 (Spec A3): typed Submission envelope wins for the seed when
  // present AND projects to a user-input shape. The legacy `cfg.messages`
  // remains the canonical history buffer — when a submission is provided
  // we DERIVE the seed list (existing tail + projected user turn) but
  // `cfg.messages` is left untouched (caller's object is never mutated,
  // mirroring `stampTurn`'s discipline). Absent ⇒ byte-identical legacy.
  const submissionSeed =
    cfg.submission && isUserInputSubmission(cfg.submission)
      ? extractSeedMessages(cfg.submission)
      : undefined
  // Canonical in-session message buffer (RFC §6.3). Seeded from `cfg.messages`
  // (legacy) OR `cfg.messages` + projected submission turn appended (Spec A3
  // — a Submission carrying a `user_input` op replaces / appends the last
  // user turn so a resumed history + a new submission both work).
  const seedMessages = submissionSeed ? [...cfg.messages, ...submissionSeed] : cfg.messages
  const wm: WorkingMemory<Message> = createWorkingMemory<Message>(seedMessages)
  const specs = cfg.registry.specs()
  const recorder = cfg.metrics ? new AgentRecorder(cfg.metrics) : undefined
  const sessionId = cfg.sessionId ?? "default"
  // Tier 0 safety hardening (ADR-0011): one breaker per session. ON by default with
  // DEFAULT_COMPACTION_BREAKER_CAPS — only trips on pathological compaction
  // thrash, so configured-but-normal and unconfigured sessions are unaffected.
  const breaker = cfg.compactionBreaker?.disabled
    ? undefined
    : new CompactionBreaker(cfg.compactionBreaker?.caps)
  // T3 — pre-flight dedup gate. ON by default with DEFAULT_DEDUP_GATE_CAPS so
  // a pallets-style env-loop thrash is structurally braked. The gate is pure-
  // by-state (deterministic, no Date.now/random) and per-session: one instance
  // per `runAgent` invocation, never shared across sessions. Honors a
  // caller-supplied `cfg.dedupGate` (test injection / explicit override) and
  // falls back to constructing from `cfg.dedupGateConfig.caps`. Setting
  // `dedupGateConfig.disabled:true` opts out entirely.
  const dedupGate =
    cfg.dedupGate ??
    (cfg.dedupGateConfig?.disabled ? undefined : new DedupGate(cfg.dedupGateConfig?.caps))
  // Make the constructed gate visible to `dispatchTool` via the loop-local
  // effective config. Disabled / caller-already-set ⇒ no-op (cfg.dedupGate
  // either stays undefined or keeps the caller's instance verbatim).
  if (dedupGate !== undefined && cfg.dedupGate === undefined) cfg.dedupGate = dedupGate
  // Verify-guard (ADR-0011, Tier 0 safety hardening): per-run forcing budget + ordered
  // dispatched-tool log, created ONLY when `cfg.verifyGuard` is set. Absent ⇒
  // both stay `undefined`, no object is allocated, the history push and the
  // guard decision are never reached → loop is byte-for-byte identical. The
  // construction is factored out so `runAgent` gains ZERO new branch points.
  const { state: verifyGuardState, history: toolHistory } = buildVerifyGuard(cfg)
  // Closeout reminder (§4 mirror): single-shot per-run closeout budget,
  // created ONLY when `cfg.closeoutGuard?.enabled === true`. Absent (or
  // `enabled !== true`) ⇒ stays `undefined`, no object is allocated, the
  // guard decision is never reached → loop is byte-for-byte identical. The
  // construction is factored out (mirroring `buildVerifyGuard`) so `runAgent`
  // gains ZERO new branch points.
  const closeoutGuardState = buildCloseoutGuard(cfg)
  // ADR-0062 rule #3 — cap-as-instruction enforcement (DEFAULT-OFF).
  // Built ONLY when `cfg.capEnforce === true` OR `QUANTA_CAP_ENFORCE=1` env
  // flag is set (checked inside `buildCapEnforcer`). A caller-supplied
  // `cfg.capEnforcer` (e.g. test injection) is honoured without re-building.
  // With neither set ⇒ `undefined`, no allocation, dispatch is byte-identical.
  const capEnforcer = cfg.capEnforcer ?? buildCapEnforcer(cfg.capEnforce)
  if (capEnforcer !== undefined && cfg.capEnforcer === undefined) {
    cfg.capEnforcer = capEnforcer
  }
  // Localize-phase guard (Agentless "localize-first" absorption — Tier 0).
  // Built ONLY when `cfg.localizePhase.phase1Turns` is a positive integer
  // (`buildLocalizePhase` validates the active domain). Absent / invalid ⇒
  // `undefined`, no allocation, the dispatch consult is a single property
  // check + early return → loop byte-identical for callers without the opt-in.
  // The state is ATTACHED to `cfg.localizePhaseState` so the sibling dispatch
  // module can read it through the AgentConfig channel (mirrors the dedupGate
  // pattern); the loop bumps `state.turn` at the TOP of each turn iteration.
  const localizePhaseState = buildLocalizePhase(cfg)
  if (localizePhaseState !== undefined && cfg.localizePhaseState === undefined) {
    cfg.localizePhaseState = localizePhaseState
  }
  // Turn-exit guard chain (refactor 2026-05-23): one composed chain replaces
  // the prior `verifyGuardStep` + `closeoutGuardStep` ladder in `applyAction`.
  // Default-OFF byte-identical: when neither `cfg.verifyGuard` is set NOR
  // `cfg.closeoutGuard.enabled === true`, `buildGuardChain` returns `[]` and
  // `applyAction` short-circuits with `guards.length > 0` (zero allocation,
  // zero work). Order: VerifyGuard before CloseoutGuard (matches the legacy
  // ordering — see `./guards/build.ts`).
  const guardChain = buildGuardChain({
    config: cfg,
    verifyGuardState,
    closeoutGuardState,
  })
  // ADR-0079 — session-scoped tool_choice turn state. Always constructed (a
  // bare `{verifyGuardViolated:false, closeoutAttempted:false}`); with no guard
  // ever arming a flag, `consumeTurnSignals` always yields `{}` and
  // `resolveToolChoice` always returns `{kind:"auto"}` ⇒ the field is omitted
  // from every `StreamInput` (byte-identical wire payload, default-OFF).
  const toolChoiceState = createToolChoiceTurnState()
  // ADR-0133 — session-scoped pending list of hook-emitted `promptHook`
  // responses (from `subagent_start` / `subagent_stop` / `turn_start` /
  // etc.). The subagent runner pushes to this via the typed
  // `subagentPendingPrompt` config seam; the per-turn `prepareTurnContext`
  // drains the list AFTER a successful build so a same-turn retry sees the
  // same injects but the NEXT turn starts fresh.
  //
  // Default-OFF: when `cfg.hooks` is undefined AND no producer (turn_start
  // hook, runner) ever pushes, the list stays empty and `prepareTurnContext`
  // omits the field (byte-identical to the pre-ADR-0133 path).
  const hookPromptPending: import("./hooks").HookPromptInject[] = []
  if (cfg.subagentPendingPrompt === undefined) {
    cfg.subagentPendingPrompt = {
      push: (entry: import("./hooks").HookPromptInject) => hookPromptPending.push(entry),
    }
  }
  // ADR-0082 — run-scoped memory_citation accumulator. Append-only: each
  // recall that places records into the prompt window pushes one citation per
  // placed record (via the `recallContext` `onPlaced` seam, threaded through
  // `prepareTurnContext` → `resolveMemoryContext`). `finish()` attaches it to
  // the outcome ONLY when non-empty (no store / no recall hits ⇒ omitted,
  // byte-identical).
  const memoryCitations: MemoryCitation[] = []
  // ADR-0078 — startup gate: `normalizeRedactionConfig` THROWS a
  // `RedactionConfigError` when redaction is `disabled` without a non-empty
  // `acknowledgedRisk` (refuse to start silently unprotected). default-ON when
  // `cfg.redaction` is absent. The run-scoped aggregator folds every hit
  // (origin × kind) into a count; `finish()` surfaces it as
  // `AgentOutcome.redactions` ONLY when non-empty (no hits ⇒ omitted, byte-
  // identical). When redaction is disabled, dispatch/distill/envelope never
  // produce hits so the rollup stays empty (the banner is the user-facing seam).
  const redactionEnabled = normalizeRedactionConfig(cfg.redaction).enabled
  const { agg: redactionAgg, record: recordRedaction } = createRedactionRollup()
  // Codex absorption — memory L3 (Phase 6): session-scoped WorkingState.
  // Wired in by `buildSessionFeatures` when `cfg.workingState?.enabled === true`;
  // absent ⇒ `undefined`, no allocation, the per-turn block is omitted (byte-
  // identical for callers without the opt-in).
  const workingState = features.workingState
  // ADR-0075 — Cursor-style ConversationSummaryArchive. Built ONLY when
  // `cfg.compaction?.archive === true`; absent ⇒ `undefined`, no allocation,
  // and `maybeCompact` skips the archive-append + `context_compacted` emit
  // path entirely (byte-identical to the pre-archive loop). One archive per
  // session lifetime (never shared across `runAgent` invocations) — the loop
  // owns it.
  const summaryArchive: ConversationSummaryArchive | undefined =
    cfg.compaction?.archive === true ? createArchive() : undefined
  // ADR-0077 Plane-B (L4 wire): session-scoped slot for the LAST sampling-
  // request's TurnTiming snapshot. `streamConsume` overwrites this on every
  // stream close (productive turn OR error/abort). `finish()` surfaces it on
  // `AgentOutcome.turnTiming` ONLY when non-null AND the run produced at
  // least one productive turn (i.e. a stream was actually opened). The
  // YAML's "마지막 productive turn의 snapshot surface" contract: a no-stream
  // immediate-abort run never opens a stream so the slot stays null and the
  // outcome field stays omitted (byte-identical for callers that only read
  // `reason`).
  let lastTurnTiming: TurnTiming | null = null
  const recordTurnTiming = (timing: TurnTiming): void => {
    lastTurnTiming = timing
  }

  // ADR-0125 turn-diff loop wiring — opt-in trigger: only when
  // `cfg.gitObservability?.enabled === true`. Explicit (not auto-enabled when
  // `shadowOdb` is wired) so a caller that wired the storage port for
  // `branch_search` / rewind consumers does NOT pay the per-turn `git
  // rev-parse` + `git diff` cost without asking. Absent / disabled ⇒
  // `turnDiffSession` stays `undefined`, no allocation, no `git` spawn, no
  // emit — byte-identical to the pre-wire path. A caller-supplied `session`
  // (test-injection seam, mirrors `dedupGate`) is honored verbatim so unit
  // tests can spy on `startTurn`/`endTurn` without spawning `git`.
  const turnDiffSession: TurnDiffSession | undefined =
    cfg.gitObservability?.enabled === true
      ? (cfg.gitObservability.session ??
        wireGitObservability({ runner: defaultGitRunner, cwd: cfg.cwd, signal: cfg.signal })
          .turnDiff)
      : undefined

  // R2-B P1 — session-lifetime bundle. Configured ONCE here (after every
  // session resource the helpers might need has been materialized) and passed
  // unchanged into every `runTurn` call. The bundle is `readonly`, so a helper
  // cannot accidentally rebind a session field mid-loop. Per-turn mutable
  // state (`rec`, `wm`, …) lives in the SECOND bundle built inside the for
  // loop (so `freshRecovery()` runs once per turn — byte-identical to the
  // pre-bundle path that constructed it positionally on every call).
  const session: TurnSession = {
    config: cfg,
    specs,
    ...(recorder !== undefined ? { recorder } : {}),
    ...(classifier !== undefined ? { classifier } : {}),
    ...(skillGate !== undefined ? { skillGate } : {}),
    ...(activeSkills !== undefined ? { activeSkills } : {}),
    ...(summaryArchive !== undefined ? { archive: summaryArchive } : {}),
    guards: guardChain,
    hookPromptPending,
  }

  const finish = async (
    reason: StopReason,
    turns: number,
    stopCategory?: StopCategory,
    refusal?: { readonly rationale: string },
  ): Promise<AgentOutcome> => {
    // ADR-0030: clear the active-turn header and reflect the stop reason so a
    // surface can ask "are we still mid-turn? were we interrupted?" after the
    // loop returns. Absent ref ⇒ no-op (byte-identical legacy).
    if (cfg.activeTurnRef) {
      cfg.activeTurnRef.current = { currentTurn: null, isInterrupted: reason === "aborted" }
    }
    const messages = [...wm.snapshot()]
    // ADR-0078 point #2 — envelope_jsonl: every text block of the final
    // transcript is scanned at the persistence boundary and its hits folded
    // into the run rollup. Counting only — the block text is NOT mutated here
    // so the memory_distill path (point #3) still redacts the SAME raw secret
    // independently (each origin fires once per secret). Disabled ⇒ skipped.
    if (redactionEnabled && cfg.store) {
      for (const m of messages) {
        for (const b of m.content) {
          if (b.type !== "text") continue
          const r = redactSecrets(b.text, { origin: "envelope_jsonl" })
          if (!r.unchanged) recordRedaction("envelope_jsonl", r.hits)
        }
      }
    }
    if (cfg.store) {
      await persistSession(buildPersistDeps(cfg, recorder, redactionEnabled, recordRedaction), {
        sessionId,
        finalMessages: messages,
      })
    }
    // R-Phase5 P0-A: graceful shutdown of any pending background subagents.
    // `features.cleanup` is set ONLY when `config.subagent` is configured
    // (features.ts:204+), so `?.()` is a no-op for default-OFF sessions
    // (RFC §1.2 byte-identical preserved). Idempotent: a second call sees
    // `pendingIds() === []` and returns immediately. Failures are best-effort
    // (the session is already finishing) — surface as an `error` event so
    // probe/triage can see them, but do NOT block the outcome resolution.
    try {
      await features.cleanup?.()
    } catch (e) {
      const message = errMessage(e)
      stream.emit({ type: "error", message: `subagent cleanup failed: ${message}` })
    }
    // L4 control-op cluster (2026-05-23) — follow-up queue snapshot save.
    // Helper-extracted to keep `finish` flat (cognitive-complexity budget).
    await saveFollowUpQueueSnapshot(cfg)
    // ADR-0095 P7 — plan-mode snapshot save. Same boundary discipline as the
    // queue save: errors collapse to `error` AgentEvent, never block finish.
    await savePlanSnapshot(cfg)
    recorder?.stopReason(reason)
    if (cfg.hooks) await cfg.hooks.emit({ type: "session_end", reason, turns })
    stream.emit({ type: "done", reason, turns })
    // ADR-0073 (Spec B3): attach the structured stop-category when the caller
    // provided one. `exactOptionalPropertyTypes`: spread conditionally so
    // legacy callers see an outcome with NO `stopCategory` field (byte-
    // identical to pre-B3 — they cannot observe a `stopCategory: undefined`).
    // ADR-0073 stopCategory + ADR-0082 memoryCitations are both optional
    // add-ons: spread each only when present so a legacy outcome carries
    // neither field (byte-identical — callers that read only `reason` cannot
    // observe an `undefined`/empty-array property).
    // ADR-0078 — surface the redaction rollup ONLY when hits fired (omitted
    // otherwise, byte-identical for callers that ignore it).
    const redactions = redactionAgg.size > 0 ? [...redactionAgg.values()] : undefined
    return {
      reason,
      turns,
      messages,
      ...(stopCategory !== undefined ? { stopCategory } : {}),
      ...(memoryCitations.length > 0 ? { memoryCitations } : {}),
      ...(redactions !== undefined ? { redactions } : {}),
      // ADR-0076 Gap-1 SOTA++ — refusal payload, spread conditionally so a
      // non-refusal outcome carries NO `refusal` key (byte-identical legacy).
      ...(refusal !== undefined ? { refusal } : {}),
      // ADR-0077 Plane-B (L4 wire): surface the LAST sampling-request's
      // timing snapshot ONLY when a stream was actually opened (i.e.
      // `streamConsume` ran at least once and overwrote the slot). An
      // immediate-abort / no-stream run leaves the slot null and the
      // field is omitted — byte-identical for callers that ignore it.
      ...(lastTurnTiming !== null ? { turnTiming: lastTurnTiming } : {}),
    }
  }

  // RFC-0002 §5.2 `session_start` — emitted ONCE at run start so the trajectory
  // has a head marker (Group E maps it → kind:"session_start"). Pure
  // observation: an AgentEvent only seen when a stream/recorder is attached
  // (NullStream swallows it); it precedes nothing in the control flow.
  stream.emit({ type: "session_start" })

  if (cfg.hooks) await cfg.hooks.emit({ type: "session_start", sessionId })

  // L4 control-op cluster (2026-05-23) — follow-up queue snapshot restore.
  // Helper-extracted; see `restoreFollowUpQueueSnapshot` below.
  await restoreFollowUpQueueSnapshot(cfg)
  // ADR-0095 P7 — plan-mode snapshot restore. Mirror discipline: errors
  // collapse to `error` AgentEvent, never crash session-start.
  await restorePlanSnapshot(cfg)

  // L4 control-op cluster (2026-05-23) — Codex `ensureReady()` gate mirror.
  // Now that the session is past `session_start` we can OBSERVE typed control
  // ops on the submission envelope. Helper-extracted to keep `runAgentInner`
  // under the cognitive-complexity budget; see `handleSubmissionControlOp`
  // below. Returns `aborted` when the submission carries an `interrupt` op
  // so the caller short-circuits into `finish`.
  const subOutcome = handleSubmissionControlOp(cfg, features.taskRegistry)
  if (subOutcome === "aborted") {
    return finish("aborted", 0, interruptedCategory("user"))
  }

  for (let turn = 1; turn <= cfg.maxTurns; turn++) {
    if (cfg.signal.aborted) return finish("aborted", turn - 1, interruptedCategory("user"))
    // Localize-phase guard turn-counter bump (Agentless absorption — Tier 0).
    // The loop's `turn` is 1-indexed; the guard's `state.turn` is 0-indexed
    // (turn 0 = first turn). Absent state ⇒ no-op, byte-identical loop.
    if (localizePhaseState !== undefined) {
      localizePhaseState.turn = turn - 1
    }
    // RFC may-22 Phase 1: BudgetMeter tick — turn start. Optional-chain ⇒ when
    // `cfg.budgetMeter === undefined` the call is a no-op and the loop is
    // byte-for-byte identical to the pre-RFC path.
    cfg.budgetMeter?.tick("turn")
    // ADR-0030 mid-turn steering seam (default-OFF ⇒ both no-ops, byte-
    // identical legacy). Order matters: await the barrier FIRST so a pending
    // surface injection lands in the conversation buffer before we expose the
    // fresh turn header and snapshot it for this turn's LLM call.
    if (cfg.steerBarrier) {
      // The surface may push a steered user message into the conversation
      // buffer (`cfg.messages`) while the barrier resolves. `wm` holds its own
      // copy (constructor does `[...initial]`), so reconcile the tail the
      // barrier appended into `wm` — that is what the NEXT LLM snapshot reads.
      const beforeLen = cfg.messages.length
      await cfg.steerBarrier()
      for (let i = beforeLen; i < cfg.messages.length; i++) {
        const injected = cfg.messages[i]
        if (injected) wm.append(injected)
      }
    }
    if (cfg.activeTurnRef) {
      cfg.activeTurnRef.current = {
        currentTurn: makeTurnHeader({
          turnId: crypto.randomUUID(),
          kind: "main",
          startedAt: Date.now(),
          threadId: sessionId,
        }),
        isInterrupted: false,
      }
    }

    // L4 control-op cluster (2026-05-23) — queued-follow-ups (ADR-0037) +
    // typed ConversationAction (ADR-0071) consumption.
    //
    // Ordering:
    //   1. Follow-up queue popReady (after steerBarrier, before
    //      conversation-action): a queued follow-up is the OLDEST pending
    //      input, so it seeds the next turn first. A non-null pausedReason
    //      defers the pop and emits `response_queued{reason}` so the
    //      surface can paint the back-pressure.
    //   2. Conversation-action port poll: a typed action may inject a
    //      user_message OR control the turn (cancel / cancel_subagent /
    //      summarize / resume). The decision uses the activeTurnRef state
    //      we just set (currentTurn non-null, isInterrupted false).
    //
    // Both are default-OFF (the absence of `followUpQueue` /
    // `conversationActionPort` skips the entire block; byte-identical).
    const followUpResult = pollFollowUpQueue(cfg, sessionId)
    if (followUpResult !== null) wm.append(followUpResult)
    const conversationActionOutcome = await pollConversationAction(cfg, features.taskRegistry)
    if (conversationActionOutcome.kind === "finish_aborted") {
      // accepted_control + cancel ⇒ unwind the parent turn (matches
      // submission interrupt semantics). turn-1 because the for-loop's
      // turn counter is 1-based; we have not yet consumed THIS turn.
      return finish("aborted", turn - 1, interruptedCategory("user"))
    }
    if (conversationActionOutcome.kind === "injection") {
      wm.append(conversationActionOutcome.message)
    }

    // Per-turn correlation working copy (RFC-0002 §5.1/§5.4). Pre-T3 this
    // was computed-and-discarded (`void stampTurn(...)`) so the caller's
    // `config.run` was never observed by downstream code. T3 reads the
    // stamped `turn` from `cfg.run?.turn` inside `dispatchTool` to drive the
    // dedup gate's sliding window, so when the gate is active we MUST
    // actually thread the per-turn run. Two sub-cases:
    //   1. caller supplied `config.run` ⇒ stamp `{...run, turn}` (still a
    //      fresh copy — the caller's object is not mutated).
    //   2. no `config.run` AND gate active ⇒ synthesize a minimal one
    //      (`runId:sessionId`) so the structural brake actually engages for
    //      the default RunContext-less path.
    // Gate INACTIVE ⇒ neither branch runs (mirrors the pre-T3 discard),
    // preserving byte-identical behavior for callers without the gate.
    if (dedupGate) {
      const stamped = stampTurn(cfg.run, turn)
      cfg.run = stamped ?? { runId: sessionId, turn }
    }
    stream.emit({ type: "turn_start", turn })
    if (cfg.hooks) {
      const tsEmit = await cfg.hooks.emit({ type: "turn_start", turn })
      // ADR-0133 — a `turn_start` hook may return promptHook (e.g. inject a
      // per-turn checklist). Push into the session-scoped pending list so
      // runTurn's snapshot folds it into THIS turn's prompt.
      if (tsEmit.promptHook !== undefined) hookPromptPending.push(tsEmit.promptHook)
    }

    // absorb #6 (ADR-0064): per-turn work-metrics. Both fields are `undefined`
    // when no sink is wired (byte-identical, RFC §1.2). See `buildWorkMetrics`
    // helper above runAgent — keeps the runAgent body free of new branches.
    const { collector: workCollector, turnId: workTurnId } = buildWorkMetricsResources(cfg)

    // Codex 10-step span tree — `session_task.turn`. Opens before the per-
    // turn work begins, closes after `runTurn` returns (success OR failure).
    // The turnId is derived from `activeTurnRef.currentTurn` when set (reuse
    // the same id so an OTel trace ties to the surface header), else a
    // freshly-generated UUID (the canonical id for this turn). With no sink
    // the wrap is two no-op calls (NOOP_SPAN sentinel). Status mapping:
    // `aborted` ⇒ aborted, `error` ⇒ error, otherwise `ok`.
    const turnId = cfg.activeTurnRef?.current.currentTurn?.turnId ?? crypto.randomUUID()
    const turnSpan: Span = startSpan(SPAN_NAMES.turn, turnSpanAttrs(turnId))
    let turnSpanStatus: "ok" | "error" | "aborted" = "ok"
    // ADR-0125 turn-diff loop wiring — snapshot the turn-start anchor SHA
    // BEFORE the turn body runs. Absent session ⇒ no-op, no `git rev-parse`
    // spawn, byte-identical. Awaited so a slow git call serializes with the
    // body (the emitter is already best-effort: a null anchor at endTurn just
    // returns null). Uses the loop's 1-indexed `turn` directly as the turn
    // index (the emitter treats it as an opaque key per session).
    if (turnDiffSession !== undefined) await turnDiffSession.startTurn(turn)
    // Recovery counters are per-turn: SAME-TURN retries share & exhaust these,
    // a fresh turn starts clean. runTurn owns the SEAM (buildTurnContext) and
    // mutates `messages` (canonical history) in place.
    let result: TurnResult
    try {
      // R2-B P1 — per-turn state bundle. `freshRecovery()` is constructed here
      // so each turn enters runTurn with a clean counter (byte-identical to the
      // pre-bundle positional call). All other fields are session-lifetime
      // handles whose pointers don't change turn-to-turn (just shared by
      // reference). `workCollector` is per-turn (built above for THIS turn).
      const state: TurnState = {
        wm,
        rec: freshRecovery(),
        breaker,
        toolHistory,
        workingState,
        collector: workCollector,
        toolChoiceState,
        citations: memoryCitations,
        onRedaction: recordRedaction,
        onTurnTiming: recordTurnTiming,
      }
      result = await runTurn(turn, session, state)
      turnSpanStatus =
        result.kind === "aborted" ? "aborted" : result.kind === "error" ? "error" : "ok"
    } catch (e) {
      // runTurn does not throw today (every failure is converted to a
      // TurnResult), but mark the span as error and re-throw if it ever
      // does — the catch is defense in depth so the span always closes.
      turnSpanStatus = "error"
      endSpan(turnSpan, turnSpanStatus, attrs({}))
      throw e
    }
    endSpan(turnSpan, turnSpanStatus, attrs({}))

    // ADR-0125 turn-diff loop wiring — compute the cumulative diff between the
    // turn-start anchor and the current HEAD/worktree, emit it onto the loop's
    // stream if non-null. Absent session / no anchor / no changes / git
    // failures ⇒ `endTurn` returns null and nothing is emitted (best-effort,
    // never throws). Fires for EVERY turn the loop reached (including the
    // terminal aborted/error/refusal/completed turns) so a host UI sees the
    // final turn's diff before the loop returns. Position: after `endSpan` so
    // the turn span closes before the diff emit lands, AND before
    // `emitWorkMetrics` so a host that watches both events sees the diff
    // FIRST (matches the recorder-first emission convention).
    if (turnDiffSession !== undefined) {
      const diffEvent = await turnDiffSession.endTurn(turn)
      if (diffEvent !== null) stream.emit(diffEvent)
    }

    // C11: turn accounting is now consistent. `recorder?.turn()` used to fire
    // at turn-top, so a turn that immediately aborted/errored BEFORE producing
    // any model output still inflated `agent.turns` — yet the aborted branch
    // already reported `turn - 1` to `AgentOutcome.turns`, an error-vs-abort
    // off-by-one. We now count a turn (metric AND outcome) only when it did
    // real work: `tools` advanced the loop or `completed` produced a final
    // model turn. A no-work `aborted`/`error` reports `turn - 1` and does NOT
    // bump the recorder — so `AgentOutcome.turns` and `agent.turns` always
    // agree. Normal-path counts are unperturbed (every productive turn still
    // counts exactly once; `max_turns` is reached only via productive tool
    // turns, so it still reports `cfg.maxTurns`).
    // absorb #6 (ADR-0064): finalize + emit the per-turn work snapshot via a
    // helper. Skipped when no sink is wired (byte-identical) or the turn
    // aborted before any work landed (snapshot would be all-zeros — no signal).
    emitWorkMetrics(cfg, workCollector, workTurnId, result.kind)
    if (result.kind === "aborted") {
      return finish("aborted", turn - 1, interruptedCategory("user"))
    }
    if (result.kind === "error") {
      // Mirror the abort semantics: a turn that errored without producing a
      // productive model turn did no work, so it must not inflate the count.
      stream.emit({ type: "error", message: result.reason })
      // ADR-0073 (Spec B3): classify the free-form reason into a structured
      // {@link StopCategory}. Pure classification — no IO, no clock; legacy
      // `reason: "error"` stays the authoritative top-level outcome so a
      // surface that only reads it sees byte-identical behavior.
      return finish("error", turn - 1, classifyErrorReason(result.reason))
    }
    if (result.kind === "refusal") {
      // ADR-0076 Gap-1 SOTA++ — model declined via `stop_reason="refusal"`.
      // The refusing turn DID produce a final assistant message (visible
      // refusal text), so it counts as work: bump the recorder and report
      // `turn` (not `turn - 1`) — mirrors the `completed` accounting. The
      // typed `refusal.rationale` is threaded into the outcome via the
      // 4th finish() arg.
      recorder?.turn()
      return finish("refusal", turn, refusalCategory(), { rationale: result.rationale })
    }
    recorder?.turn()

    // RFC may-22 Phase 1 + audit R1 fix: BudgetMeter exhaustion check runs
    // BEFORE the `completed` early-return so a cap (cost / tokens / tools)
    // blown DURING the terminal turn reports `budget_exhausted` rather than a
    // false `completed` (exit 0). The check is here — after this turn's usage
    // ticks have all fired (emitWorkMetrics is post-turn) and after the
    // aborted/error early-returns (user intent / LLM error stay authoritative)
    // — so it covers BOTH the completing turn and the continue-to-next-turn
    // path with a single propositional check. Default-OFF (no meter ⇒ no
    // check, byte-identical legacy).
    const ex = cfg.budgetMeter?.checkExhausted()
    if (ex?.exhausted) {
      return finish("budget_exhausted", turn, completedCategory("max_turns"))
    }
    if (result.kind === "completed") return finish("completed", turn, completedCategory("normal"))

    // A real tool turn landed (not stuck thrashing compaction) — clear the
    // consecutive no-progress strikes (Tier 0 safety hardening, ADR-0011).
    breaker?.noteProgress()
    wm.append({ role: "user", content: result.resultBlocks })
  }

  return finish("max_turns", cfg.maxTurns, completedCategory("max_turns"))
}
