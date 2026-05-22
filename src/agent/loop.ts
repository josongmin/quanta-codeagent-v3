import type {
  assembleFromEvents,
  Message,
  StreamEvent,
  SystemPromptInput,
  ToolResultBlock,
} from "@/llm"
import { createWorkingMemory, type WorkingMemory } from "@/memory"
import { attrs, endSpan, QUANTA_ATTRS, SPAN_NAMES, type Span, startSpan } from "@/observability"
import type { AutoModeClassifier } from "@/permission"
import {
  normalizeRedactionConfig,
  type RedactionHit,
  type RedactionOrigin,
  redactSecrets,
} from "@/security"
import { LLMError, type RunContext } from "@/shared"
import { type Tool, ToolRegistry } from "@/tool"
import {
  type CloseoutGuardState,
  createCloseoutGuardState,
  decideCloseoutGuard,
} from "./closeout-guard"
import { compactIfNeeded, estimateTokens, reactiveCompact } from "./compaction"
import { CompactionBreaker } from "./compaction-breaker"
import {
  appendSummary,
  type ConversationSummaryArchive,
  createArchive,
} from "./conversation-summary-archive"
import { dispatchTool } from "./dispatch"
import { DedupGate } from "./dispatch-dedup"
import { buildSessionFeatures } from "./features"
import { renderIdeContext } from "./ide-context"
import { type PersistDeps, persistSession, recallContext } from "./memory"
import { AgentRecorder } from "./metrics"
import { buildTurnContext } from "./prompt"
import { backoffDelayMs, classifyLLMError } from "./retry"
import {
  classifyErrorReason,
  completedCategory,
  interruptedCategory,
  type StopCategory,
} from "./stop-category"
import { streamingTurn } from "./streaming-dispatch"
import { extractSeedMessages, isUserInputSubmission } from "./submission"
import {
  consumeTurnSignals,
  createToolChoiceTurnState,
  resolveToolChoice,
  type ToolChoiceTurnState,
} from "./tool-choice"
import { buildToolInputSeam } from "./tool-input-streaming"
import { makeTurnHeader } from "./turn-kind"
import type {
  AgentConfig,
  AgentOutcome,
  MemoryCitation,
  RedactionRollup,
  StopReason,
} from "./types"
import { createVerifyGuardState, decideVerifyGuard, type VerifyGuardState } from "./verify-guard"
import { TurnWorkMetricsCollector } from "./work-metrics-collector"
import type { WorkingStateSession } from "./working-state"

/** Bounded per-turn recovery budgets. These cap SAME-TURN retries so a
 *  pathological provider can never spin the loop forever; once exhausted the
 *  loop degrades gracefully (finish / accept-partial) rather than hanging. */
const MAX_TURN_STREAM_RETRIES = 3
const MAX_OUTPUT_CONTINUES = 3
const MAX_MALFORMED_RETRIES = 1
const MAX_CONSECUTIVE_EMPTIES = 2

/** Verify-guard history element (Tier 0 safety hardening). A real SWE-bench run proved the
 *  guard fired 0 times because the agent runs a noise `bash` (`git status`/`ls`)
 *  after editing and the old policy counted ANY bash as "verified", defeating
 *  the guard. R1's tightened `decideVerifyGuard` only counts a `bash` as a
 *  verification when its command string matches a test/repro regex — so the
 *  loop MUST carry the bash command string here (it previously pushed only the
 *  name, leaving `arg` always undefined). `arg` is conditionally set for `bash`
 *  ONLY (exactOptionalPropertyTypes: omitted, never `arg: undefined`). */
type ToolHistoryEntry = { name: string; arg?: string }

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
type AssembledMessage = ReturnType<typeof assembleFromEvents>["message"]

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

/** Stable, small set of `recovery` reasons (RFC-0002 §5.2). Group E maps these
 *  → trajectory kinds; keep the set closed so probe/triage can rely on it. */
type RecoveryReason =
  | "backoff"
  | "compact"
  | "nudge"
  | "empty"
  | "malformed"
  | "unverified"
  | "closeout"

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
  config.stream.emit({ type: "llm_request", model: configuredModel(config.llm) })
}

/** RFC may-22 Phase 1: BudgetMeter tick helper for tool dispatch. Folds the
 *  bash → shell_command and test_runner → test_run sub-counters into a single
 *  call site so the `streamConsume` dispatch callback's cognitive complexity
 *  doesn't grow. Optional-chain on every read so a meter-less config is
 *  byte-for-byte identical to the pre-RFC path. */
