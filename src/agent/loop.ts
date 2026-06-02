import type { LLMPort, Message, StreamEvent, SystemPromptInput, ToolChoice } from "@/llm"
import { withImageSanitizationRetry } from "@/llm/image-sanitization-retry"
import { createWorkingMemory, type WorkingMemory } from "@/memory"
import { createWorkingMemoryHistorySanitization } from "@/memory/history-sanitization"
import {
  attrs,
  createTurnTimingCapture,
  endSpan,
  SPAN_NAMES,
  type Span,
  startSpan,
  type TurnTiming,
} from "@/observability"
import { withEgressProxy } from "@/runtime/network-proxy"
import { normalizeRedactionConfig } from "@/security"
import type { PromptPolicySnapshot, TurnPolicySnapshot } from "@/shared"
import { abortReasonOf, errMessage, LLMError, logger } from "@/shared"
import { compactIfNeeded, estimateTokens, reactiveCompact } from "./compaction"
import { type BreakerVerdict, CompactionBreaker } from "./compaction-breaker"
import {
  appendSummary,
  type ConversationSummaryArchive,
  createArchive,
} from "./conversation-summary-archive"
import { emitBudgetExhaustedDecision } from "./decision-emit-phase3"
import { effortToTokenBudget } from "./effort"
import { buildSessionFeatures } from "./features"
// ADR-0125 turn-diff loop wiring (default-OFF). Opt-in via
// `config.gitObservability.enabled === true`. Constructs a per-session
// `TurnDiffSession` from the composite helper and calls startTurn/endTurn at
// the per-turn boundary so a host sees the SHAPE of what each turn changed.
import type { TurnDiffSession } from "./git-observability"
import { buildGuardChain, metaUser, runGuardChain } from "./guards"
import { renderIdeContext } from "./ide-context"
// ADR-0346 — per-turn plugin activation hook. Called from `prepareTurnContext`
// BEFORE `buildTurnContext`; absent `cfg.activatePlugins` ⇒ canonical-empty
// resolvedSkills ⇒ caller's `activeSkills` returned by reference (byte-
// identical pass-through).
import {
  augmentActiveSkillsWithPlugin,
  resolvePluginActivationForTurn,
} from "./loop-activation-hook"
import {
  attachCapEnforcer,
  attachDedupGate,
  attachLocalizePhase,
  buildGitDirectiveEmit,
  buildPostCompactEmit,
  buildPreCompactHook,
  buildSeedMessages,
  buildTtftAttrs,
  buildTurnDiffSession,
  scanEnvelopeForRedactions,
  wireHookPromptPending,
} from "./loop-helpers"
import { attachLspDiagnosticsHookIfEnabled } from "./lsp-bridge"
import { persistSession, recallContext } from "./memory"
import { runMemoryConsolidatorHook } from "./memory-consolidator-hook"
import { AgentRecorder } from "./metrics"
import { buildTurnContext } from "./prompt"
import {
  type AssembledMessage,
  decideFromStopPolicy,
  decideOnAssembled,
  decideOnStreamError,
  freshRecovery,
  type RecoveryAction,
  type RecoveryReason,
} from "./recovery"
import { buildShellSnapshotSession, type ShellSnapshotSession } from "./shell-snapshot-session"
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

import type { TaskBudget } from "./budget"
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
import type { HookPromptInject } from "./hooks"
import { resolveCollaborationMode } from "./mode"
import { planToStreamMirror } from "./plan/stream-mirror"
import { applyPlanExitOutcome } from "./plan-exit-lifecycle"
import { backoffDelayMs } from "./retry"
import {
  buildCloseoutGuard,
  buildEffectiveConfig,
  buildPersistDeps,
  buildVerifyGuard,
  buildWorkMetricsResources,
  createRedactionRollup,
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
import { consumeTurnSignals, createToolChoiceTurnState, resolveToolChoice } from "./tool-choice"
import { buildToolInputSeam } from "./tool-input-streaming"
import {
  appendPendingToolResults,
  flushTurnObservability,
  stripOrphanToolUse,
} from "./turn-closeout"
import { makeTurnHeader } from "./turn-kind"
import type { AgentConfig, AgentOutcome, MemoryCitation, StopReason } from "./types"
import type { TurnWorkMetricsCollector } from "./work-metrics-collector"

type PendingPlanExit = {
  readonly plan: string
  readonly outcome: import("./plan-exit").PlanExitOutcome
}

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
  taskSpend: { tokens: number } | undefined,
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
  // jun-02 — soft task-budget cumulative spend. Present ONLY when
  // `config.taskBudget` is set (the box is allocated in runAgent). Accumulates
  // the SAME input+output token total the meter/recorder see; non-finite /
  // negative reports are coerced to 0 so the running sum can never go
  // non-finite (`renderTaskBudgetBlock` also clamps, this is belt-and-braces).
  if (taskSpend !== undefined) {
    const inTok = Number.isFinite(ev.inputTokens) && ev.inputTokens > 0 ? ev.inputTokens : 0
    const outTok = Number.isFinite(ev.outputTokens) && ev.outputTokens > 0 ? ev.outputTokens : 0
    taskSpend.tokens += inTok + outTok
  }
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

const isSessionApprovalRequiredError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("approval" in error)) return false
  const approval = (error as { approval?: unknown }).approval
  return (
    typeof approval === "object" &&
    approval !== null &&
    "approvalId" in approval &&
    "reason" in approval &&
    "requestedAt" in approval
  )
}

/** Pure side-effect emit of a `{type:"llm_request"}` AgentEvent IMMEDIATELY
 *  before the turn's model stream is consumed (RFC-0002 §5.2/§9/§11). The
 *  recorder pairs it with the turn's trailing `llm_usage` via the SAME llm
 *  span. Like `emitRecovery`/`emitUsage` this is observation-only: NullStream
 *  swallows it, control flow / emit ordering / the default-OFF byte-identical
 *  contract are untouched. */
const finalizeTurnPolicy = (args: {
  readonly promptPolicy: PromptPolicySnapshot
  readonly toolChoice: ToolChoice
  readonly promptCacheKey?: string
}): TurnPolicySnapshot => ({
  ...args.promptPolicy,
  toolChoice: args.toolChoice.kind,
  ...(args.toolChoice.kind === "tool" ? { toolChoiceToolName: args.toolChoice.name } : {}),
  promptCacheKeyPresent: args.promptCacheKey !== undefined && args.promptCacheKey.length > 0,
})

const emitLlmRequest = (config: AgentConfig, policy: TurnPolicySnapshot): void => {
  config.stream.emit({
    type: "llm_request",
    model: configuredModel(config.llm),
    ...(config.llm.provider !== undefined ? { provider: config.llm.provider } : {}),
    ...(config.llm.surfaceId !== undefined ? { surfaceId: config.llm.surfaceId } : {}),
    ...(config.llm.transportId !== undefined ? { transportId: config.llm.transportId } : {}),
    ...(config.llm.authMode !== undefined ? { authMode: config.llm.authMode } : {}),
    policy,
  })
}

/** Observation-only bridge for stateful Responses continuation routing. Keeps
 *  the authoritative decision in `@/llm` as a `StreamEvent`, then projects it
 *  onto the agent event rail so jsonl / CLI / dashboards see the same truth. */
