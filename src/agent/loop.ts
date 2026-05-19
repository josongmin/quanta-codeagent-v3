import { assembleFromEvents, type Message, type SystemPromptInput } from "@/llm"
import { createWorkingMemory, type WorkingMemory } from "@/memory"
import { LLMError } from "@/shared"
import { compactIfNeeded, reactiveCompact } from "./compaction"
import { dispatchTool } from "./dispatch"
import { type PersistDeps, persistSession, recallContext } from "./memory"
import { AgentRecorder } from "./metrics"
import { buildTurnContext } from "./prompt"
import { backoffDelayMs, classifyLLMError } from "./retry"
import type { AgentConfig, AgentOutcome, StopReason } from "./types"

/** Bounded per-turn recovery budgets. These cap SAME-TURN retries so a
 *  pathological provider can never spin the loop forever; once exhausted the
 *  loop degrades gracefully (finish / accept-partial) rather than hanging. */
const MAX_TURN_STREAM_RETRIES = 3
const MAX_OUTPUT_CONTINUES = 3
const MAX_MALFORMED_RETRIES = 1
const MAX_CONSECUTIVE_EMPTIES = 2

/**
 * Minimal ReAct loop. One `while` over turns; each turn = one LLM stream then
 * (if any) tool dispatch. No transition state machine, no compaction, no
 * hooks — those are the v2 weight this project exists to avoid (RFC §1.2).
 *
 * Tool dispatch uses per-input concurrency batching (RFC §6.2): the tool_use
 * list is walked in order and split into maximal runs of consecutive calls
 * that are all `isConcurrencySafe` (pure reads), which run together via
 * `Promise.all`. Any non-safe call (write/edit/bash, or anything that fails
 * validation) breaks the run and executes alone. This parallelizes safe
 * reads while never overlapping side-effecting work, and the appended
 * tool_result blocks stay in the model's original call order.
 */
type AssembledMessage = ReturnType<typeof assembleFromEvents>["message"]
type ToolCall = Extract<AssembledMessage["content"][number], { type: "tool_use" }>

/** Split calls into ordered batches: a batch is either one non-concurrency-
 *  safe call, or a maximal run of consecutive concurrency-safe calls. */
const planBatches = (config: AgentConfig, calls: ToolCall[]): ToolCall[][] => {
  const batches: ToolCall[][] = []
  let safeRun: ToolCall[] = []
  const flush = (): void => {
    if (safeRun.length > 0) {
      batches.push(safeRun)
      safeRun = []
    }
  }
  for (const call of calls) {
    if (config.registry.isConcurrencySafe(call.name, call.input)) {
      safeRun.push(call)
    } else {
      flush()
      batches.push([call])
    }
  }
  flush()
  return batches
}

/** Run one batch. Emits every `tool_call` first (deterministic), runs the
 *  calls (concurrently when >1), streams progress as it arrives, then emits
 *  `tool_result` and returns the result blocks in original call order. */
const runBatch = async (
  config: AgentConfig,
  batch: ToolCall[],
  recorder: AgentRecorder | undefined,
): Promise<AssembledMessage["content"]> => {
  for (const call of batch) {
    config.stream.emit({ type: "tool_call", id: call.id, name: call.name, input: call.input })
    recorder?.toolCall(call.name)
  }
  const dispatched = await Promise.all(
    batch.map(async (call) => {
      const stop = recorder?.toolExec()
      try {
        return await dispatchTool(call, config, config.permission, (message) =>
          config.stream.emit({ type: "tool_progress", id: call.id, name: call.name, message }),
        )
      } finally {
        stop?.()
      }
    }),
  )
  const blocks: AssembledMessage["content"] = []
  for (let i = 0; i < batch.length; i++) {
    const call = batch[i] as ToolCall
    const { block, ok, preview } = dispatched[i] as Awaited<ReturnType<typeof dispatchTool>>
    config.stream.emit({ type: "tool_result", id: call.id, name: call.name, ok, preview })
    blocks.push(block)
  }
  return blocks
}

/** Consume one LLM stream, emitting assistant_text deltas. Returns the
 *  assembled message + normalized stop reason, or `{ error }` (carrying the
 *  raw thrown value so the loop can classify it) if the stream threw. */
const consumeTurnStream = async (
  config: AgentConfig,
  messages: Message[],
  specs: ReturnType<AgentConfig["registry"]["specs"]>,
  system: SystemPromptInput,
  recorder: AgentRecorder | undefined,
): Promise<
  { message: AssembledMessage; stopReason: string } | { error: unknown; message: string }