const tickToolDispatch = (config: AgentConfig, name: string): void => {
  config.budgetMeter?.tick("tool_call")
  if (name === "bash") config.budgetMeter?.tick("shell_command")
  if (name === "test_runner") config.budgetMeter?.tick("test_run")
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
interface SkillGate {
  /** False ⇒ the call must be denied (not in the active skill's allowlist). */
  allow(name: string): boolean
  /** Observe a completed dispatch; a successful `Skill` invocation with a
   *  declared allowlist arms/replaces the active scope. */
  observe(name: string, input: unknown, ok: boolean): void
}
const buildSkillGate = (allowlists: Map<string, string[]> | undefined): SkillGate | undefined => {
  if (!allowlists || allowlists.size === 0) return undefined
  let active: Set<string> | undefined
  return {
    allow: (name) => active === undefined || SKILL_META_TOOLS.has(name) || active.has(name),
    observe: (name, input, ok) => {
      if (name !== "Skill" || !ok) return
      const raw =
        typeof input === "object" && input !== null && "name" in input
          ? (input as { name: unknown }).name
          : undefined
      const skill = typeof raw === "string" ? raw.trim().replace(/^\//, "") : ""
      const allow = allowlists.get(skill)
      if (allow) active = new Set(allow)
    },
  }
}
/** Recoverable deny when a tool is outside the active skill's allowlist. */
const skillScopeDeny = (call: { id: string; name: string }): StreamDispatchOut => ({
  block: {
    type: "tool_result",
    tool_use_id: call.id,
    content:
      `Tool "${call.name}" is not in the active skill's permitted tool set. ` +
      "Use only the tools the skill allows, or invoke a different skill.",
    is_error: true,
  } satisfies ToolResultBlock,
  ok: false,
  preview: "skill-scoped",
})
type StreamDispatchOut = {
  block: ToolResultBlock
  ok: boolean
  preview: string
  /** ADR-0078 — present on the `dispatchTool` branch (redaction hits for the
   *  tool_result); absent on the skill-scope-deny branch. Optional so the
   *  union accessed in the dispatch callback is uniform. */
  redactionHits?: ReadonlyArray<RedactionHit>
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
  config: AgentConfig,
  messages: Message[],
  specs: ReturnType<AgentConfig["registry"]["specs"]>,
  system: SystemPromptInput,
  recorder: AgentRecorder | undefined,
  classifier: AutoModeClassifier | undefined,
  skillGate: SkillGate | undefined,
  toolHistory: ToolHistoryEntry[] | undefined,
  workingState: WorkingStateSession | undefined,
  collector: TurnWorkMetricsCollector | undefined,
  toolChoiceState: ToolChoiceTurnState,
  onRedaction: (origin: RedactionOrigin, hits: readonly RedactionHit[]) => void,
): Promise<StreamConsumeResult> => {
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
  try {
    const outcome = await streamingTurn({
      events: teeUsage(
        config,
        config.llm.stream({
          messages,
          system,
          tools: specs,
          ...(toolChoice.kind !== "auto" ? { toolChoice } : {}),
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
      dispatch: async (call) => {
        const s = recorder?.toolExec()
        // RFC may-22 Phase 1: BudgetMeter tick — every tool dispatch counts
        // as one tool_call; bash → shell_command; test_runner → test_run.
        // Optional chain so absence is byte-identical to pre-RFC.
        tickToolDispatch(config, call.name)
        try {
          // ADR-0011: enforce the active skill's tool allowlist —
          // an out-of-scope tool is denied as a recoverable tool_result
          // WITHOUT dispatching it. No gate / no active skill ⇒ unchanged.
          const out =
            skillGate && !skillGate.allow(call.name)
              ? skillScopeDeny(call)
              : await dispatchTool(
                  { type: "tool_use", id: call.id, name: call.name, input: call.input },
                  config,
                  config.permission,
                  (message) =>
                    config.stream.emit({
                      type: "tool_progress",
                      id: call.id,
                      name: call.name,
                      message,
                    }),
                  classifier,
                  workingState,
                )
          // A successful `Skill` invocation (re)arms the scope for next calls.
          skillGate?.observe(call.name, call.input, out.ok)
          // ADR-0078 point #1 — fold this tool_result's redaction hits into the
          // run-scoped rollup (empty/absent ⇒ no-op; disabled ⇒ dispatch never
          // produced hits).
          onRedaction("tool_result", out.redactionHits ?? [])
          // absorb #6: per-turn work-metrics — count the action and, when the
          // tool is `read`, count returned lines. Collector absent ⇒ no-op
          // (the sink is unwired). recordRead duck-types the result shape so
          // no `@/tool` import is needed here.
          collector?.recordToolCall(call.name, out)
          collector?.recordRead(call.name, out.preview)
          // RFC-0002 §5.2 enriched tool_result. CONTRACT with Group E: the
          // dispatch result exposes these EXACT optional field names
          // (`durationMs:number`, `stderrTail:string`, `exitCode:number`,
          // `fullLogPath:string`). Spread whichever are present so this works
          // the instant E lands and never throws while E is still in flight
          // (pre-E the fields are simply absent → byte-identical emit). Pure
          // observation: NullStream swallows it, control flow is untouched.
          const enriched = out as typeof out & {
            durationMs?: number
            stderrTail?: string
            exitCode?: number
            fullLogPath?: string
          }
          config.stream.emit({
            type: "tool_result",
            id: call.id,
            name: call.name,
            ok: out.ok,
            preview: out.preview,
            ...(enriched.durationMs !== undefined ? { durationMs: enriched.durationMs } : {}),
            ...(enriched.stderrTail !== undefined ? { stderrTail: enriched.stderrTail } : {}),
            ...(enriched.exitCode !== undefined ? { exitCode: enriched.exitCode } : {}),
            ...(enriched.fullLogPath !== undefined ? { fullLogPath: enriched.fullLogPath } : {}),
          })
          return out
        } finally {
          s?.()
        }
      },
      onTextDelta: (delta) => config.stream.emit({ type: "assistant_text", delta }),
      onToolStart: (call) => {
        config.stream.emit({ type: "tool_call", id: call.id, name: call.name, input: call.input })
        recorder?.toolCall(call.name)
        // Verify-guard (Tier 0 safety hardening): ordered dispatched tool entries this run.
        // `toolHistory` is created ONLY when `config.verifyGuard` is set, so
        // with the guard absent this push never runs (byte-identical).
        // A real SWE-bench run showed the guard fired 0 times: the agent ran a
        // noise `bash` (`git status`) after editing and the old policy treated
        // ANY bash as "verified". R1's tightened policy only counts a `bash`
        // when its command matches a test/repro regex — so for `bash` we MUST
        // carry the command string (the bash tool input is `{command:string}`);
        // without it `arg` is always undefined and every real `pytest`/`python
        // repro.py` would be (wrongly) treated as non-verify. For non-`bash`
        // tools `arg` is OMITTED (exactOptionalPropertyTypes — never undefined).
        if (toolHistory) {
          const command =
            call.name === "bash" &&
            typeof call.input === "object" &&
            call.input !== null &&
            "command" in call.input
              ? (call.input as { command: unknown }).command
              : undefined
          toolHistory.push(
            typeof command === "string" ? { name: call.name, arg: command } : { name: call.name },
          )
        }
      },
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
    // Single close site for `run_sampling_request`. Default-OFF (no sink) ⇒
    // no-op (sentinel short-circuits both the close branch and the duration
    // math). Note: this runs AFTER `stop?.()` so the recorder's llm-span
    // close precedes the OTel span close — matching the existing recorder-
    // first convention used elsewhere in the loop.
    endSpan(samplingSpan, samplingStatus, attrs({}))
  }
}

/** True when the assembled turn produced nothing usable: no text, no tool_use
 *  (e.g. an empty completion or a thinking-only block). */
const isEmptyTurn = (m: AssembledMessage): boolean =>
  !m.content.some((b) => (b.type === "text" && b.text.trim() !== "") || b.type === "tool_use")

/** A short out-of-band user message used to steer the model on a same-turn
 *  retry (output-limit / malformed-tool / empty). Kept terse on purpose. */
const metaUser = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})

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
    const message = e instanceof Error ? e.message : String(e)
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
  try {
    result = await compactIfNeeded({
      messages: snapshot,
      // ADR-0011: optional dedicated summarizer model; absent ⇒ main
      // llm (byte-identical). Summarization is low-stakes; a cheaper/faster
      // model spares the main model on every compaction.
      llm: config.compaction.summarizerLlm ?? config.llm,
      system,
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
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
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

/** Pure construction of the persistence dependency bag from config. Mirrors
 *  the conditional-spread semantics required by `exactOptionalPropertyTypes`
 *  (omit keys entirely, never assign `undefined`). Caller guards `config.store`
 *  presence before invoking `persistSession`. */
const buildPersistDeps = (
  config: AgentConfig,
  recorder: AgentRecorder | undefined,
  redactionEnabled: boolean,
  onRedaction: (origin: RedactionOrigin, hits: readonly RedactionHit[]) => void,
): PersistDeps => ({
  // biome-ignore lint/style/noNonNullAssertion: call site guards `config.store`
  store: config.store!,
  llm: config.llm,
  ...(config.embedder ? { embedder: config.embedder } : {}),
  ...(config.memory?.distill !== undefined ? { distill: config.memory.distill } : {}),
  ...(config.memory?.consolidate !== undefined ? { consolidate: config.memory.consolidate } : {}),
  ...(config.memory?.evictionCaps ? { evictionCaps: config.memory.evictionCaps } : {}),
  ...(recorder ? { onStats: (s) => recorder.memoryPersist(s) } : {}),
  // ADR-0078 point #3 — redact the serialized transcript before the distill LLM
  // call. Disabled ⇒ `redactionDisabled:true` so distillSession skips redaction
  // (acknowledged-risk posture); enabled ⇒ hits fold into the run rollup under
  // the `memory_distill` origin.
  ...(config.redaction?.whitelist ? { redactionWhitelist: config.redaction.whitelist } : {}),
  ...(redactionEnabled ? {} : { redactionDisabled: true }),
  onRedactionHits: (hits) => onRedaction("memory_distill", hits),
  signal: config.signal,
})

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

/** Mutable per-turn recovery counters, threaded so the budgets are SAME-TURN
 *  (a fresh turn resets them; same-turn retries decrement the shared budget). */
export interface RecoveryState {
  streamRetries: number
  outputContinues: number
  malformedRetries: number
  consecutiveEmpties: number
}

export const freshRecovery = (): RecoveryState => ({
  streamRetries: 0,
  outputContinues: 0,
  malformedRetries: 0,
  consecutiveEmpties: 0,
})

/** What the turn driver should do next. `retry_*` re-enters the SAME turn
 *  (no turn increment); `nudge` first appends a meta user message; `compact`
 *  asks for reactive compaction; `backoff` sleeps `delayMs` first. */
type RecoveryAction =
  | { do: "backoff"; attempt: number }
  | { do: "compact" }
  | { do: "nudge"; keepMessage: boolean; text: string; reason: RecoveryReason }
  | { do: "proceed" }
  | { do: "completed" }
  | { do: "error"; reason: string }

/** Pure policy for a thrown stream error: classify it, consult the SAME-TURN
 *  budget, and decide. Mutates `rec` (consumes a retry slot) only when it
 *  actually elects to retry — kept here so the decision is unit-testable. */
export const decideOnStreamError = (
  error: unknown,
  message: string,
  rec: RecoveryState,
): RecoveryAction => {
  const kind = classifyLLMError(error)
  if (kind === "retryable") {
    if (rec.streamRetries >= MAX_TURN_STREAM_RETRIES) {
      return { do: "error", reason: `LLM stream failed after retries: ${message}` }
    }
    const attempt = rec.streamRetries
    rec.streamRetries += 1
    return { do: "backoff", attempt }
  }
  if (kind === "prompt_too_long") return { do: "compact" }
  return { do: "error", reason: message }
}

/** Pure policy for a successfully assembled turn: decide whether it is final,
 *  needs a SAME-TURN nudge+retry (output-limit / malformed / empty), or should
 *  proceed to tool dispatch. Mutates `rec` only when it elects a nudge/retry. */
export const decideOnAssembled = (
  stopReason: string,
  message: AssembledMessage,
  rec: RecoveryState,
): RecoveryAction => {
  // ADR-0076 Gap-1: provider refusal / abnormal non-tool stop. The model
  // stopped with an explicit refusal (Anthropic `refusal`, OpenAI content-
  // policy stop). Surface it as an error so the run does NOT report the
  // refusal text as a normal completion — the pre-ADR fall-through bug routed
  // every unrecognized stop_reason to `proceed`→`completed`, disguising a
  // refusal as success. `pause_turn` (server-tool resume) is intentionally
  // NOT handled: we ship no server-side tools, so it cannot be emitted; adding
  // a dead branch would be cargo.
  if (stopReason === "refusal") {
    return {
      do: "error",
      reason:
        "Model refused to continue (stop_reason=refusal); the assistant " +
        "message carries the refusal rationale, not a completed task.",
    }
  }
  if (stopReason === "max_tokens" && rec.outputContinues < MAX_OUTPUT_CONTINUES) {
    rec.outputContinues += 1
    return {
      do: "nudge",
      keepMessage: true,
      text: "Output limit hit — continue exactly where you left off, do not repeat.",
      reason: "nudge",
    }
  }
  const hasTools = message.content.some((b) => b.type === "tool_use")
  if (stopReason === "tool_use" && !hasTools) {
    if (rec.malformedRetries < MAX_MALFORMED_RETRIES) {
      rec.malformedRetries += 1
      return {
        do: "nudge",
        keepMessage: true,
        text:
          "Your previous tool call was malformed/incomplete. Re-issue it as a " +
          "single valid tool call.",
        reason: "malformed",
      }
    }
    return { do: "completed" }
  }
  if (!hasTools && isEmptyTurn(message)) {
    if (rec.consecutiveEmpties >= MAX_CONSECUTIVE_EMPTIES) return { do: "completed" }
    rec.consecutiveEmpties += 1
    return {
      do: "nudge",
      keepMessage: true,
      text: "You returned an empty response. Continue the task or give your final answer.",
      reason: "empty",
    }
  }
  rec.consecutiveEmpties = 0
  return { do: "proceed" }
}

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
      message: `ide-context provider failed: ${e instanceof Error ? e.message : String(e)}`,
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
 *  compaction (mutates `messages` in place), then the buildTurnContext SEAM. */
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
    // Cached at session start by `buildSessionFeatures`; passed through every
    // turn without re-discovery (Codex anti-reread). Absent ⇒ no block in the
    // rendered reminder (byte-identical for skill-less sessions).
    ...(activeSkills !== undefined ? { activeSkills } : {}),
    ...(wsSnapshot !== undefined ? { workingState: wsSnapshot } : {}),
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
/** True when this decided action is a finish attempt: an exhaustion-completed
 *  (malformed/empty retries spent) OR a proceed turn that produced NO tool_use
 *  (a pure-text "I'm done"). These are exactly the two points the loop accepts
 *  a completion, so they are the points the verify-guard must intercept. */
const isFinishAttempt = (action: RecoveryAction, message: AssembledMessage): boolean =>
  action.do === "completed" ||
  (action.do === "proceed" && !message.content.some((b) => b.type === "tool_use"))

/** If `config.verifyGuard` is set and the model is finishing right after an
 *  unverified edit, mutate `wm` with the kept assistant turn + the forcing
 *  meta-user message and return `CONTINUE` (reusing the SAME nudge machinery:
 *  no maxTurns consumption, recovery emitted). Returns `undefined` to let the
 *  completion proceed unchanged. Guard absent ⇒ never blocks (byte-identical). */
const verifyGuardStep = (
  config: AgentConfig,
  action: RecoveryAction,
  message: AssembledMessage,
  wm: WorkingMemory<Message>,
  history: readonly ToolHistoryEntry[],
  state: VerifyGuardState | undefined,
  toolChoiceState: ToolChoiceTurnState,
): Step | undefined => {
  if (config.verifyGuard === undefined || state === undefined) return undefined
  if (!isFinishAttempt(action, message)) return undefined
  // History already carries the `{name, arg?}` shape R1's policy needs (the
  // bash command is captured at dispatch in `streamConsume` — see the empirical
  // 0-trip finding there); pass it straight through, no per-call remap.
  const verdict = decideVerifyGuard({
    history,
    cfg: config.verifyGuard,
    state,
  })
  if (!verdict.block || verdict.text === undefined) return undefined
  emitRecovery(config, "unverified")
  // ADR-0079 — arm tool_choice:{kind:"any"} for the FORCED re-entry so the model
  // is required to call a tool (typically the missing verify). Consumed + cleared
  // by the next `streamConsume` (1-turn TTL).
  toolChoiceState.verifyGuardViolated = true
  wm.append(message)
  wm.append(metaUser(verdict.text))
  return CONTINUE
}

/** Closeout reminder hook (Codex App agent loop doc §4 mirror). v3 has NO
 *  finish-time self-check: at the moment of completion the agent can overclaim
 *  ("verified" when no verification ran, mix fact with inference, ignore the
 *  requested reporting shape). When `config.closeoutGuard?.enabled === true`
 *  and the model is about to finish, convert that completion into the SAME
 *  nudge action the recovery machinery already understands (`keepMessage:true`
 *  so the final assistant turn is preserved, no maxTurns consumption, recovery
 *  emitted) ONCE per run. Ordering: this runs AFTER `verifyGuardStep`, so when
 *  verify also fires it trips FIRST on its triggering finish; closeout fires
 *  the next time the agent attempts to finish AFTER verify is satisfied. Guard
 *  absent or `enabled !== true` ⇒ never blocks (default-OFF, byte-identical). */
const closeoutGuardStep = (
  config: AgentConfig,
  action: RecoveryAction,
  message: AssembledMessage,
  wm: WorkingMemory<Message>,
  history: readonly ToolHistoryEntry[],
  state: CloseoutGuardState | undefined,
  toolChoiceState: ToolChoiceTurnState,
): Step | undefined => {
  if (config.closeoutGuard === undefined || state === undefined) return undefined
  if (!isFinishAttempt(action, message)) return undefined
  // History is duck-typed by `decideCloseoutGuard` as `ReadonlyArray<{name}>` so
  // the `{name, arg?}` shape the verify-guard already captures flows straight
  // through with zero remap — a session that called a mutating tool routes to
  // the Phase 4 four-truth-surface reminder; non-code-mod sessions fall through
  // to the legacy single/four-rule choice.
  const verdict = decideCloseoutGuard({ cfg: config.closeoutGuard, state, history })
  if (!verdict.block || verdict.text === undefined) return undefined
  emitRecovery(config, "closeout")
  // ADR-0079 — arm tool_choice:{kind:"none"} for the FORCED re-entry so the model
  // is FORBIDDEN from emitting any tool_use (it must produce the terminal closeout
  // text). Consumed + cleared by the next `streamConsume` (1-turn TTL). Ordered
  // after verify, whose `any` wins the precedence ladder if both co-arm.
  toolChoiceState.closeoutAttempted = true
  wm.append(message)
  wm.append(metaUser(verdict.text))
  return CONTINUE
}

const applyAction = async (
  config: AgentConfig,
  action: RecoveryAction,
  result: StreamSuccess | { error: unknown; message: string },
  wm: WorkingMemory<Message>,
  ctxSystem: SystemPromptInput,
  breaker: CompactionBreaker | undefined,
  history: readonly ToolHistoryEntry[],
  verifyGuardState: VerifyGuardState | undefined,
  closeoutGuardState: CloseoutGuardState | undefined,
  toolChoiceState: ToolChoiceTurnState,
): Promise<Step> => {
  if (action.do === "error") return { done: true, result: { kind: "error", reason: action.reason } }
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
  // Tier 0 safety hardening: a finish attempt right after an unverified edit is forced
  // into one more turn. All the branching/decision lives in `verifyGuardStep`
  // so this hot path stays a single guarded call (default-OFF ⇒ undefined).
  const guarded = verifyGuardStep(
    config,
    action,
    message,
    wm,
    history,
    verifyGuardState,
    toolChoiceState,
  )
  if (guarded) return guarded
  // Closeout reminder (§4 mirror): a finish attempt is given one single-shot
  // closeout nudge per run. Ordered STRICTLY AFTER verify-guard: if verify
  // already blocked above we never reach here on this turn — closeout fires the
  // NEXT finish-intent (after verify is satisfied). Default-OFF ⇒ undefined.
  const closedout = closeoutGuardStep(
    config,
    action,
    message,
    wm,
    history,
    closeoutGuardState,
    toolChoiceState,
  )
  if (closedout) return closedout
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
  config: AgentConfig,
  wm: WorkingMemory<Message>,
  specs: ReturnType<AgentConfig["registry"]["specs"]>,
  recorder: AgentRecorder | undefined,
  rec: RecoveryState,
  breaker: CompactionBreaker | undefined,
  classifier: AutoModeClassifier | undefined,
  skillGate: SkillGate | undefined,
  toolHistory: ToolHistoryEntry[] | undefined,
  verifyGuardState: VerifyGuardState | undefined,
  closeoutGuardState: CloseoutGuardState | undefined,
  activeSkills: { name: string; description: string }[] | undefined,
  workingState: WorkingStateSession | undefined,
  collector: TurnWorkMetricsCollector | undefined,
  archive: ConversationSummaryArchive | undefined,
  turn: number,
  toolChoiceState: ToolChoiceTurnState,
  citations: MemoryCitation[],
  onRedaction: (origin: RedactionOrigin, hits: readonly RedactionHit[]) => void,
): Promise<TurnResult> => {
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
    )
    const result = await streamConsume(
      config,
      ctx.messages,
      specs,
      ctx.system,
      recorder,
      classifier,
      skillGate,
      toolHistory,
      workingState,
      collector,
      toolChoiceState,
      onRedaction,
    )
    if ("aborted" in result) return { kind: "aborted" }

    const action =
      "error" in result
        ? decideOnStreamError(result.error, result.message, rec)
        : decideOnAssembled(result.stopReason, result.message, rec)

    const step = await applyAction(
      config,
      action,
      result,
      wm,
      ctx.system,
      breaker,
      // Audit [LOW]: the guard-OFF path used to allocate a throwaway `[]`
      // EVERY turn (contradicting the byte-identical zero-allocation intent).
      // Reuse one shared frozen empty array when the guard is off.
      toolHistory ?? EMPTY_TOOL_HISTORY,
      verifyGuardState,
      closeoutGuardState,
      toolChoiceState,
    )
    if (step.done) return step.result
  }
}

/** Per-turn correlation context (RFC-0002 §5.1/§5.4). A fresh shallow copy of
 *  the caller's `config.run` with `turn` restamped — so `config.run` is NEVER
 *  mutated. Returns `undefined` when unconfigured (zero overhead, loop
 *  byte-identical). Pure: used only for correlation, never control flow. */
const stampTurn = (run: RunContext | undefined, turn: number): RunContext | undefined =>
  run ? { ...run, turn } : undefined

/** Reconstruct the `Tool[]` backing a registry (it is construct-only — no
 *  enumerator) so extra tools can be merged into a fresh registry. */
const registryTools = (r: AgentConfig["registry"]): Tool[] =>
  r
    .specs()
    .map((s) => r.get(s.name))
    .filter((t): t is Tool => t !== undefined)

/** Fold extra tools (subagent/skill) into a fresh registry. With none
 *  (`extraTools` empty) returns the SAME config by identity, so the loop stays
 *  byte-for-byte identical to the pre-absorption path. */
const buildEffectiveConfig = (config: AgentConfig, extraTools: Tool[]): AgentConfig =>
  extraTools.length > 0
    ? {
        ...config,
        registry: new ToolRegistry([...registryTools(config.registry), ...extraTools]),
      }
    : config

/** Verify-guard per-run resources (Tier 0 safety hardening). Built when EITHER
 *  `config.verifyGuard` OR `config.closeoutGuard?.enabled === true` is set:
 *  closeout-guard now duck-reads the same tool-history array to route a
 *  code-modification session to the Phase 4 four-truth-surface reminder
 *  (ADR-0019). With NEITHER set ⇒ both `undefined` (no allocation, the
 *  history push + guard decisions are never reached → loop byte-identical).
 *  The `state` (verifyGuardState) stays gated on `verifyGuard` alone. */
const buildVerifyGuard = (
  config: AgentConfig,
): { state?: VerifyGuardState; history?: ToolHistoryEntry[] } => {
  const needHistory = config.verifyGuard !== undefined || config.closeoutGuard?.enabled === true
  const out: { state?: VerifyGuardState; history?: ToolHistoryEntry[] } = {}
  if (config.verifyGuard) out.state = createVerifyGuardState()
  if (needHistory) out.history = []
  return out
}

/** Closeout reminder per-run resource. Built ONLY when
 *  `config.closeoutGuard?.enabled === true`: a single-shot trip counter.
 *  Absent (or `enabled !== true`) ⇒ `undefined` (no allocation, the guard
 *  decision is never reached → loop byte-identical). Extracted so `runAgent`
 *  gains no extra cognitive-complexity branch — mirrors `buildVerifyGuard`. */
const buildCloseoutGuard = (config: AgentConfig): CloseoutGuardState | undefined =>
  config.closeoutGuard?.enabled === true ? createCloseoutGuardState() : undefined

/** Per-turn work-metrics resources (absorb #6, ADR-0064). Built ONLY when
 *  `cfg.workMetricsSink` is wired. With the sink absent ⇒ both fields stay
 *  `undefined`, no object is allocated, all `collector?.` no-op and the
 *  finalize/emit helper short-circuits → loop byte-for-byte identical.
 *
 *  `turnId` reuses the ADR-0030 `activeTurnRef.currentTurn.turnId` when set
 *  (so a surface that tracks both sees one UUID space); otherwise we mint a
 *  fresh per-turn UUID so the sink ALWAYS gets a stable correlation id.
 *  Extracted so `runAgent` gains no new branch — mirrors `buildVerifyGuard`. */
const buildWorkMetricsResources = (
  cfg: AgentConfig,
): { collector?: TurnWorkMetricsCollector; turnId?: string } => {
  if (cfg.workMetricsSink === undefined) return {}
  return {
    collector: new TurnWorkMetricsCollector(),
    turnId: cfg.activeTurnRef?.current.currentTurn?.turnId ?? crypto.randomUUID(),
  }
}

/** Finalize the collector and hand the snapshot to the sink. Skipped when no
 *  sink is wired (default-OFF byte-identical) or when the turn aborted before
 *  any work landed (snapshot is all-zeros → no signal). Extracted so `runAgent`
 *  gains no new branch — mirrors `buildVerifyGuard`/`buildCloseoutGuard`.
 *
 *  TODO(absorb #6 cont.): collect numstat per-turn from git_diff results (or
 *  spawn `git diff --numstat HEAD` here, gated on a git-repo check) so
 *  `diffMap` reflects actual file changes; today it accumulates only when a
 *  future tool routes numstat through `collector.recordDiff(...)`. */
const emitWorkMetrics = (
  cfg: AgentConfig,
  collector: TurnWorkMetricsCollector | undefined,
  turnId: string | undefined,
  resultKind: TurnResult["kind"],
): void => {
  if (
    cfg.workMetricsSink === undefined ||
    collector === undefined ||
    turnId === undefined ||
    resultKind === "aborted"
  ) {
    return
  }
  const metrics = collector.finalize(cfg.llm.model)
  cfg.workMetricsSink.emit(metrics, { turnId })
}

/** Codex 10-step span tree — outer-most ring (`session_loop`). Default-OFF:
 *  when no {@link SpanSink} is registered, both `startSpan` / `endSpan` return
 *  the shared no-op sentinel — zero allocations, the loop is byte-identical
 *  to the pre-span path. `attrs` use canonical {@link QUANTA_ATTRS} keys
 *  (no raw strings — the vocabulary-orphan scan enforces this).
 *
 *  Session-id semantics: the sessionId IS the conversation/thread anchor for
 *  this run (mirrors how `quanta.thread.id` was already populated by the
 *  side-conversation absorption — see vocabulary.ts comments).
 *  `quanta.thread.kind` is `"main"` here; subagent/side-conv spans set their
 *  own kind. */
const sessionSpanAttrs = (sessionId: string): ReturnType<typeof attrs> =>
  attrs({
    [QUANTA_ATTRS.conversation.id]: sessionId,
    [QUANTA_ATTRS.thread.id]: sessionId,
    [QUANTA_ATTRS.thread.kind]: "main",
  })

/** Codex 10-step span tree — turn ring (`session_task.turn`). Opens once per
 *  logical turn (a SAME-TURN retry does NOT open a new span — it stays under
 *  the same turn id, matching Codex's convention). On close, `quanta.turn.
 *  duration_ms` is supplied by `endSpan` itself (computed from monotonic
 *  start), so the close-attrs need only echo the id. */
const turnSpanAttrs = (turnId: string): ReturnType<typeof attrs> =>
  attrs({
    [QUANTA_ATTRS.turn.id]: turnId,
    [QUANTA_ATTRS.turn.kind]: "main",
  })

// (The `handle_tool_call` span is wrapped in `dispatch.ts` — closer to the
// actual tool-execution surface so the span open / close stays adjacent to
// the call sites that produce its status.)

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
  const skillGate = buildSkillGate(features.skillAllowlists)
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
  // ADR-0079 — session-scoped tool_choice turn state. Always constructed (a
  // bare `{verifyGuardViolated:false, closeoutAttempted:false}`); with no guard
  // ever arming a flag, `consumeTurnSignals` always yields `{}` and
  // `resolveToolChoice` always returns `{kind:"auto"}` ⇒ the field is omitted
  // from every `StreamInput` (byte-identical wire payload, default-OFF).
  const toolChoiceState = createToolChoiceTurnState()
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
  const redactionAgg = new Map<string, RedactionRollup>()
  const recordRedaction = (origin: RedactionOrigin, hits: readonly RedactionHit[]): void => {
    for (const h of hits) {
      const key = `${origin} ${h.kind}`
      const cur = redactionAgg.get(key)
      redactionAgg.set(
        key,
        cur ? { ...cur, count: cur.count + 1 } : { origin, kind: h.kind, count: 1 },
      )
    }
  }
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

  const finish = async (
    reason: StopReason,
    turns: number,
    stopCategory?: StopCategory,
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
      const message = e instanceof Error ? e.message : String(e)
      stream.emit({ type: "error", message: `subagent cleanup failed: ${message}` })
    }
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
    }
  }

  // RFC-0002 §5.2 `session_start` — emitted ONCE at run start so the trajectory
  // has a head marker (Group E maps it → kind:"session_start"). Pure
  // observation: an AgentEvent only seen when a stream/recorder is attached
  // (NullStream swallows it); it precedes nothing in the control flow.
  stream.emit({ type: "session_start" })

  if (cfg.hooks) await cfg.hooks.emit({ type: "session_start", sessionId })

  for (let turn = 1; turn <= cfg.maxTurns; turn++) {
    if (cfg.signal.aborted) return finish("aborted", turn - 1, interruptedCategory("user"))
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
    if (cfg.hooks) await cfg.hooks.emit({ type: "turn_start", turn })

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
    // Recovery counters are per-turn: SAME-TURN retries share & exhaust these,
    // a fresh turn starts clean. runTurn owns the SEAM (buildTurnContext) and
    // mutates `messages` (canonical history) in place.
    let result: TurnResult
    try {
      result = await runTurn(
        cfg,
        wm,
        specs,
        recorder,
        freshRecovery(),
        breaker,
        classifier,
        skillGate,
        toolHistory,
        verifyGuardState,
        closeoutGuardState,
        activeSkills,
        workingState,
        workCollector,
        summaryArchive,
        turn,
        toolChoiceState,
        memoryCitations,
        recordRedaction,
      )
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
