import type { assembleFromEvents, Message, StreamEvent, SystemPromptInput } from "@/llm"
import { createWorkingMemory, type WorkingMemory } from "@/memory"
import type { AutoModeClassifier } from "@/permission"
import { LLMError, type RunContext } from "@/shared"
import { type Tool, ToolRegistry } from "@/tool"
import { compactIfNeeded, estimateTokens, reactiveCompact } from "./compaction"
import { CompactionBreaker } from "./compaction-breaker"
import { dispatchTool } from "./dispatch"
import { buildSessionFeatures } from "./features"
import { type PersistDeps, persistSession, recallContext } from "./memory"
import { AgentRecorder } from "./metrics"
import { buildTurnContext } from "./prompt"
import { backoffDelayMs, classifyLLMError } from "./retry"
import { streamingTurn } from "./streaming-dispatch"
import type { AgentConfig, AgentOutcome, StopReason } from "./types"

/** Bounded per-turn recovery budgets. These cap SAME-TURN retries so a
 *  pathological provider can never spin the loop forever; once exhausted the
 *  loop degrades gracefully (finish / accept-partial) rather than hanging. */
const MAX_TURN_STREAM_RETRIES = 3
const MAX_OUTPUT_CONTINUES = 3
const MAX_MALFORMED_RETRIES = 1
const MAX_CONSECUTIVE_EMPTIES = 2

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
 *   (SOTA++ Tier 0, ADR-0011) aborts a compact↔PTL thrash spin.
 * - hooks + memory/metrics wiring: `HookBus` events, working-memory + long-term
 *   recall/persist (`recallContext`/`persistSession`), `AgentRecorder` counters.
 * - ADR-0004 cached prompt: the loop consumes `buildTurnContext`'s
 *   `{ system, messages }` (static cache-prefix system + a single trailing
 *   `<system-reminder>` for the per-turn dynamic context); it does NOT
 *   re-assemble the system prompt per turn.
 * - SOTA++ (ADR-0011): streaming tool execution — a concurrency-safe tool is
 *   dispatched the instant its `tool_use` block finishes streaming (overlapping
 *   the rest of the model stream); a non-safe call is a head-of-line barrier
 *   run after the stream completes. `tool_result` blocks stay in the model's
 *   original call order. Optional subagent/skill tools + an "auto"-mode LLM
 *   permission classifier are materialized once via `buildSessionFeatures`.
 *
 * With NO Tier-1 config and a turn that yields 0 or only non-safe tool calls,
 * behaviour is byte-for-byte identical to the pre-SOTA++ batched path.
 */
type AssembledMessage = ReturnType<typeof assembleFromEvents>["message"]

/** Bridge a `{type:"usage"}` StreamEvent (W-A2, currently dropped by
 *  `assembleFromEvents`) to the homomorphic `AgentEvent` so recorders capture
 *  token/usage. 1:1 field map; this is the ONLY new emit and is independent of
 *  all existing control flow / emit ordering. */
const emitUsage = (config: AgentConfig, ev: Extract<StreamEvent, { type: "usage" }>): void => {
  config.stream.emit({
    type: "usage",
    inputTokens: ev.inputTokens,
    outputTokens: ev.outputTokens,
    model: ev.model,
    ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
  })
}

/** Stable, small set of `recovery` reasons (RFC-0002 §5.2). Group E maps these
 *  → trajectory kinds; keep the set closed so probe/triage can rely on it. */
type RecoveryReason = "backoff" | "compact" | "nudge" | "empty" | "malformed"

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

/** Pass-through wrapper over the model stream that tees `usage` events to the
 *  W-C `emitUsage` bridge (RFC-0002) WITHOUT consuming any other event —
 *  `streamingTurn` has no `onUsage` collaborator, so the bridge lives here so
 *  token/usage recording is preserved verbatim under streaming tool exec. */