const emitLlmContinuation = (
  config: AgentConfig,
  ev: Extract<StreamEvent, { type: "llm_continuation" }>,
): void => {
  config.stream.emit({
    type: "llm_continuation",
    ...(config.llm.provider !== undefined ? { provider: config.llm.provider } : {}),
    surfaceId: ev.surfaceId,
    transportId: ev.transportId,
    phase: ev.phase,
    mode: ev.mode,
    reason: ev.reason,
    ...(ev.statusCode !== undefined ? { statusCode: ev.statusCode } : {}),
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
 *  token/usage recording is preserved verbatim under streaming tool exec.
 *
 *  ADR-0200: optional idle/total stream watchdog. When the host wires a
 *  non-no-op `streamWatchdog` AND a `streamTimeoutPolicy`, the source is
 *  wrapped — otherwise we yield the source verbatim (byte-identical). The
 *  watchdog uses the loop's existing `config.signal` so an external cancel
 *  surfaces as a typed `StreamAbortError` on the next iteration. */
async function* teeUsage(
  config: AgentConfig,
  src: AsyncIterable<StreamEvent>,
  recorder: AgentRecorder | undefined,
  collector: TurnWorkMetricsCollector | undefined,
  taskSpend: { tokens: number } | undefined,
): AsyncIterable<StreamEvent> {
  const guarded =
    config.streamWatchdog !== undefined && config.streamTimeoutPolicy !== undefined
      ? config.streamWatchdog.wrap(src, config.streamTimeoutPolicy, config.signal)
      : src
  for await (const ev of guarded) {
    if (ev.type === "usage") emitUsage(config, ev, recorder, collector, taskSpend)
    if (ev.type === "llm_continuation") emitLlmContinuation(config, ev)
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
 *  declared a tool allowlist is invoked, subsequent tool calls are
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

type ResolvedTurnOverride = {
  llm: LLMPort
  budgetTokens?: number
  explicitOff: boolean
}

/** Resolve the per-turn LLM port + MANUAL effort result given the active
 *  skill's override (if any). Pure: no clock, no IO. Precedence is skill >
 *  session > default. A `model` override swaps the port to the matching
 *  `config.modelCandidates` entry by id; an unknown id (or no candidate
 *  registry) leaves `config.llm` untouched (advisory degrade — the model id
 *  alone cannot construct a port).
 *
 *  Important for ADR-0417: the return shape preserves whether the manual
 *  resolution chose an EXPLICIT "off" (`explicitOff:true`) versus simple
 *  silence (`budgetTokens` absent, `explicitOff:false`). The classifier layer
 *  may only escalate over silence/manual-positive budgets; it MUST NOT revive
 *  an explicit skill-off such as `effort: 0`. */
const resolveSkillTurnOverride = (
  config: AgentConfig,
  override: SkillTurnOverride | undefined,
): ResolvedTurnOverride => {
  const swapped =
    override?.model !== undefined
      ? config.modelCandidates?.find((c) => c.id === override.model)?.port
      : undefined
  const llm = swapped ?? config.llm
  const overrideEffort = override?.effort
  const skillHasEffortSignal = overrideEffort !== undefined
  const skillBudget = !skillHasEffortSignal
    ? undefined
    : typeof overrideEffort === "number"
      ? overrideEffort
      : effortToTokenBudget(overrideEffort)
  if (skillHasEffortSignal) {
    return skillBudget !== undefined && skillBudget > 0
      ? { llm, budgetTokens: skillBudget, explicitOff: false }
      : { llm, explicitOff: true }
  }
  const sessionLevel = config.sessionEffort?.()
  const sessionBudget = sessionLevel !== undefined ? effortToTokenBudget(sessionLevel) : undefined
  return sessionBudget !== undefined && sessionBudget > 0
    ? { llm, budgetTokens: sessionBudget, explicitOff: false }
    : { llm, explicitOff: false }
}

const applyEffortClassifierFloor = (
  resolved: ResolvedTurnOverride,
  classifier: AgentConfig["effortClassifier"],
): { llm: LLMPort; thinking?: { type: "enabled"; budget_tokens: number } } => {
  if (resolved.explicitOff) return { llm: resolved.llm }
  const classifierLevel = classifier?.currentRecommendation().level
  const classifierBudget =
    classifierLevel !== undefined ? effortToTokenBudget(classifierLevel) : undefined
  const budgetTokens = Math.max(resolved.budgetTokens ?? 0, classifierBudget ?? 0)
  return budgetTokens > 0
    ? { llm: resolved.llm, thinking: { type: "enabled", budget_tokens: budgetTokens } }
    : { llm: resolved.llm }
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
  ctx: ReturnType<typeof buildTurnContext>,
): Promise<StreamConsumeResult> => {
  // R2-B P1: destructure into the same local names the original body used so
  // every reference below stays byte-identical (config/recorder/skillGate/…).
  // R2-B P3: `classifier`/`workingState`/`toolHistory`/`onRedaction` are
  // captured by the dispatch factory (`./stream-callbacks#createStreamDispatcher`)
  // off the same `session`/`state` bundles, so they're no longer destructured
  // here — the local references were move-only, with no behavioural change.
  const { config, specs, recorder, skillGate } = session
  const { collector, toolChoiceState, onTurnTiming, taskSpend } = state
  const { messages, system } = ctx
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
  emitLlmRequest(
    config,
    finalizeTurnPolicy({
      promptPolicy: ctx.promptPolicy,
      toolChoice,
      ...(config.sessionId !== undefined ? { promptCacheKey: config.sessionId } : {}),
    }),
  )
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
  const turnLlm = applyEffortClassifierFloor(
    resolveSkillTurnOverride(config, skillGate?.activeOverride()),
    config.effortClassifier,
  )
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
          ...(config.sessionId !== undefined && config.sessionId.length > 0
            ? { promptCacheKey: config.sessionId }
            : {}),
          // Thread the loop's abort signal (user Ctrl+C / cancel) into the LLM
          // stream so an in-flight provider request aborts on cancel instead of
          // hanging the socket until completion/timeout. Same signal already
          // passed to streamingTurn + tool ctx below.
          signal: config.signal,
          turnTimingCapture,
        }),
        recorder,
        collector,
        taskSpend,
      ),
      isConcurrencySafe: (name, input) => config.registry.isConcurrencySafe(name, input),
      // T02 M1 — early-start is read-only AND concurrency-safe; a mutating
      // concurrency-safe tool is deferred so a refused turn never commits it.
      isReadOnly: (name) => config.registry.isReadOnly(name),
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
    if (isSessionApprovalRequiredError(e)) {
      samplingStatus = "error"
      throw e
    }
    // T02 H1 — a user cancel (Ctrl+C / Esc) that arrives WHILE a chunk is being
    // awaited makes the adapter's `for await` throw an abort: the SDK
    // `AbortError` is rethrown as `LLMError{kind:"aborted"}` (or a bare DOM
    // `AbortError`). The cooperative `isAborted(signal)` check only runs AFTER a
    // successful `next()`, so a throwing iterator skips it. Without this branch
    // the abort falls through to `{error}` → `decideOnStreamError` →
    // `classifyLLMError("aborted")="fatal"` → `{kind:"error"}` and the
    // intentional cancel is misreported as a runtime failure (RUNTIME_UNKNOWN),
    // poisoning metrics/triage/retry policy. Classify it as `aborted` here so
    // the turn outcome authority routes it to `interruptedCategory("user")`.
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
    // ADR-0077 Plane-B (L4 wire): stamp the final anchor and surface the
    // snapshot via the optional sink + OTel attr. The capture is shared with
    // the adapter, so `requestSentAt` reflects the actual wire POST boundary.
    turnTimingCapture.markStreamEnd()
    const timing: TurnTiming = turnTimingCapture.snapshot()
    onTurnTiming?.(timing)
    // Single close site for `run_sampling_request`. Default-OFF (no sink) ⇒
    // no-op (sentinel short-circuits both the close branch and the duration
    // math). Note: this runs AFTER `stop?.()` so the recorder's llm-span
    // close precedes the OTel span close — matching the existing recorder-
    // first convention used elsewhere in the loop. TTFT attribute derivation
    // (Cursor `setTtftMs` reject-and-skip contract) lives in
    // `loop-helpers#buildTtftAttrs`.
    endSpan(samplingSpan, samplingStatus, attrs(buildTtftAttrs(timing)))
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
): Promise<BreakerVerdict> => {
  if (!config.compaction) return { abort: false }
  // T02 M3 — proactive compaction circuit breaker is now ENFORCED at this
  // site. Before this check `maybeCompact` only fed `recordProactive(...)`
  // strikes and never consulted `breaker.check()`, so the proactive
  // `maxNoProgressProactive` cap was a dead knob: the over-threshold autocompact
  // would re-fire (and re-invoke the summarizer LLM) every turn with no
  // headroom gained. We consult the breaker FIRST; once it has tripped we skip
  // compaction entirely and route the abort through the SAME terminal outcome
  // path the reactive site uses (`runTurn` turns the returned verdict into a
  // `{kind:"error", reason}` TurnResult), instead of a side branch.
  const verdict = breaker?.check() ?? { abort: false }
  if (verdict.abort) {
    emitRecovery(config, "compact", "breaker-disabled")
    return verdict
  }
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
  // `compactIfNeeded` preCompactHook contract. See
  // `loop-helpers#buildPreCompactHook`; absent `config.hooks` ⇒ `undefined`
  // (compactIfNeeded fast-paths past the await — byte-identical legacy).
  const preCompactHook = buildPreCompactHook(config.hooks)
  // ADR-0409 wire — thread the post_compact emit + objective bridge so the
  // compaction-visibility taxonomy actually fires in production (audit R2 F1).
  // Absent hooks/objective ⇒ fields omitted ⇒ compactIfNeeded byte-identical.
  const postCompactEmit = buildPostCompactEmit(config.hooks, config.sessionId ?? "")
  const objectiveSetNextActions = config.objective
    ? (tid: string, actions: readonly string[]): void => {
        try {
          config.objective?.setNextActions(tid, actions)
        } catch (e) {
          // NO-THROW: objective wire failure must not perturb compaction — log + swallow.
          logger.warn(`loop.objectiveSetNextActions: ${errMessage(e)}`)
        }
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
      // ADR-0409 — post_compact event + Objective.setNextActions bridge.
      // Proactive site ⇒ token_budget_exceeded. threadId = config.sessionId
      // (the natural per-thread key the Objective port uses).
      ...(postCompactEmit !== undefined ? { postCompactEmit } : {}),
      ...(objectiveSetNextActions !== undefined ? { objectiveSetNextActions } : {}),
      ...(postCompactEmit !== undefined || objectiveSetNextActions !== undefined
        ? { recoveryReason: "token_budget_exceeded" as const }
        : {}),
      ...(config.sessionId !== undefined && config.sessionId.length > 0
        ? { threadId: config.sessionId }
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
    return { abort: false }
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
    const after = estimateTokens(result.messages)
    breaker?.recordProactive(before, after)
    // ADR-0324 wire — emit a typed `compaction_event` so consumers reading the
    // typed-history side channel can see the pass as a narrative event. Pure
    // observability; failure swallowed so a misconfigured emitter cannot break
    // the turn. Reactive (mid-turn / PTL-driven) compaction is a separate
    // call-site and gets its own emit in a follow-up wire.
    emitCompactionEvent(config, {
      kind: "compaction_event",
      trigger: "pre_sampling",
      reason: "context_limit",
      tokensBefore: before,
      tokensAfter: after,
      messagesRemoved: Math.max(snapshot.length - result.messages.length, 0),
      at: Date.now(),
    })
    wm.replace(result.messages)
    resetEffortClassifier(config.effortClassifier)
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
  return { abort: false }
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

/** ADR-0324 — fire the optional compaction-event emitter with NO-THROW.
 *  Absent ⇒ no-op. A thrown emitter is swallowed so an observability glitch
 *  cannot abort the turn. Called from the proactive `maybeCompact` site
 *  AFTER `wm.replace` confirms the compaction landed. */
const emitCompactionEvent = (
  config: AgentConfig,
  event: import("@/memory/typed-event").CompactionEventVariant,
): void => {
  if (config.compactionEventEmit === undefined) return
  try {
    config.compactionEventEmit(event)
  } catch {
    // Pure observability — swallow + continue.
  }
}

/** ADR-0327 — invoke the optional context-events producer with NO-THROW.
 *  Absent producer ⇒ empty array. A thrown error is swallowed and converted
 *  to an empty array so a misconfigured producer cannot break the turn —
 *  the spliced channel simply contributes nothing this turn. */
const resolveContextEventsForTurn = (
  config: AgentConfig,
): readonly import("./context-change").ContextEvent[] => {
  if (config.contextEventsForTurn === undefined) return []
  try {
    return config.contextEventsForTurn()
  } catch {
    return []
  }
}

/** ADR-0327 / ADR-0418 — invoke the optional mention-injector with NO-THROW.
 *  The runner is fed the LAST user-role text content in working memory (the
 *  model's current prompt). Empty or non-user tail ⇒ runner not called, empty
 *  array returned. A thrown / rejected runner returns to "no splice" same as
 *  absent.
 *
 *  ADR-0418: the runner is async (file / symbol mentions do I/O). We `await`
 *  the result here; the surrounding try/catch also absorbs a rejected promise. */
const resolveMentionInjectionMessages = async (
  config: AgentConfig,
  wm: WorkingMemory<Message>,
): Promise<readonly Message[]> => {
  if (config.mentionInjector === undefined) return []
  const userText = latestUserTextFromWm(wm)
  if (userText === undefined || userText.length === 0) return []
  try {
    return await config.mentionInjector(userText)
  } catch {
    return []
  }
}

/** Extract the last user-role text content from working memory. Used by the
 *  mention-injection wire (ADR-0327). Returns undefined when the tail is
 *  not a user-role text message — e.g. when the tail is a tool_result or
 *  assistant message (mid-turn states). */
const latestUserTextFromWm = (wm: WorkingMemory<Message>): string | undefined => {
  const snap = wm.snapshot()
  for (let i = snap.length - 1; i >= 0; i--) {
    const msg = snap[i]
    if (msg === undefined || msg.role !== "user") continue
    for (const block of msg.content) {
      if (block.type === "text") return block.text
    }
    return undefined
  }
  return undefined
}

const observeEffortClassifierPrompt = (
  classifier: AgentConfig["effortClassifier"],
  text: string | undefined,
): void => {
  if (classifier === undefined || text === undefined || text.length === 0) return
  try {
    classifier.onUserPrompt(text)
  } catch {
    // Advisory only — classifier faults must not perturb the loop.
  }
}

const resetEffortClassifier = (classifier: AgentConfig["effortClassifier"]): void => {
  if (classifier === undefined) return
  try {
    classifier.reset()
  } catch {
    // Advisory only — classifier faults must not perturb the loop.
  }
}

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
  // ADR-0437 follow-up — a `followup_task(interrupt:true)` aborted THIS turn's
  // in-flight work (via the subagent turn-gate's per-turn AbortController) while
  // the loop lifetime signal is NOT aborted. Distinct from `aborted` (a real
  // lifetime cancel that finishes the child): the loop PARKS on the gate, the
  // pending wake resumes it, and a FRESH turn handles the interrupting message.
  | { kind: "interrupted" }
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

/** jun-02 — derive the SOFT task-budget object forwarded into
 *  `buildTurnContext` for this turn. Present ONLY when the operator set
 *  `config.taskBudget` (via the `task-budget` knob); `spent` is the running
 *  cumulative token total accumulated in `taskSpend` by `emitUsage` across
 *  turns (absent box ⇒ 0). ORTHOGONAL to the hard breaker — this NEVER stops
 *  the run; it only feeds the advisory reminder line. Absent budget ⇒
 *  `undefined` ⇒ the field is omitted ⇒ byte-identical default-OFF. Pure. */
const resolveTaskBudgetForTurn = (
  config: AgentConfig,
  taskSpend: { tokens: number } | undefined,
): TaskBudget | undefined =>
  config.taskBudget !== undefined
    ? { tokens: config.taskBudget.tokens, spent: taskSpend?.tokens ?? 0 }
    : undefined

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
  taskSpend: { tokens: number } | undefined,
): Promise<{
  readonly ctx: ReturnType<typeof buildTurnContext>
  readonly breakerVerdict: BreakerVerdict
}> => {
  const memoryContext = await resolveMemoryContext(config, wm, recorder, citations)
  // T02 M3 — the proactive compaction breaker verdict is surfaced so `runTurn`
  // can route an enforced breaker trip through the same terminal outcome path
  // the reactive site uses, instead of a dead side branch.
  const breakerVerdict = await maybeCompact(
    config,
    staticSystemFor(config),
    wm,
    breaker,
    archive,
    turn,
  )
  // Codex absorption — memory L3: snapshot the session WorkingState on every attempt
  // so the per-turn reminder reflects mutations the tool just made earlier in
  // the same turn. Absent ⇒ block omitted, byte-identical.
  const wsSnapshot = workingState?.snapshot()
  // ADR-0327 wire — invoke optional producers BEFORE buildTurnContext so the
  // resulting events / messages ride the same call. NO-THROW: a misconfigured
  // producer must not break the turn — failures degrade to "no splice".
  const contextEvents = resolveContextEventsForTurn(config)
  const mentionMessages = await resolveMentionInjectionMessages(config, wm)
  // ADR-0346 — per-turn plugin activation. Mirrors the same parse path
  // mention-injection uses (last user-role text in wm), passes the parsed
  // mentions through `cfg.activatePlugins` (ADR-0340), and unions the
  // resolved plugin skills into the active-skills channel for this turn.
  // NO-THROW + absent activator ⇒ EMPTY ⇒ `unionActiveSkills` returns the
  // caller's `activeSkills` unchanged (byte-identical legacy).
  const pluginActivation = await resolvePluginActivationForTurn(
    config,
    latestUserTextFromWm(wm),
    `t${turn}`,
  )
  const augmentedSkills = augmentActiveSkillsWithPlugin(activeSkills, pluginActivation)
  const taskBudgetForTurn = resolveTaskBudgetForTurn(config, taskSpend)
  const ctx = buildTurnContext({
    baseMessages: [...wm.snapshot()],
    cwd: config.cwd,
    planMode: config.planMode ?? false,
    system: config.system,
    ...(config.sessionCtx !== undefined ? { sessionCtx: config.sessionCtx } : {}),
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
    // rendered reminder (byte-identical for skill-less sessions). ADR-0346:
    // when activation contributes plugin skills, `augmentedSkills` is the
    // caller-wins union; when none, it IS the caller's `activeSkills` by
    // reference so this branch is byte-identical to legacy.
    ...(augmentedSkills !== undefined ? { activeSkills: augmentedSkills } : {}),
    ...(wsSnapshot !== undefined ? { workingState: wsSnapshot } : {}),
    ...(hookPromptInjects !== undefined && hookPromptInjects.length > 0
      ? { hookPromptInjects }
      : {}),
    // ADR-0327 — three wire forwards. Each is omitted (NOT set to undefined)
    // when its source is absent so `exactOptionalPropertyTypes` stays happy
    // and the byte-identical invariant holds for legacy callers.
    ...(config.systemPromptCache !== undefined
      ? { systemPromptCache: config.systemPromptCache }
      : {}),
    ...(config.systemPromptCacheKey !== undefined
      ? { systemPromptCacheKey: config.systemPromptCacheKey }
      : {}),
    ...(contextEvents.length > 0 ? { contextChangeEvents: contextEvents } : {}),
    ...(mentionMessages.length > 0 ? { mentionInjectionMessages: mentionMessages } : {}),
    ...(taskBudgetForTurn !== undefined ? { taskBudget: taskBudgetForTurn } : {}),
  })
  // ADR-0080 — fold the IDE snapshot into the built context (no provider ⇒
  // returned unchanged, byte-identical). ADR-0078 — prepend the redaction-
  // disabled banner when opted out (enabled ⇒ unchanged).
  const finalCtx = injectRedactionBanner(config, await injectIdeContext(config, ctx))
  // Track D (runtime → REPL context wire) — observation-only capture of the
  // assembled system prompt. Default-OFF: when `onPromptAssembled` is absent
  // the entire branch is skipped, so no snapshot is constructed and the
  // assembly path is byte-identical for every non-REPL caller (RFC §1.2).
  // Best-effort like `onProgress`: a throwing observer never crashes the turn.
  emitPromptAssembled(config, finalCtx)
  return { ctx: finalCtx, breakerVerdict }
}

/** Track D — fire `config.onPromptAssembled` with a snapshot of the assembled
 *  system prompt. Pure side-effect, observation-only. Absent hook ⇒ early
 *  return (no allocation, byte-identical). The snapshot pairs the assembled
 *  `SystemBlock[]` with the turn's `promptPolicy` presence flags so the REPL
 *  can reconstruct per-section names; `max` is left 0 (the loop has no model→
 *  context-window table — the surface degrades the bar's denominator). */
const emitPromptAssembled = (
  config: AgentConfig,
  ctx: ReturnType<typeof buildTurnContext>,
): void => {
  const hook = config.onPromptAssembled
  if (hook === undefined) return
  try {
    const policy = ctx.promptPolicy
    hook({
      system: ctx.system,
      layout: policy.systemLayout,
      repoRulesPresent: policy.repoRulesPresent,
      sessionCtxPresent: policy.sessionCtxPresent,
      userAppendPresent: policy.userAppendPresent,
      max: 0,
      model: configuredModel(config.llm),
    })
  } catch (e) {
    config.stream.emit({
      type: "error",
      message: `onPromptAssembled observer threw: ${e instanceof Error ? e.message : String(e)}`,
    })
  }
}

type Step = { done: false } | { done: true; result: TurnResult }
const CONTINUE: Step = { done: false }

const applyNonSuccessRecoveryAction = async (
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
    // T02 M2 — a refusal turn skips the deferred tool dispatch phase, so any
    // `tool_use` blocks queued mid-stream never produced a `tool_result`.
    // Persisting them yields an invalid transcript (provider 400 on
    // resume/fork/replay). Seal the assistant message through the closeout
    // authority's `stripOrphanToolUse` before it lands in working memory; the
    // visible refusal text is preserved.
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
  const before = estimateTokens(snapshot)
  const compacted = await reactiveCompact({
    messages: snapshot,
    llm: config.compaction?.summarizerLlm ?? config.llm,
    system: ctxSystem,
  })
  if (!compacted.ok) return { done: true, result: { kind: "error", reason: compacted.reason } }
  const after = estimateTokens(compacted.messages)
  breaker?.recordReactive(before, after)
  // ADR-0331 wire — reactive (PTL-driven, mid-turn) compaction site emit,
  // parallel to the proactive site (ADR-0324, see `maybeCompact`). Fires AFTER
  // the breaker observation so a throwing emitter cannot stall the breaker
  // and BEFORE `wm.replace` so the call order matches the proactive site
  // (byte-identical when slot absent: `emitCompactionEvent` returns immediately
  // and the only added work is the constant-time `after` hoist that already
  // mirrors the proactive recompute). `trigger:"mid_turn"` distinguishes this
  // pass from the proactive `"pre_sampling"`; `reason:"context_limit"` is the
  // sole driver of reactive compaction today — the recovery action `"compact"`
  // is only produced by a PTL (prompt-too-long) verdict in the router, which
  // IS a context-limit signal by construction. Adding new reasons (e.g.
  // `"token_budget"` for a budget-driven mid-turn squeeze) requires its own
  // ADR (closed-set, ADR-0324). `messagesRemoved` is clamped non-negative; a
  // future `compacted.messages.length > snapshot.length` (synthetic header
  // longer than the prefix it summarized) cannot underflow the contract.
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
  resetEffortClassifier(config.effortClassifier)
  // ADR-0409 wire — fire the post_compact emit + Objective bridge at the
  // REACTIVE site too. The proactive site uses `compactIfNeeded`'s
  // `postCompactEmit` path; reactiveCompact doesn't accept the callback, so
  // we emit inline here. `reason:"ptl_reactive"` distinguishes mid-turn PTL
  // recovery from the proactive token-budget trigger. Subscriber-less +
  // objective-absent ⇒ no-op (byte-identical). NO-THROW.
  try {
    const provenance: import("@/agent/recovery-reason").RecoveryProvenance = {
      reason: "ptl_reactive",
      tokensBefore: before,
      tokensAfter: after,
      turnsDropped: Math.max(snapshot.length - compacted.messages.length, 0),
      turnsKept: compacted.messages.length,
      compactedAt: Date.now(),
    }
    const threadId = config.sessionId ?? ""
    await config.hooks?.emit({ type: "post_compact", threadId, provenance })
    if (config.objective !== undefined && threadId.length > 0) {
      config.objective.setNextActions(threadId, [
        "Resuming after mid-turn compaction (PTL recovery)",
      ])
    }
  } catch {
    // NO-THROW: post-compact emit/bridge failure must not abort the turn.
  }
  return CONTINUE
}

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
  const { wm, toolChoiceState } = state
  const nonSuccessStep = await applyNonSuccessRecoveryAction(
    session,
    state,
    action,
    result,
    ctxSystem,
  )
  if (nonSuccessStep !== null) return nonSuccessStep
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

/** ADR-0242 — single-call seam for the per-turn `RecoveryAction`. Consults
 *  the Cursor stop-reason policy (when wired) BEFORE the legacy
 *  `decideOnStreamError` / `decideOnAssembled` FSM; a non-`continue`
 *  policy decision short-circuits the turn. The wire is extracted out of
 *  `runTurn` so the loop body stays under the biome cognitive-complexity
 *  budget (the seam itself is two branches + one nullish-coalesce). */
const resolveTurnAction = (
  policy: import("./stop-reason").StopReasonPolicy | undefined,
  result: StreamSuccess | { error: unknown; message: string },
  rec: import("./recovery").RecoveryState,
): RecoveryAction => {
  if ("error" in result) return decideOnStreamError(result.error, result.message, rec)
  const override = decideFromStopPolicy(policy, result.stopReason)
  return override ?? decideOnAssembled(result.stopReason, result.message, rec)
}

/**
 * ADR-0437 follow-up — build the per-turn session view used for interrupt.
 *
 * When a subagent turn-gate is wired, arm a FRESH per-turn interrupt controller
 * and return a session view whose `config.signal` is the EFFECTIVE signal (loop
 * lifetime OR this turn's interrupt). `followup_task(interrupt:true)` on a busy
 * child aborts that controller ⇒ the in-flight stream/tool unwinds (the SAME
 * AbortController→signal→stream/tool mechanism `task_stop` uses — no parallel
 * abort path). Absent gate ⇒ returns the SAME session by identity (NO clone, NO
 * `AbortSignal.any`) ⇒ byte-identical default-OFF path.
 */
const buildTurnSessionView = (
  session: TurnSession,
): {
  readonly turnSession: TurnSession
  readonly gate: import("@/subagent").SubagentTurnGate | undefined
} => {
  const gate = session.config.subagentTurnGate
  if (gate === undefined) return { turnSession: session, gate: undefined }
  const config = { ...session.config, signal: gate.armTurn(session.config.signal) }
  return { turnSession: { ...session, config }, gate }
}

/**
 * ADR-0437 follow-up — classify a turn-body abort. An abort is an INTERRUPT
 * (`{kind:"interrupted"}` ⇒ park + fresh turn) ONLY when the gate's per-turn
 * controller fired AND the lifetime signal did NOT; otherwise it is a genuine
 * lifetime cancel (`{kind:"aborted"}` ⇒ finish). The lifetime check reads the
 * ORIGINAL `loopSignal` (not the effective one) so an interrupt can never
 * masquerade as a finish. No gate ⇒ always `aborted` (byte-identical).
 */
const classifyTurnAbort = (
  gate: import("@/subagent").SubagentTurnGate | undefined,
  loopSignal: AbortSignal,
): TurnResult =>
  gate?.wasInterrupted() === true && !loopSignal.aborted
    ? { kind: "interrupted" }
    : { kind: "aborted" }

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
  // ADR-0437 follow-up — the per-turn session view (effective interrupt signal).
  // No gate ⇒ `turnSession === session`, `gate === undefined` (byte-identical).
  const { turnSession, gate } = buildTurnSessionView(session)
  const turnConfig = turnSession.config
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
    // ADR-0437 follow-up — `classifyTurnAbort` distinguishes a real lifetime
    // cancel (`config.signal`) from a turn-gate interrupt (only the per-turn
    // controller fired). The lifetime check uses the ORIGINAL `config.signal`
    // (not the effective one) so an interrupt never masquerades as a finish.
    if (config.signal.aborted || gate?.wasInterrupted() === true) {
      return classifyTurnAbort(gate, config.signal)
    }

    // Rebuilt every attempt: ctx.messages = canonical history + one ephemeral
    // reminder tail (the per-turn dynamic context, never persisted).
    const { ctx, breakerVerdict } = await prepareTurnContext(
      turnConfig,
      wm,
      recorder,
      breaker,
      activeSkills,
      workingState,
      archive,
      turn,
      citations,
      turnInjects,
      state.taskSpend,
    )
    // T02 M3 — an ENFORCED proactive compaction breaker trip ends the turn
    // through the same terminal `{kind:"error"}` route the reactive breaker
    // uses (see `applyNonSuccessRecoveryAction`), not a side branch. The
    // recovery event was already emitted at the `maybeCompact` site.
    if (breakerVerdict.abort) return { kind: "error", reason: breakerVerdict.reason }
    const result = await streamConsume(turnSession, state, ctx)
    // An abort is an interrupt (park + fresh turn) when the gate's per-turn
    // controller fired AND the lifetime signal did not; else a genuine lifetime
    // cancel (finish). See `classifyTurnAbort`.
    if ("aborted" in result) return classifyTurnAbort(gate, config.signal)

    // ADR-0242 — Cursor 8-arm stop_reason typed router. `resolveTurnAction`
    // consults `config.stopReasonPolicy` first (when wired) and falls through
    // to the legacy `decideOnStreamError` / `decideOnAssembled` FSM otherwise.
    // Absent ⇒ single optional-chain check on undefined, zero allocation,
    // byte-identical to the pre-ADR path.
    const action = resolveTurnAction(turnConfig.stopReasonPolicy, result, rec)

    const step = await applyAction(
      turnSession,
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
 * S5 hook hardening — emit `user_prompt_submit` ONCE at session start, when
 * the seeded buffer ends in a user message (the common path: the surface
 * appended a fresh prompt before calling runAgent). Honored response
 * channels:
 *   - `deny` ⇒ returns the deny reason; the caller short-circuits into
 *     aborted (the surface observes `AgentOutcome.reason === "aborted"` +
 *     a `stopCategory.origin === "user"` — same category the existing
 *     submission-interrupt path produces).
 *   - `updatedPrompt` (string) ⇒ rewrites the trailing user message's FIRST
 *     text block in place (the LLM sees only the rewritten text).
 *
 * No emission when there is no trailing user message (resume-without-new-
 * prompt) or when no bus is wired (caller guards that). Returns `null` to
 * proceed, or the deny reason string when a hook blocked the run.
 *
 * Extracted to keep `runAgentInner` under the biome cognitive-complexity
 * budget.
 */
const emitUserPromptSubmitHook = async (
  cfg: AgentConfig,
  wm: WorkingMemory<Message>,
  sessionId: string,
): Promise<string | null> => {
  if (cfg.hooks === undefined) return null
  const lastUserIdx = findTrailingUserMessageIndex(wm)
  if (lastUserIdx < 0) return null
  const userMsg = wm.messages[lastUserIdx]
  if (userMsg === undefined) return null
  const { promptText, attachmentsCount } = summarizeUserPrompt(userMsg)
  const emit = (await cfg.hooks.emit({
    type: "user_prompt_submit",
    prompt: promptText,
    attachmentsCount,
    threadId: sessionId,
  })) ?? { deny: null }
  if (emit.deny !== null) {
    return emit.deny.deny
  }
  // updatedPrompt rewrites the FIRST text block in place. We do NOT touch
  // attachments (an image queued for this turn is preserved verbatim).
  if (typeof emit.updatedPrompt === "string") {
    rewriteUserPromptMessage(wm, lastUserIdx, userMsg, emit.updatedPrompt)
  }
  return null
}

const findTrailingUserMessageIndex = (wm: WorkingMemory<Message>): number => {
  for (let i = wm.messages.length - 1; i >= 0; i--) {
    const message = wm.messages[i]
    if (message?.role === "user") return i
  }
  return -1
}

const summarizeUserPrompt = (
  userMsg: Message,
): { readonly promptText: string; readonly attachmentsCount: number } => {
  let promptText = ""
  let attachmentsCount = 0
  for (const block of userMsg.content) {
    if (block.type === "text") {
      promptText = promptText.length > 0 ? `${promptText}\n${block.text}` : block.text
    } else {
      attachmentsCount += 1
    }
  }
  return { promptText, attachmentsCount }
}

const rewriteUserPromptMessage = (
  wm: WorkingMemory<Message>,
  lastUserIdx: number,
  userMsg: Message,
  newText: string,
): void => {
  let rewritten = false
  const newContent = userMsg.content.map((block) => {
    if (!rewritten && block.type === "text") {
      rewritten = true
      return { ...block, text: newText }
    }
    return block
  })
  if (!rewritten) newContent.unshift({ type: "text", text: newText })
  wm.messages[lastUserIdx] = { ...userMsg, content: newContent }
}

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
    // The queue owns restore semantics now (cap, id continuity, legacy
    // version handling). Keep the caller's queue reference, but delegate the
    // state replacement to the queue instead of replaying entries manually.
    cfg.followUpQueue.restoreFromSnapshot(snap)
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

const approvedPlanReminder = (plan: string): HookPromptInject => ({
  injectAfterSystem:
    "Approved plan is now executable. Treat this plan as read-only context for the next turn:\n\n" +
    plan,
})

const requestedChangesReminder = (feedback: string): HookPromptInject => ({
  injectAfterSystem:
    "Operator feedback on the active plan:\n" +
    feedback +
    "\n\nRevise the plan, keep plan mode active, and request exit again only after updating the plan.",
})

const applyPendingPlanExit = (
  cfg: AgentConfig,
  pending: PendingPlanExit | null,
  hookPromptPending: HookPromptInject[],
): void => {
  if (pending === null) return
  if (pending.outcome.decision === "approved") {
    const from = resolveCollaborationMode(cfg)
    cfg.planMode = false
    cfg.mode = "default"
    cfg.collaborationMode = "default"
    hookPromptPending.push(approvedPlanReminder(pending.plan))
    if (cfg.planStore !== undefined) {
      const lifecycle = applyPlanExitOutcome(pending.outcome, cfg.planStore)
      if (lifecycle.kind === "freeze" && lifecycle.snapshot !== null) {
        cfg.stream.emit({
          type: "plan_snapshot",
          plan: planToStreamMirror(lifecycle.snapshot.plan),
        })
      }
    }
    if (from !== "default") {
      cfg.stream.emit({
        type: "mode_changed",
        from,
        to: "default",
        reason: "plan_exit_approved",
      })
    }
    return
  }
  if (pending.outcome.decision === "rejected") {
    cfg.planStore?.clear()
    return
  }
  if (cfg.planStore !== undefined) {
    applyPlanExitOutcome(pending.outcome, cfg.planStore)
  }
  hookPromptPending.push(requestedChangesReminder(pending.outcome.feedback ?? "(no feedback)"))
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

const persistFinalMessages = async (args: {
  readonly cfg: AgentConfig
  readonly recorder: AgentRecorder | undefined
  readonly redactionEnabled: boolean
  readonly recordRedaction: (
    origin: import("@/security").RedactionOrigin,
    hits: readonly import("@/security").RedactionHit[],
  ) => void
  readonly sessionId: string
  readonly messages: readonly Message[]
  readonly reason: StopReason
}): Promise<void> => {
  if (args.redactionEnabled && args.cfg.store) {
    scanEnvelopeForRedactions(args.messages, args.recordRedaction)
  }
  if (!args.cfg.store) return
  await persistSession(
    buildPersistDeps(args.cfg, args.recorder, args.redactionEnabled, args.recordRedaction),
    {
      sessionId: args.sessionId,
      finalMessages: [...args.messages],
    },
  )
}

const cleanupFinishedSession = async (args: {
  readonly cfg: AgentConfig
  readonly features: Awaited<ReturnType<typeof buildSessionFeatures>>
}): Promise<void> => {
  try {
    await args.features.cleanup?.()
  } catch (e) {
    const message = errMessage(e)
    args.cfg.stream.emit({ type: "error", message: `subagent cleanup failed: ${message}` })
  }
  try {
    // ADR-0427 — close the headless browser (kill proc + remove temp profile).
    await args.features.browserDispose?.()
  } catch (e) {
    args.cfg.stream.emit({ type: "error", message: `browser dispose failed: ${errMessage(e)}` })
  }
  await saveFollowUpQueueSnapshot(args.cfg)
  await savePlanSnapshot(args.cfg)
}

const buildFinalAgentOutcome = (args: {
  readonly reason: StopReason
  readonly turns: number
  readonly messages: readonly Message[]
  readonly stopCategory?: StopCategory
  readonly memoryCitations: readonly MemoryCitation[]
  readonly redactionAgg: ReadonlyMap<string, import("./types").RedactionRollup>
  readonly refusal?: { readonly rationale: string }
  readonly lastTurnTiming: TurnTiming | null
}): AgentOutcome => {
  const redactions = args.redactionAgg.size > 0 ? [...args.redactionAgg.values()] : undefined
  return {
    reason: args.reason,
    turns: args.turns,
    messages: [...args.messages],
    ...(args.stopCategory !== undefined ? { stopCategory: args.stopCategory } : {}),
    ...(args.memoryCitations.length > 0 ? { memoryCitations: args.memoryCitations } : {}),
    ...(redactions !== undefined ? { redactions } : {}),
    ...(args.refusal !== undefined ? { refusal: args.refusal } : {}),
    ...(args.lastTurnTiming !== null ? { turnTiming: args.lastTurnTiming } : {}),
  }
}

const finishAgentSession = async (args: {
  readonly cfg: AgentConfig
  readonly wm: WorkingMemory<Message>
  readonly sessionId: string
  readonly recorder: AgentRecorder | undefined
  readonly redactionEnabled: boolean
  readonly recordRedaction: (
    origin: import("@/security").RedactionOrigin,
    hits: readonly import("@/security").RedactionHit[],
  ) => void
  readonly features: Awaited<ReturnType<typeof buildSessionFeatures>>
  readonly memoryCitations: readonly MemoryCitation[]
  readonly redactionAgg: ReadonlyMap<string, import("./types").RedactionRollup>
  readonly lastTurnTiming: TurnTiming | null
  readonly reason: StopReason
  readonly turns: number
  readonly stopCategory?: StopCategory
  readonly refusal?: { readonly rationale: string }
}): Promise<AgentOutcome> => {
  if (args.cfg.activeTurnRef) {
    args.cfg.activeTurnRef.current = {
      currentTurn: null,
      isInterrupted: args.reason === "aborted",
    }
  }
  const messages = [...args.wm.snapshot()]
  await persistFinalMessages({
    cfg: args.cfg,
    recorder: args.recorder,
    redactionEnabled: args.redactionEnabled,
    recordRedaction: args.recordRedaction,
    sessionId: args.sessionId,
    messages,
    reason: args.reason,
  })
  await cleanupFinishedSession({ cfg: args.cfg, features: args.features })
  args.recorder?.stopReason(args.reason)
  if (args.cfg.hooks)
    await args.cfg.hooks.emit({ type: "session_end", reason: args.reason, turns: args.turns })
  args.cfg.stream.emit({ type: "done", reason: args.reason, turns: args.turns })
  return buildFinalAgentOutcome({
    reason: args.reason,
    turns: args.turns,
    messages,
    memoryCitations: args.memoryCitations,
    redactionAgg: args.redactionAgg,
    lastTurnTiming: args.lastTurnTiming,
    ...(args.stopCategory !== undefined ? { stopCategory: args.stopCategory } : {}),
    ...(args.refusal !== undefined ? { refusal: args.refusal } : {}),
  })
}

const runSessionStartSequence = async (args: {
  readonly cfg: AgentConfig
  readonly wm: WorkingMemory<Message>
  readonly sessionId: string
  readonly taskRegistry: { forceStop(id: string): boolean } | undefined
}): Promise<"continue" | "aborted"> => {
  args.cfg.stream.emit({ type: "session_start" })
  if (args.cfg.hooks)
    await args.cfg.hooks.emit({ type: "session_start", sessionId: args.sessionId })
  if (args.cfg.hooks !== undefined) {
    const denied = await emitUserPromptSubmitHook(args.cfg, args.wm, args.sessionId)
    if (denied !== null) return "aborted"
  }
  observeEffortClassifierPrompt(args.cfg.effortClassifier, latestUserTextFromWm(args.wm))
  await restoreFollowUpQueueSnapshot(args.cfg)
  await restorePlanSnapshot(args.cfg)
  return handleSubmissionControlOp(args.cfg, args.taskRegistry) === "aborted"
    ? "aborted"
    : "continue"
}

const applySteerBarrierMessages = async (
  cfg: AgentConfig,
  wm: WorkingMemory<Message>,
): Promise<void> => {
  if (!cfg.steerBarrier) return
  const beforeLen = cfg.messages.length
  await cfg.steerBarrier()
  for (let i = beforeLen; i < cfg.messages.length; i++) {
    const injected = cfg.messages[i]
    if (injected) wm.append(injected)
  }
}

const setActiveTurnHeader = (cfg: AgentConfig, sessionId: string): void => {
  if (!cfg.activeTurnRef) return
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

const syncQueuedTurnInputs = async (args: {
  readonly cfg: AgentConfig
  readonly wm: WorkingMemory<Message>
  readonly sessionId: string
  readonly taskRegistry: { forceStop(id: string): boolean } | undefined
}): Promise<"continue" | "aborted"> => {
  const followUpResult = pollFollowUpQueue(args.cfg, args.sessionId)
  if (followUpResult !== null) args.wm.append(followUpResult)
  const actionOutcome = await pollConversationAction(args.cfg, args.taskRegistry)
  if (actionOutcome.kind === "finish_aborted") return "aborted"
  if (actionOutcome.kind === "injection") {
    args.wm.append(actionOutcome.message)
    observeEffortClassifierPrompt(args.cfg.effortClassifier, latestUserTextFromWm(args.wm))
  }
  return "continue"
}

const injectFocusChainMessage = (cfg: AgentConfig, wm: WorkingMemory<Message>): void => {
  if (cfg.focusChain === undefined) return
  try {
    cfg.focusChain.tracker.tickTurn()
    const injection = cfg.focusChain.tracker.getInjection()
    if (injection !== null && injection.trim().length > 0) {
      wm.append({
        role: "user",
        content: [{ type: "text", text: injection }],
      })
    }
  } catch (e) {
    cfg.stream.emit({
      type: "error",
      message: `focus-chain inject failed: ${errMessage(e)}`,
    })
  }
}

const prepareTurnIteration = async (args: {
  readonly cfg: AgentConfig
  readonly wm: WorkingMemory<Message>
  readonly sessionId: string
  readonly taskRegistry: { forceStop(id: string): boolean } | undefined
  readonly turn: number
  readonly localizePhaseState: import("./localize-phase-guard").LocalizePhaseState | undefined
  readonly dedupGate: unknown
  readonly shellSnapshotSession: ShellSnapshotSession | undefined
  readonly hookPromptPending: import("./hooks").HookPromptInject[]
}): Promise<"continue" | "aborted"> => {
  if (args.cfg.signal.aborted) return "aborted"
  if (args.localizePhaseState !== undefined) args.localizePhaseState.turn = args.turn - 1
  args.cfg.budgetMeter?.tick("turn")
  await applySteerBarrierMessages(args.cfg, args.wm)
  setActiveTurnHeader(args.cfg, args.sessionId)
  const queuedInputs = await syncQueuedTurnInputs(args)
  if (queuedInputs === "aborted") return "aborted"
  injectFocusChainMessage(args.cfg, args.wm)
  if (args.dedupGate) {
    const stamped = stampTurn(args.cfg.run, args.turn)
    args.cfg.run = stamped ?? { runId: args.sessionId, turn: args.turn }
  }
  if (args.shellSnapshotSession !== undefined) {
    await args.shellSnapshotSession.snapshotForTurn(args.turn)
  }
  args.cfg.stream.emit({ type: "turn_start", turn: args.turn })
  if (args.cfg.hooks) {
    const turnStart = await args.cfg.hooks.emit({ type: "turn_start", turn: args.turn })
    if (turnStart.promptHook !== undefined) args.hookPromptPending.push(turnStart.promptHook)
  }
  return "continue"
}

type TurnLoopResolution =
  | { readonly kind: "continue" }
  // ADR-0437 follow-up — the turn was INTERRUPTED by a `followup_task(interrupt)`
  // (the gate's per-turn controller fired, the lifetime signal did not). The
  // turn loop must PARK on the gate so the pending interrupt-wake resumes the
  // loop into a fresh turn that handles the interrupting message — NOT finish.
  | { readonly kind: "park"; readonly turns: number }
  | {
      readonly kind: "finish"
      readonly reason: StopReason
      readonly turns: number
      readonly stopCategory?: StopCategory
      readonly refusal?: { readonly rationale: string }
    }

type FinishAgentSession = (
  reason: StopReason,
  turns: number,
  stopCategory?: StopCategory,
  refusal?: { readonly rationale: string },
) => Promise<AgentOutcome>

type RunAgentTurnStateSeed = Omit<TurnState, "rec" | "collector">

interface RunAgentContext {
  readonly features: Awaited<ReturnType<typeof buildSessionFeatures>>
  readonly cfg: AgentConfig
  readonly wm: WorkingMemory<Message>
  readonly sessionId: string
  readonly recorder: AgentRecorder | undefined
  readonly breaker: CompactionBreaker | undefined
  readonly localizePhaseState: import("./localize-phase-guard").LocalizePhaseState | undefined
  readonly dedupGate: unknown
  readonly hookPromptPending: HookPromptInject[]
  readonly pendingPlanExitRef: { current: PendingPlanExit | null }
  readonly shellSnapshotSession: ShellSnapshotSession | undefined
  readonly turnDiffSession: TurnDiffSession | undefined
  readonly gitDirectiveCollector: ReturnType<typeof buildGitDirectiveEmit> | undefined
  readonly session: TurnSession
  readonly turnStateSeed: RunAgentTurnStateSeed
  readonly finish: FinishAgentSession
}

const resolveTurnLoopOutcome = async (args: {
  readonly cfg: AgentConfig
  readonly stream: AgentConfig["stream"]
  readonly wm: WorkingMemory<Message>
  readonly breaker: CompactionBreaker | undefined
  readonly recorder: AgentRecorder | undefined
  readonly turn: number
  readonly result: TurnResult
  readonly pendingPlanExitRef: { current: PendingPlanExit | null }
  readonly hookPromptPending: import("./hooks").HookPromptInject[]
}): Promise<TurnLoopResolution> => {
  if (args.result.kind === "aborted") {
    return {
      kind: "finish",
      reason: "aborted",
      turns: args.turn - 1,
      stopCategory: interruptedCategory("user"),
    }
  }
  // ADR-0437 follow-up — an interrupted turn parks on the gate (it does NOT
  // finish). `turns: args.turn - 1` because the interrupted turn produced no
  // completed work — the FRESH turn that handles the interrupting message
  // re-uses this turn's slot via the gate `resume` (consistent with the
  // aborted-turn `turn - 1` accounting).
  if (args.result.kind === "interrupted") {
    return { kind: "park", turns: args.turn - 1 }
  }
  if (args.result.kind === "error") {
    args.stream.emit({ type: "error", message: args.result.reason })
    return {
      kind: "finish",
      reason: "error",
      turns: args.turn - 1,
      stopCategory: classifyErrorReason(args.result.reason),
    }
  }
  if (args.result.kind === "refusal") {
    args.recorder?.turn()
    return {
      kind: "finish",
      reason: "refusal",
      turns: args.turn,
      stopCategory: refusalCategory(),
      refusal: { rationale: args.result.rationale },
    }
  }
  args.recorder?.turn()
  const exhausted = args.cfg.budgetMeter?.checkExhausted()
  if (exhausted?.exhausted) {
    // T02 H2 — when the budget trips at the END of a tool-producing turn, the
    // assistant message (carrying the `tool_use` blocks) is already in working
    // memory but the matching `tool_result` blocks have NOT been appended yet
    // (that normally happens on the continue path below, line ~`wm.append`).
    // Terminating here without sealing leaves the transcript ending on an
    // unmatched `tool_use` → provider 400 on resume/fork. Seal it through the
    // closeout authority before the terminal finish.
    if (args.result.kind === "tools") {
      appendPendingToolResults(args.wm, args.result.resultBlocks)
    }
    emitBudgetExhaustedDecision(args.cfg.decisionEmitter, exhausted, { turn: args.turn })
    return {
      kind: "finish",
      reason: "budget_exhausted",
      turns: args.turn,
      stopCategory: completedCategory("max_turns"),
    }
  }
  if (args.result.kind === "completed") {
    return {
      kind: "finish",
      reason: "completed",
      turns: args.turn,
      stopCategory: completedCategory("normal"),
    }
  }
  args.breaker?.noteProgress()
  args.wm.append({ role: "user", content: args.result.resultBlocks })
  if (args.pendingPlanExitRef.current !== null) {
    applyPendingPlanExit(args.cfg, args.pendingPlanExitRef.current, args.hookPromptPending)
    args.pendingPlanExitRef.current = null
  }
  return { kind: "continue" }
}

/**
 * ADR-0328 image sanitization retry wire — when `cfg.imageSanitizationRetry`
 * is enabled, wrap `cfg.llm` so an Anthropic `invalid_image` 400 triggers a
 * single-pass last-turn image scrub + re-stream (Codex
 * `replace_last_turn_images → continue` parity). Default-OFF (absent or
 * `enabled !== true`) ⇒ returns `cfg.llm` verbatim, byte-identical to the
 * pre-ADR path. `cfg` MUST already be a per-run clone (see the
 * `baseCfg === config` guard in `createRunAgentContext`) — the caller mutates
 * `cfg.llm` with the return value and that mutation must not leak.
 */
const maybeWrapImageSanitizationRetry = (cfg: AgentConfig, wm: WorkingMemory<Message>): LLMPort => {
  if (cfg.imageSanitizationRetry?.enabled !== true) return cfg.llm
  const port = createWorkingMemoryHistorySanitization(wm)
  const wrapOpts = {
    ...(cfg.imageSanitizationRetry.maxAttempts !== undefined
      ? { maxAttempts: cfg.imageSanitizationRetry.maxAttempts }
      : {}),
    ...(cfg.imageSanitizationRetry.placeholder !== undefined
      ? { placeholder: cfg.imageSanitizationRetry.placeholder }
      : {}),
  }
  return withImageSanitizationRetry(cfg.llm, port, wrapOpts)
}

const createRunAgentContext = async (config: AgentConfig): Promise<RunAgentContext> => {
  const features = await buildSessionFeatures(config)
  const baseCfg = buildEffectiveConfig(config, features.extraTools)
  // `cfg` is mutated below (onPlanExitOutcome, shellSnapshotSession, llm wrap,
  // attachDedupGate, attachCapEnforcer, attachLocalizePhase, wireHookPromptPending).
  // `buildEffectiveConfig` returns the SAME reference as `config` when there are
  // no extra tools (see `buildEffectiveConfig` impl), so without an unconditional
  // shallow clone those mutations would leak to the caller. The previous
  // `dedupGateActive && baseCfg === config` gate left the no-dedup / no-extra-tools
  // path leaking — ADR-0328 §Wire documents this as the ownership concern that
  // was blocking the `cfg.llm` wrap. Clone whenever we share a reference with
  // the caller; when `buildEffectiveConfig` already minted a fresh object,
  // re-cloning is unnecessary.
  const cfg: AgentConfig = baseCfg === config ? { ...baseCfg } : baseCfg
  const pendingPlanExitRef: { current: PendingPlanExit | null } = { current: null }
  const onPlanExitOutcome = cfg.onPlanExitOutcome
  cfg.onPlanExitOutcome = (event) => {
    pendingPlanExitRef.current = event
    onPlanExitOutcome?.(event)
  }

  const skillGate = buildSkillGate(features.skillAllowlists, features.skillOverrides)
  const wm: WorkingMemory<Message> = createWorkingMemory<Message>(buildSeedMessages(cfg))
  cfg.llm = maybeWrapImageSanitizationRetry(cfg, wm)
  const recorder = cfg.metrics ? new AgentRecorder(cfg.metrics) : undefined
  const sessionId = cfg.sessionId ?? "default"
  const breaker = cfg.compactionBreaker?.disabled
    ? undefined
    : new CompactionBreaker(cfg.compactionBreaker?.caps)
  const dedupGate = attachDedupGate(cfg)
  const { state: verifyGuardState, history: toolHistory } = buildVerifyGuard(cfg)
  const closeoutGuardState = buildCloseoutGuard(cfg)
  attachCapEnforcer(cfg)
  const localizePhaseState = attachLocalizePhase(cfg)
  const guardChain = buildGuardChain({
    config: cfg,
    verifyGuardState,
    closeoutGuardState,
  })
  const toolChoiceState = createToolChoiceTurnState()
  const hookPromptPending = wireHookPromptPending(cfg)
  const memoryCitations: MemoryCitation[] = []
  const redactionEnabled = normalizeRedactionConfig(cfg.redaction).enabled
  const { agg: redactionAgg, record: recordRedaction } = createRedactionRollup()
  const summaryArchive: ConversationSummaryArchive | undefined =
    cfg.compaction?.archive === true ? createArchive() : undefined
  let lastTurnTiming: TurnTiming | null = null
  const recordTurnTiming = (timing: TurnTiming): void => {
    lastTurnTiming = timing
  }
  const turnDiffSession = buildTurnDiffSession(cfg)
  const gitDirectiveCollector = buildGitDirectiveEmit(cfg)
  const shellSnapshotSession: ShellSnapshotSession | undefined = buildShellSnapshotSession(
    cfg,
    (message) => cfg.stream.emit({ type: "error", message }),
    cfg.shellSnapshot?.shellEnv,
  )
  if (shellSnapshotSession !== undefined) {
    await shellSnapshotSession.pruneOnStart()
    cfg.shellSnapshotSession = shellSnapshotSession
  }

  const session: TurnSession = {
    config: cfg,
    specs: cfg.registry.specs(),
    ...(recorder !== undefined ? { recorder } : {}),
    ...(features.classifier !== undefined ? { classifier: features.classifier } : {}),
    ...(skillGate !== undefined ? { skillGate } : {}),
    ...(features.activeSkills !== undefined ? { activeSkills: features.activeSkills } : {}),
    ...(summaryArchive !== undefined ? { archive: summaryArchive } : {}),
    guards: guardChain,
    hookPromptPending,
  }

  const turnStateSeed: RunAgentTurnStateSeed = {
    wm,
    breaker,
    toolHistory,
    workingState: features.workingState,
    toolChoiceState,
    citations: memoryCitations,
    onRedaction: recordRedaction,
    onTurnTiming: recordTurnTiming,
    // jun-02 — soft task-budget cumulative spend box. Allocated ONCE per
    // session (spread into every turn's TurnState) so `spent` accumulates
    // across turns. Present ONLY when the operator set a budget; absent ⇒
    // field omitted ⇒ no accumulation, byte-identical default-OFF.
    ...(cfg.taskBudget !== undefined ? { taskSpend: { tokens: 0 } } : {}),
  }

  const finish: FinishAgentSession = async (reason, turns, stopCategory, refusal) =>
    await finishAgentSession({
      cfg,
      wm,
      sessionId,
      recorder,
      redactionEnabled,
      recordRedaction,
      features,
      memoryCitations,
      redactionAgg,
      lastTurnTiming,
      reason,
      turns,
      ...(stopCategory !== undefined ? { stopCategory } : {}),
      ...(refusal !== undefined ? { refusal } : {}),
    })

  return {
    features,
    cfg,
    wm,
    sessionId,
    recorder,
    breaker,
    localizePhaseState,
    dedupGate,
    hookPromptPending,
    pendingPlanExitRef,
    shellSnapshotSession,
    turnDiffSession,
    gitDirectiveCollector,
    session,
    turnStateSeed,
    finish,
  }
}

const executeTurnWithObservability = async (args: {
  readonly ctx: RunAgentContext
  readonly turn: number
}): Promise<{ readonly result: TurnResult }> => {
  const { collector: workCollector, turnId: workTurnId } = buildWorkMetricsResources(args.ctx.cfg)
  const turnId = args.ctx.cfg.activeTurnRef?.current.currentTurn?.turnId ?? crypto.randomUUID()
  const turnSpan: Span = startSpan(SPAN_NAMES.turn, turnSpanAttrs(turnId))
  let turnSpanStatus: "ok" | "error" | "aborted" = "ok"
  // T02 M5 — `resultKind` drives the closeout observability flush. When
  // `runTurn` THROWS (HITL approval pause / any non-LLMError escape) it never
  // resolves a `TurnResult`, so the flush must still run with a defined kind.
  // "error" is the conservative classification for an escaping throw (the host
  // re-raises it as an approval placeholder above the loop); the work-metrics
  // gate only suppresses "aborted", so "error" still emits the turn's metrics.
  let flushKind: "tools" | "completed" | "aborted" | "interrupted" | "error" | "refusal" = "error"
  let result: TurnResult
  try {
    if (args.ctx.turnDiffSession !== undefined) {
      await args.ctx.turnDiffSession.startTurn(args.turn)
    }
    const state: TurnState = {
      ...args.ctx.turnStateSeed,
      rec: freshRecovery(),
      collector: workCollector,
    }
    result = await runTurn(args.turn, args.ctx.session, state)
    flushKind = result.kind
    // An `interrupted` turn (ADR-0437 followup_task interrupt) is span-status
    // "aborted" — the turn's in-flight work was cut short — but the loop does
    // NOT finish (it parks + resumes). Distinct from `error`.
    turnSpanStatus =
      result.kind === "aborted" || result.kind === "interrupted"
        ? "aborted"
        : result.kind === "error"
          ? "error"
          : "ok"
  } catch (e) {
    turnSpanStatus = "error"
    throw e
  } finally {
    // T02 M5 — turn observability closeout is OWNED here so it fires EXACTLY
    // ONCE per turn on BOTH the normal-return AND the throw/pause path. Before
    // this move the flush lived in the outer loop AFTER the normal return, so a
    // throwing turn (approval pause) silently dropped `turn_diff` finalization,
    // git-directive flush, and work-metrics emit (L1 M5). The flush is itself
    // best-effort and must not mask the original throw — a flush failure on the
    // throw path is logged, never re-raised over the in-flight exception.
    try {
      await flushTurnObservability({
        cfg: args.ctx.cfg,
        stream: args.ctx.cfg.stream,
        turn: args.turn,
        turnDiffSession: args.ctx.turnDiffSession,
        gitDirectiveCollector: args.ctx.gitDirectiveCollector,
        workCollector,
        workTurnId,
        resultKind: flushKind,
      })
    } catch (flushErr) {
      logger.warn(`loop.flushTurnObservability: ${errMessage(flushErr)}`)
    }
    endSpan(turnSpan, turnSpanStatus, attrs({}))
  }
  return { result }
}

const runAgentTurnLoop = async (ctx: RunAgentContext): Promise<AgentOutcome | undefined> => {
  for (let turn = 1; turn <= ctx.cfg.maxTurns; turn++) {
    const turnReady = await prepareTurnIteration({
      cfg: ctx.cfg,
      wm: ctx.wm,
      sessionId: ctx.sessionId,
      taskRegistry: ctx.features.taskRegistry,
      turn,
      localizePhaseState: ctx.localizePhaseState,
      dedupGate: ctx.dedupGate,
      shellSnapshotSession: ctx.shellSnapshotSession,
      hookPromptPending: ctx.hookPromptPending,
    })
    if (turnReady === "aborted") {
      return ctx.finish("aborted", turn - 1, interruptedCategory("user"))
    }

    // T02 M5 — observability closeout is flushed INSIDE
    // `executeTurnWithObservability` (its `finally`), so it fires on the
    // throw/pause path too; the outer loop only consumes the resolved result.
    const { result } = await executeTurnWithObservability({ ctx, turn })
    const resolution = await resolveTurnLoopOutcome({
      cfg: ctx.cfg,
      stream: ctx.cfg.stream,
      wm: ctx.wm,
      breaker: ctx.breaker,
      recorder: ctx.recorder,
      turn,
      result,
      pendingPlanExitRef: ctx.pendingPlanExitRef,
      hookPromptPending: ctx.hookPromptPending,
    })
    // ADR-0437 follow-up — an INTERRUPTED turn (followup_task interrupt aborted
    // the in-flight turn) parks on the gate to consume the pending interrupt-
    // wake. `wait` resolves `resume` (the pending wake fires ⇒ a FRESH turn runs
    // and its top-of-loop mailbox read surfaces the interrupting message) or
    // `settle` (the lifetime signal aborted while unwinding / the gate was
    // disposed ⇒ the loop finishes as a genuine abort). A `park` resolution is
    // only ever produced when a gate is wired, so the gate is present here.
    if (resolution.kind === "park") {
      const gate = ctx.cfg.subagentTurnGate
      if (gate !== undefined && (await gate.wait(ctx.cfg.signal)) !== "settle") continue
      return ctx.finish("aborted", resolution.turns, interruptedCategory("user"))
    }
    if (resolution.kind === "finish") {
      // ADR-0437 follow-up — when a `subagentTurnGate` is wired AND this child
      // loop would CLEANLY complete, PARK on the gate instead of exiting so a
      // `followup_task` `wake()` can trigger another turn. A `woke`/`resume`
      // resolution re-enters the `for` (the next turn's mailbox read surfaces
      // the delivered followup — the existing per-turn injection seam); a
      // `settle` (abort / disposed / no gate) finishes normally. Only a clean
      // `completed` parks: an error/refusal/budget/aborted finish exits at once.
      // Default-OFF: no gate ⇒ `shouldParkOnGate` is false ⇒ byte-identical.
      if (await shouldParkOnGate(ctx, resolution)) continue
      return ctx.finish(
        resolution.reason,
        resolution.turns,
        resolution.stopCategory,
        resolution.refusal,
      )
    }
  }
  return undefined
}

/**
 * ADR-0437 follow-up — decide whether the child loop should PARK on its
 * {@link import("@/subagent").SubagentTurnGate} rather than finish. Returns
 * `true` (caller `continue`s the turn loop for another turn) ONLY when:
 *   - a gate is wired (`ctx.cfg.subagentTurnGate` present), AND
 *   - the resolution is a CLEAN `completed` finish, AND
 *   - the gate's `wait` resolved `woke` (a wake arrived while parked) or
 *     `resume` (a wake was pending — the loop was busy when followup_task
 *     fired ⇒ the "queued" turn now runs).
 * A `settle` resolution (abort signal / disposed gate) ⇒ `false` (finish).
 * Any non-`completed` finish ⇒ `false` (never park on error/refusal/abort/
 * budget). No gate ⇒ `false` immediately (default-OFF, byte-identical).
 */
const shouldParkOnGate = async (
  ctx: RunAgentContext,
  resolution: Extract<TurnLoopResolution, { kind: "finish" }>,
): Promise<boolean> => {
  const gate = ctx.cfg.subagentTurnGate
  if (gate === undefined || resolution.reason !== "completed") return false
  const waited = await gate.wait(ctx.cfg.signal)
  return waited !== "settle"
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
    const outcome = await runAgentInnerWithEgressProxy(config)
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
          ...(config.stage1OutputsStore !== undefined
            ? { stage1OutputsStore: config.stage1OutputsStore }
            : {}),
          signal: config.signal,
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

/**
 * ADR-0428 jun-02 wire — the egress-proxy lifecycle keystone. When the
 * `network-proxy` knob set `config.networkProxy.enabled`, construct + `listen()`
 * a `LoopbackEgressProxy` (on an ephemeral loopback port) for the WHOLE session,
 * inject its bound `proxyEnv` onto a per-session config clone, and ALWAYS close
 * the socket on teardown (normal return OR throw — `withEgressProxy`'s `finally`).
 * The injected `config.proxyEnv` flows through the dispatch seam onto
 * `ToolContext.proxyEnv`, so the bash tool threads `HTTP_PROXY`/`HTTPS_PROXY`
 * into every child spawn — closing the subprocess egress bypass.
 *
 * DEFAULT-OFF / byte-identical: knob absent or `enabled !== true` ⇒
 * `withEgressProxy` constructs NO socket and runs the body with `proxyEnv = {}`,
 * so `runAgentInner(config)` is called with the UNMODIFIED config reference (no
 * clone, no `proxyEnv` field) — every interactive turn is unchanged.
 */
const runAgentInnerWithEgressProxy = (config: AgentConfig): Promise<AgentOutcome> =>
  withEgressProxy(config.networkProxy, (ctx) =>
    runAgentInner(
      ctx.proxyEnv.address !== undefined ? { ...config, proxyEnv: ctx.proxyEnv } : config,
    ),
  )

/** Inner session loop. Identical body to the pre-span path; only the outer
 *  `runAgent` wrapper handles the `session_loop` span. Kept as a separate
 *  function (instead of inlining the span wrap) so the body's control flow
 *  (the multiple `finish(...)` returns + the trailing `max_turns` return)
 *  stays untouched — adding a `try/finally` around it inline would have
 *  required restructuring every return path. */
const runAgentInner = async (config: AgentConfig): Promise<AgentOutcome> => {
  const ctx = await createRunAgentContext(config)
  // ADR-0405 follow-up — opt-in LSP diagnostics auto-injection. env-gated
  // (`QUANTA_LSP_DIAGNOSTICS_HOOK=1`) AND requires both seam slots
  // (`hooks` + `subagentPendingPrompt`); absent ⇒ `undefined` ⇒ no handler,
  // byte-identical loop. Disposed in `finally` so a flaky LSP cannot leak.
  const diagnosticsHook = attachLspDiagnosticsHookIfEnabled(ctx.cfg)
  try {
    const startOutcome = await runSessionStartSequence({
      cfg: ctx.cfg,
      wm: ctx.wm,
      sessionId: ctx.sessionId,
      taskRegistry: ctx.features.taskRegistry,
    })
    if (startOutcome === "aborted") {
      return ctx.finish("aborted", 0, interruptedCategory("user"))
    }
    const finished = await runAgentTurnLoop(ctx)
    if (finished !== undefined) {
      return finished
    }
    return ctx.finish("max_turns", ctx.cfg.maxTurns, completedCategory("max_turns"))
  } finally {
    await diagnosticsHook?.dispose()
    // R4 audit [3]: the browser (Chrome proc + temp profile) must be torn down on
    // EVERY exit — including a thrown turn loop, where `ctx.finish()` (and its
    // cleanupFinishedSession) is never reached. Idempotent: a normal finish
    // already disposed it, and the session-holder no-ops a second call.
    await ctx.features.browserDispose?.().catch(() => {})
  }
}
