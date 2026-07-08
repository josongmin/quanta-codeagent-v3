import type { StreamEvent, ToolChoice } from "@/llm"
import { costUsd } from "@/observability"
import type { PromptPolicySnapshot, TurnPolicySnapshot } from "@/shared"
import { errMessage, logger, runtimeConfig } from "@/shared"
import type { BudgetBreach } from "../budget-ledger"
import type { CancelSubagentOutcome, ResponseQueuedReason } from "../control-op-handler"
import type { AgentRecorder } from "../metrics"
import type { RecoveryReason } from "../recovery"
import type { AgentConfig } from "../types"
import type { TurnWorkMetricsCollector } from "../work-metrics-collector"

// Re-exported from the dispatch SSOT so the loop's consumers (turn-loop,
// stream-consume) keep a stable `./emit-helpers` import while the predicate has
// a single definition shared with the sync/streaming dispatch paths.
export { isSessionApprovalRequiredError } from "../dispatch-helpers"

/** The priced context one usage event is fanned out to every downstream sink
 *  with. `eventCostUsd` is priced ONCE here (pricing SSOT) and shared so no sink
 *  re-prices; `null` ⇒ unpriced model (cost tick skipped). */
type UsageSinkCtx = {
  readonly config: AgentConfig
  readonly ev: Extract<StreamEvent, { type: "usage" }>
  readonly recorder: AgentRecorder | undefined
  readonly collector: TurnWorkMetricsCollector | undefined
  readonly taskSpend: { tokens: number } | undefined
  readonly eventCostUsd: number | null
  /** ALBB-21 — a single-slot handoff between the L4 record sink (producer) and
   *  the budget-breach advisory sink (consumer). The record sink writes the
   *  ledger's returned breach list here; the later advisory sink reads it and
   *  emits one `budget_breach` AgentEvent per breach. The object reference is
   *  `readonly` but its slot is mutable — the only stateful handoff between two
   *  sinks (they run in array order, producer strictly before consumer). Empty
   *  by default: no ledger / no breach ⇒ stays `[]` ⇒ the advisory sink is a
   *  no-op (default-OFF byte-identical). */
  readonly breachSlot: { breaches: ReadonlyArray<BudgetBreach> }
}

/** One usage-event consumer. Adding a downstream (a new meter, ledger, gauge)
 *  is appending a sink HERE — never surgery on the {@link emitUsage} hot body
 *  (OCP). Each sink is individually a no-op when its optional collaborator is
 *  unwired, so ordering is observable-independent; the array order mirrors the
 *  historical inline order for byte-identity. */
type UsageSink = (c: UsageSinkCtx) => void

const USAGE_SINKS: readonly UsageSink[] = [
  // Surface stream event — the `/context` gauge & usage readouts.
  ({ config, ev }) =>
    config.stream.emit({
      type: "usage",
      inputTokens: ev.inputTokens,
      outputTokens: ev.outputTokens,
      model: ev.model,
      ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
      ...(ev.cacheCreationTokens !== undefined
        ? { cacheCreationTokens: ev.cacheCreationTokens }
        : {}),
      // S3 (jul-03) — forward the OpenAI-Responses reasoning-token split so
      // surface sinks can render it. `!== undefined` (not truthiness) keeps an
      // explicit `0` split; omission stays omitted (Anthropic byte-identical).
      ...(ev.reasoningTokens !== undefined ? { reasoningTokens: ev.reasoningTokens } : {}),
    }),
  // Run recorder token tally.
  ({ recorder, ev }) => recorder?.tokensUsed(ev.inputTokens, ev.outputTokens, ev.cacheReadTokens),
  // Autonomous-safety cost cap (L0): tick tokens AND the pre-priced USD into the
  // per-run meter (the same single seam). Unpriced model ⇒ skip the cost tick so
  // the cap stays a no-op rather than billing $0 falsely. `maxCostUsd` is only
  // set on autonomous modes (batch/daemon/ci-bot); interactive accrues but never
  // gates (human-paced, by design).
  ({ config, ev, eventCostUsd }) => {
    config.budgetMeter?.tick("input_tokens", ev.inputTokens)
    config.budgetMeter?.tick("output_tokens", ev.outputTokens)
    if (eventCostUsd !== null) config.budgetMeter?.tick("cost_usd", eventCostUsd)
  },
  // L4 cross-run cost ledger (default-OFF: no `budgetLedger` ⇒ no-op). Maps the
  // provider's cache-CREATION tokens onto the ledger's cache-write bucket (which
  // the ledger bills and `costUsd` does not); same SSOT rate card so meter and
  // ledger never disagree. Hard breach *stops* the run at the turn epilogue via
  // `ledgerHardBreachCondition`; the returned breach list is captured here so the
  // ADVISORY sink below can surface EVERY crossed cap (soft AND hard) as a
  // `budget_breach` event without re-recording. Return dropped ⇒ no advisory
  // (the wired-but-inert trap this fix closes).
  ({ config, ev, breachSlot }) => {
    const result = config.budgetLedger?.record({
      model: ev.model,
      inputTokens: ev.inputTokens,
      outputTokens: ev.outputTokens,
      ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
      ...(ev.cacheCreationTokens !== undefined ? { cacheWriteTokens: ev.cacheCreationTokens } : {}),
      sessionId: config.sessionId ?? "",
      at: Date.now(),
    })
    if (result !== undefined) breachSlot.breaches = result.breaches
  },
  // Turn work-metrics collector.
  ({ collector, ev }) =>
    collector?.recordUsage({
      tokensInput: ev.inputTokens,
      tokensOutput: ev.outputTokens,
      ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
    }),
  // Per-task spend accumulator (guards against NaN / negative token counts).
  ({ taskSpend, ev }) => {
    if (taskSpend === undefined) return
    const inTok = Number.isFinite(ev.inputTokens) && ev.inputTokens > 0 ? ev.inputTokens : 0
    const outTok = Number.isFinite(ev.outputTokens) && ev.outputTokens > 0 ? ev.outputTokens : 0
    taskSpend.tokens += inTok + outTok
  },
  // Prompt-cache hit/write observer.
  ({ config, ev }) =>
    config.promptCacheObserver?.record({
      model: ev.model,
      sessionId: config.sessionId ?? "",
      turnIndex: 0,
      atMs: Date.now(),
      inputTokens: ev.inputTokens,
      cacheCreationTokens: ev.cacheCreationTokens ?? 0,
      cacheReadTokens: ev.cacheReadTokens ?? 0,
      outputTokens: ev.outputTokens,
    }),
  // ALBB-21 advisory: surface each crossed budget cap as ONE non-fatal
  // `budget_breach` AgentEvent. Consumes the `RecordResult.breaches` the L4
  // record sink captured above (deterministic order, 0..4 entries). SOFT
  // never stops the run (HARD *stop* is `ledgerHardBreachCondition`'s job);
  // this is pure observability, mirroring the Claude Code / Codex cost-warning
  // banner. `severity`/`scope`/`observed`/`limit` are derived VERBATIM from the
  // typed `BudgetBreach` (no invented threshold). Empty ⇒ no emit (default-OFF
  // byte-identical: no ledger or no crossing leaves the slot `[]`).
  ({ config, breachSlot }) => {
    for (const breach of breachSlot.breaches) {
      config.stream.emit({
        type: "budget_breach",
        severity: breach.kind.endsWith("-hard") ? "hard" : "soft",
        scope: breach.scope,
        observed: breach.observed,
        limit: breach.limit,
      })
    }
  },
]