async function* teeUsage(
  config: AgentConfig,
  src: AsyncIterable<StreamEvent>,
): AsyncIterable<StreamEvent> {
  for await (const ev of src) {
    if (ev.type === "usage") emitUsage(config, ev)
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

/**
 * Consume one LLM stream WITH interleaved tool execution (SOTA++ streaming
 * tool exec, ADR-0011). Delegates the stream/dispatch interleaving + ordering
 * + head-of-line barrier + abort/tombstone handling to the pure
 * `streamingTurn` engine; this seam only binds the loop's collaborators
 * (registry, dispatch, stream emits, metrics, the session auto-classifier) and
 * preserves the exact recovery contract: a thrown stream error returns
 * `{ error }` so `decideOnStreamError` + bounded backoff still drive same-turn
 * retry without consuming a `maxTurns` slot. The early dispatches are pure
 * latency win — when the recovery decision is `nudge`/`completed`/`compact`
 * the (read-only, since only concurrency-safe calls start early) results are
 * simply discarded, exactly as the pre-SOTA++ path discarded un-dispatched
 * calls.
 */
const streamConsume = async (
  config: AgentConfig,
  messages: Message[],
  specs: ReturnType<AgentConfig["registry"]["specs"]>,
  system: SystemPromptInput,
  recorder: AgentRecorder | undefined,
  classifier: AutoModeClassifier | undefined,
): Promise<StreamConsumeResult> => {
  // RFC-0002 §5.2/§9/§11 — `llm_request` marker, emitted IMMEDIATELY BEFORE
  // this turn's model stream is opened/consumed (the same point `llm_usage`
  // is later teed from the provider `usage` event). The recorder gives both
  // the SAME per-turn llm span so probe/§9 can pair request↔usage. Pure
  // observation: NullStream swallows it; the stream open + recovery control
  // flow below is byte-identical to the pre-emit path.
  emitLlmRequest(config)
  const stop = recorder?.llmStream()
  try {
    const outcome = await streamingTurn({
      events: teeUsage(config, config.llm.stream({ messages, system, tools: specs })),
      isConcurrencySafe: (name, input) => config.registry.isConcurrencySafe(name, input),
      dispatch: async (call) => {
        const s = recorder?.toolExec()
        try {
          const out = await dispatchTool(
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
          )
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
      },
      signal: config.signal,
    })
    if (outcome.kind === "aborted") return { aborted: true }
    return {
      message: outcome.message as AssembledMessage,
      stopReason: outcome.stopReason,
      resultBlocks: outcome.resultBlocks as AssembledMessage["content"],
    }
  } catch (e) {
    const message = e instanceof LLMError ? e.message : (e as Error).message
    return { error: e, message }
  } finally {
    stop?.()
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
): Promise<string | undefined> => {
  if (!config.store) return undefined
  const lastUser = [...wm.snapshot()].reverse().find((m) => m.role === "user")
  const queryText = lastUser?.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join(" ")
    .trim()
  const block = await recallContext(
    {
      store: config.store,
      ...(config.embedder ? { embedder: config.embedder } : {}),
      ...(recorder ? { onStats: (s) => recorder.memoryRecall(s) } : {}),
    },
    queryText || undefined,
    {
      limit: config.memory?.recallLimit ?? 5,
      ...(config.memory?.recallTiers ? { tiers: config.memory.recallTiers } : {}),
    },
  )
  return block ?? undefined
}

/** Proactive top-of-turn compaction when compaction config is present. No-op
 *  (same array reference) otherwise, so unconfigured suites are unaffected. */
const maybeCompact = async (
  config: AgentConfig,
  system: SystemPromptInput,
  wm: WorkingMemory<Message>,
  breaker: CompactionBreaker | undefined,
): Promise<void> => {
  if (!config.compaction) return
  const snapshot = [...wm.snapshot()]
  const before = estimateTokens(snapshot)
  const result = await compactIfNeeded({
    messages: snapshot,
    llm: config.llm,
    system,
    ...(config.compaction.thresholdTokens !== undefined
      ? { thresholdTokens: config.compaction.thresholdTokens }
      : {}),
    ...(config.compaction.keepRecentTurns !== undefined
      ? { keepRecentTurns: config.compaction.keepRecentTurns }
      : {}),
  })
  if (result.compacted) {
    // SOTA++ Tier 0 (ADR-0011): feed the thrash counter. A proactive compact
    // that fails to meaningfully shrink is a no-progress strike.
    breaker?.recordProactive(before, estimateTokens(result.messages))
    wm.replace(result.messages)
  }
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
): PersistDeps => ({
  // biome-ignore lint/style/noNonNullAssertion: call site guards `config.store`
  store: config.store!,
  llm: config.llm,
  ...(config.embedder ? { embedder: config.embedder } : {}),
  ...(config.memory?.distill !== undefined ? { distill: config.memory.distill } : {}),
  ...(config.memory?.consolidate !== undefined ? { consolidate: config.memory.consolidate } : {}),
  ...(config.memory?.evictionCaps ? { evictionCaps: config.memory.evictionCaps } : {}),
  ...(recorder ? { onStats: (s) => recorder.memoryPersist(s) } : {}),
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
/** Rebuild the per-attempt request context: memory recall, proactive
 *  compaction (mutates `messages` in place), then the buildTurnContext SEAM. */
const prepareTurnContext = async (
  config: AgentConfig,
  wm: WorkingMemory<Message>,
  recorder: AgentRecorder | undefined,
  breaker: CompactionBreaker | undefined,
): Promise<ReturnType<typeof buildTurnContext>> => {
  const memoryContext = await resolveMemoryContext(config, wm, recorder)
  await maybeCompact(config, staticSystemFor(config), wm, breaker)
  return buildTurnContext({
    baseMessages: [...wm.snapshot()],
    cwd: config.cwd,
    planMode: config.planMode ?? false,
    system: config.system,
    ...(memoryContext !== undefined ? { memoryContext } : {}),
  })
}

type Step = { done: false } | { done: true; result: TurnResult }
const CONTINUE: Step = { done: false }

/** Apply one decided {@link RecoveryAction}. Returns `{done:false}` to
 *  re-enter the SAME turn (after mutating `messages`/sleeping/compacting) or
 *  `{done:true}` with the terminal {@link TurnResult}. The `proceed` branch
 *  uses the tool_result blocks `streamingTurn` already produced (dispatch
 *  happened DURING the stream) instead of dispatching here. */
const applyAction = async (
  config: AgentConfig,
  action: RecoveryAction,
  result: StreamSuccess | { error: unknown; message: string },
  wm: WorkingMemory<Message>,
  ctxSystem: SystemPromptInput,
  breaker: CompactionBreaker | undefined,
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
    // SOTA++ Tier 0 (ADR-0011): trip the breaker BEFORE another reactive
    // squeeze so a compact↔PTL thrash spin aborts with a clear reason
    // instead of looping until maxTurns / a provider 400.
    const verdict = breaker?.check()
    if (verdict?.abort) return { done: true, result: { kind: "error", reason: verdict.reason } }
    const snapshot = [...wm.snapshot()]
    const before = estimateTokens(snapshot)
    const compacted = await reactiveCompact({
      messages: snapshot,
      llm: config.llm,
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
): Promise<TurnResult> => {
  // Bounded: every iteration either returns or strictly consumes a SAME-TURN
  // budget (decideOn* mutate `rec`), so the loop cannot spin forever.
  for (;;) {
    if (config.signal.aborted) return { kind: "aborted" }

    // Rebuilt every attempt: ctx.messages = canonical history + one ephemeral
    // reminder tail (the per-turn dynamic context, never persisted).
    const ctx = await prepareTurnContext(config, wm, recorder, breaker)
    const result = await streamConsume(
      config,
      ctx.messages,
      specs,
      ctx.system,
      recorder,
      classifier,
    )
    if ("aborted" in result) return { kind: "aborted" }

    const action =
      "error" in result
        ? decideOnStreamError(result.error, result.message, rec)
        : decideOnAssembled(result.stopReason, result.message, rec)

    const step = await applyAction(config, action, result, wm, ctx.system, breaker)
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
 *  enumerator) so SOTA++ extra tools can be merged into a fresh registry. */
const registryTools = (r: AgentConfig["registry"]): Tool[] =>
  r
    .specs()
    .map((s) => r.get(s.name))
    .filter((t): t is Tool => t !== undefined)

/** Fold SOTA++ extra tools (subagent/skill) into a fresh registry. With none
 *  (`extraTools` empty) returns the SAME config by identity, so the loop stays
 *  byte-for-byte identical to the pre-SOTA++ path. */
const buildEffectiveConfig = (config: AgentConfig, extraTools: Tool[]): AgentConfig =>
  extraTools.length > 0
    ? {
        ...config,
        registry: new ToolRegistry([...registryTools(config.registry), ...extraTools]),
      }
    : config

export const runAgent = async (config: AgentConfig): Promise<AgentOutcome> => {
  // SOTA++ Tier 1 (ADR-0011): materialize optional subsystems ONCE. With no
  // Tier-1 config `features.extraTools` is empty and `cfg === config` by
  // identity, so the loop is byte-for-byte identical to the pre-SOTA++ path.
  const features = await buildSessionFeatures(config)
  const cfg = buildEffectiveConfig(config, features.extraTools)
  const classifier = features.classifier
  const { stream } = cfg
  // Canonical in-session message buffer (RFC §6.3). Seeded from the public
  // `config.messages`; every history mutation below goes through this slice.
  const wm: WorkingMemory<Message> = createWorkingMemory<Message>(cfg.messages)
  const specs = cfg.registry.specs()
  const recorder = cfg.metrics ? new AgentRecorder(cfg.metrics) : undefined
  const sessionId = cfg.sessionId ?? "default"
  // SOTA++ Tier 0 (ADR-0011): one breaker per session. ON by default with
  // DEFAULT_COMPACTION_BREAKER_CAPS — only trips on pathological compaction
  // thrash, so configured-but-normal and unconfigured sessions are unaffected.
  const breaker = cfg.compactionBreaker?.disabled
    ? undefined
    : new CompactionBreaker(cfg.compactionBreaker?.caps)

  const finish = async (reason: StopReason, turns: number): Promise<AgentOutcome> => {
    const messages = [...wm.snapshot()]
    if (cfg.store) {
      await persistSession(buildPersistDeps(cfg, recorder), {
        sessionId,
        finalMessages: messages,
      })
    }
    recorder?.stopReason(reason)
    if (cfg.hooks) await cfg.hooks.emit({ type: "session_end", reason, turns })
    stream.emit({ type: "done", reason, turns })
    return { reason, turns, messages }
  }

  // RFC-0002 §5.2 `session_start` — emitted ONCE at run start so the trajectory
  // has a head marker (Group E maps it → kind:"session_start"). Pure
  // observation: an AgentEvent only seen when a stream/recorder is attached
  // (NullStream swallows it); it precedes nothing in the control flow.
  stream.emit({ type: "session_start" })

  if (cfg.hooks) await cfg.hooks.emit({ type: "session_start", sessionId })

  for (let turn = 1; turn <= cfg.maxTurns; turn++) {
    if (cfg.signal.aborted) return finish("aborted", turn - 1)
    // Per-turn correlation working copy (RFC-0002 §5.1/§5.4). Computed every
    // turn from a fresh shallow copy so the caller's `config.run` is NEVER
    // mutated. It deliberately feeds no control flow / emit ordering /
    // StopReason / messages — recorders correlate via their own injected
    // `ctx`; this is the loop honouring the "loop advances `turn`" contract
    // without any behavioural coupling. No downstream consumer in W-C (the
    // explicit discard documents that intent; W-D/probe read `turn` off the
    // trajectory, not via this binding).
    void stampTurn(cfg.run, turn)
    stream.emit({ type: "turn_start", turn })
    if (cfg.hooks) await cfg.hooks.emit({ type: "turn_start", turn })

    // Recovery counters are per-turn: SAME-TURN retries share & exhaust these,
    // a fresh turn starts clean. runTurn owns the SEAM (buildTurnContext) and
    // mutates `messages` (canonical history) in place.
    const result = await runTurn(cfg, wm, specs, recorder, freshRecovery(), breaker, classifier)

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
    if (result.kind === "aborted") return finish("aborted", turn - 1)
    if (result.kind === "error") {
      // Mirror the abort semantics: a turn that errored without producing a
      // productive model turn did no work, so it must not inflate the count.
      stream.emit({ type: "error", message: result.reason })
      return finish("error", turn - 1)
    }
    recorder?.turn()
    if (result.kind === "completed") return finish("completed", turn)

    // A real tool turn landed (not stuck thrashing compaction) — clear the
    // consecutive no-progress strikes (SOTA++ Tier 0, ADR-0011).
    breaker?.noteProgress()
    wm.append({ role: "user", content: result.resultBlocks })
  }

  return finish("max_turns", cfg.maxTurns)
}