> => {
  const events: Parameters<typeof assembleFromEvents>[0] = []
  const stop = recorder?.llmStream()
  try {
    for await (const ev of config.llm.stream({
      messages,
      system,
      tools: specs,
    })) {
      events.push(ev)
      if (ev.type === "text_delta") {
        config.stream.emit({ type: "assistant_text", delta: ev.delta })
      }
    }
  } catch (e) {
    const message = e instanceof LLMError ? e.message : (e as Error).message
    return { error: e, message }
  } finally {
    stop?.()
  }
  const { message, stopReason } = assembleFromEvents(events)
  return { message, stopReason }
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

/** Dispatch the turn's tool calls in concurrency batches. Result blocks stay
 *  in original call order. Returns `{ aborted: true }` if the signal tripped
 *  between batches. */
const dispatchTurnTools = async (
  config: AgentConfig,
  toolCalls: ToolCall[],
  recorder: AgentRecorder | undefined,
): Promise<{ resultBlocks: AssembledMessage["content"] } | { aborted: true }> => {
  const resultBlocks: AssembledMessage["content"] = []
  for (const batch of planBatches(config, toolCalls)) {
    if (config.signal.aborted) return { aborted: true }
    const blocks = await runBatch(config, batch, recorder)
    resultBlocks.push(...blocks)
  }
  return { resultBlocks }
}

/** Recalled long-term memory text for this session, or `undefined` when no
 *  store is configured or nothing relevant is found. The user's last text
 *  seeds the query. Folded into the turn context by `buildTurnContext`, not
 *  spliced into the system string here (that splicing is the seam's job). */
const resolveMemoryContext = async (
  config: AgentConfig,
  wm: WorkingMemory<Message>,
): Promise<string | undefined> => {
  if (!config.store) return undefined
  const lastUser = [...wm.snapshot()].reverse().find((m) => m.role === "user")
  const queryText = lastUser?.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join(" ")
    .trim()
  const block = await recallContext(
    { store: config.store, ...(config.embedder ? { embedder: config.embedder } : {}) },
    queryText || undefined,
    { limit: config.memory?.recallLimit ?? 5 },
  )
  return block ?? undefined
}

/** Proactive top-of-turn compaction when compaction config is present. No-op
 *  (same array reference) otherwise, so unconfigured suites are unaffected. */
const maybeCompact = async (
  config: AgentConfig,
  system: SystemPromptInput,
  wm: WorkingMemory<Message>,
): Promise<void> => {
  if (!config.compaction) return
  const result = await compactIfNeeded({
    messages: [...wm.snapshot()],
    llm: config.llm,
    system,
    ...(config.compaction.thresholdTokens !== undefined
      ? { thresholdTokens: config.compaction.thresholdTokens }
      : {}),
    ...(config.compaction.keepRecentTurns !== undefined
      ? { keepRecentTurns: config.compaction.keepRecentTurns }
      : {}),
  })
  if (result.compacted) wm.replace(result.messages)
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
const buildPersistDeps = (config: AgentConfig): PersistDeps => ({
  // biome-ignore lint/style/noNonNullAssertion: call site guards `config.store`
  store: config.store!,
  llm: config.llm,
  ...(config.embedder ? { embedder: config.embedder } : {}),
  ...(config.memory?.distill !== undefined ? { distill: config.memory.distill } : {}),
  ...(config.memory?.consolidate !== undefined ? { consolidate: config.memory.consolidate } : {}),
  ...(config.memory?.evictionCaps ? { evictionCaps: config.memory.evictionCaps } : {}),
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
  | { do: "nudge"; keepMessage: boolean; text: string }
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
): Promise<ReturnType<typeof buildTurnContext>> => {
  const memoryContext = await resolveMemoryContext(config, wm)
  await maybeCompact(config, staticSystemFor(config), wm)
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
 *  `{done:true}` with the terminal {@link TurnResult}. Behaviour is identical
 *  to the previous inline branch chain — extracted only to bound complexity. */
const applyAction = async (
  config: AgentConfig,
  action: RecoveryAction,
  result: Awaited<ReturnType<typeof consumeTurnStream>>,
  wm: WorkingMemory<Message>,
  ctxSystem: SystemPromptInput,
  recorder: AgentRecorder | undefined,
): Promise<Step> => {
  if (action.do === "error") return { done: true, result: { kind: "error", reason: action.reason } }
  if (action.do === "backoff") {
    await sleep(backoffDelayMs(action.attempt), config.signal)
    return CONTINUE
  }
  if (action.do === "compact") {
    const compacted = await reactiveCompact({
      messages: [...wm.snapshot()],
      llm: config.llm,
      system: ctxSystem,
    })
    if (!compacted.ok) return { done: true, result: { kind: "error", reason: compacted.reason } }
    wm.replace(compacted.messages)
    return CONTINUE
  }
  // From here the stream succeeded: `result` carries the assembled message.
  const message = (result as { message: AssembledMessage }).message
  if (action.do === "completed") return { done: true, result: { kind: "completed", message } }
  if (action.do === "nudge") {
    if (action.keepMessage) wm.append(message)
    wm.append(metaUser(action.text))
    return CONTINUE
  }
  // action.do === "proceed"
  wm.append(message)
  const toolCalls = message.content.filter((b) => b.type === "tool_use")
  if (toolCalls.length === 0) return { done: true, result: { kind: "completed", message } }
  const dispatched = await dispatchTurnTools(config, toolCalls, recorder)
  if ("aborted" in dispatched) return { done: true, result: { kind: "aborted" } }
  return { done: true, result: { kind: "tools", message, resultBlocks: dispatched.resultBlocks } }
}

const runTurn = async (
  config: AgentConfig,
  wm: WorkingMemory<Message>,
  specs: ReturnType<AgentConfig["registry"]["specs"]>,
  recorder: AgentRecorder | undefined,
  rec: RecoveryState,
): Promise<TurnResult> => {
  // Bounded: every iteration either returns or strictly consumes a SAME-TURN
  // budget (decideOn* mutate `rec`), so the loop cannot spin forever.
  for (;;) {
    if (config.signal.aborted) return { kind: "aborted" }

    // Rebuilt every attempt: ctx.messages = canonical history + one ephemeral
    // reminder tail (the per-turn dynamic context, never persisted).
    const ctx = await prepareTurnContext(config, wm)
    const result = await consumeTurnStream(config, ctx.messages, specs, ctx.system, recorder)

    const action =
      "error" in result
        ? decideOnStreamError(result.error, result.message, rec)
        : decideOnAssembled(result.stopReason, result.message, rec)

    const step = await applyAction(config, action, result, wm, ctx.system, recorder)
    if (step.done) return step.result
  }
}

export const runAgent = async (config: AgentConfig): Promise<AgentOutcome> => {
  const { stream, registry } = config
  // Canonical in-session message buffer (RFC §6.3). Seeded from the public
  // `config.messages`; every history mutation below goes through this slice.
  const wm: WorkingMemory<Message> = createWorkingMemory<Message>(config.messages)
  const specs = registry.specs()
  const recorder = config.metrics ? new AgentRecorder(config.metrics) : undefined
  const sessionId = config.sessionId ?? "default"

  const finish = async (reason: StopReason, turns: number): Promise<AgentOutcome> => {
    const messages = [...wm.snapshot()]
    if (config.store) {
      await persistSession(buildPersistDeps(config), { sessionId, finalMessages: messages })
    }
    recorder?.stopReason(reason)
    if (config.hooks) await config.hooks.emit({ type: "session_end", reason, turns })
    stream.emit({ type: "done", reason, turns })
    return { reason, turns, messages }
  }

  if (config.hooks) await config.hooks.emit({ type: "session_start", sessionId })

  for (let turn = 1; turn <= config.maxTurns; turn++) {
    if (config.signal.aborted) return finish("aborted", turn - 1)
    stream.emit({ type: "turn_start", turn })
    recorder?.turn()
    if (config.hooks) await config.hooks.emit({ type: "turn_start", turn })

    // Recovery counters are per-turn: SAME-TURN retries share & exhaust these,
    // a fresh turn starts clean. runTurn owns the SEAM (buildTurnContext) and
    // mutates `messages` (canonical history) in place.
    const result = await runTurn(config, wm, specs, recorder, freshRecovery())

    if (result.kind === "aborted") return finish("aborted", turn - 1)
    if (result.kind === "error") {
      stream.emit({ type: "error", message: result.reason })
      return finish("error", turn)
    }
    if (result.kind === "completed") return finish("completed", turn)

    wm.append({ role: "user", content: result.resultBlocks })
  }

  return finish("max_turns", config.maxTurns)
}