export const emitUsage = (
  config: AgentConfig,
  ev: Extract<StreamEvent, { type: "usage" }>,
  recorder: AgentRecorder | undefined,
  collector: TurnWorkMetricsCollector | undefined,
  taskSpend: { tokens: number } | undefined,
): void => {
  const ctx: UsageSinkCtx = {
    config,
    ev,
    recorder,
    collector,
    taskSpend,
    // Priced once via the pricing SSOT (the only place `ev.model` is available).
    eventCostUsd: costUsd(ev.model, ev.inputTokens, ev.outputTokens, ev.cacheReadTokens ?? 0),
    // ALBB-21 — fresh per-event breach handoff slot (record sink writes, advisory
    // sink reads). Starts empty so the advisory sink is a no-op when no cap crosses.
    breachSlot: { breaches: [] },
  }
  for (const sink of USAGE_SINKS) sink(ctx)
}

export const emitRecovery = (
  config: AgentConfig,
  reason: RecoveryReason,
  detail?: string,
): void => {
  config.stream.emit({
    type: "recovery",
    reason,
    ...(detail !== undefined ? { detail } : {}),
  })
}

export const configuredModel = (llm: AgentConfig["llm"]): string => {
  const m = llm.model
  return m !== undefined && m !== "" ? m : "unknown"
}

/** gap GAP 3 (ADR-0505) — the model id to resolve the CONTEXT WINDOW against
 *  (compaction threshold + usage gauge). When the active turn model IS the
 *  configured base model AND the port pins a 1M window key (context-1m active),
 *  resolve the window against that `<model>-1m` key so compaction tracks the
 *  granted 1M window. A skill/sticky SWAP (active != base) or no pinned key ⇒ the
 *  active model id as-is. NEVER returned to reporting/records — those keep the
 *  real model id; this is window-resolution ONLY. */
export const resolveWindowModel = (
  llm: AgentConfig["llm"],
  activeModel: string = configuredModel(llm),
): string =>
  llm.contextWindowKey !== undefined && activeModel === configuredModel(llm)
    ? llm.contextWindowKey
    : activeModel

export const objectiveBudgetExhausted = (config: AgentConfig, threadId: string): boolean => {
  if (!runtimeConfig().objectiveBudgetEnforce) return false
  if (config.objective === undefined || threadId.length === 0) return false
  try {
    return config.objective.get(threadId)?.status === "budget_limited"
  } catch (e) {
    logger.warn(`loop.objectiveBudgetExhausted: ${errMessage(e)}`)
    return false
  }
}

export const finalizeTurnPolicy = (args: {
  readonly promptPolicy: PromptPolicySnapshot
  readonly toolChoice: ToolChoice
  readonly promptCacheKey?: string
}): TurnPolicySnapshot => ({
  ...args.promptPolicy,
  toolChoice: args.toolChoice.kind,
  ...(args.toolChoice.kind === "tool" ? { toolChoiceToolName: args.toolChoice.name } : {}),
  promptCacheKeyPresent: args.promptCacheKey !== undefined && args.promptCacheKey.length > 0,
})

export const emitLlmRequest = (config: AgentConfig, policy: TurnPolicySnapshot): void => {
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

export const emitLlmContinuation = (
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

export const emitSubagentCancel = (
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

export const emitResponseQueued = (
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

export const emitInterrupted = (
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
