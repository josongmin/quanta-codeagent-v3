import type { StreamEvent, ToolChoice } from "@/llm"
import { costUsd } from "@/observability"
import type { PromptPolicySnapshot, TurnPolicySnapshot } from "@/shared"
import { errMessage, logger, runtimeConfig } from "@/shared"
import type { CancelSubagentOutcome, ResponseQueuedReason } from "../control-op-handler"
import type { AgentRecorder } from "../metrics"
import type { RecoveryReason } from "../recovery"
import type { AgentConfig } from "../types"
import type { TurnWorkMetricsCollector } from "../work-metrics-collector"

export const emitUsage = (
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
    ...(ev.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: ev.cacheCreationTokens }
      : {}),
  })
  recorder?.tokensUsed(ev.inputTokens, ev.outputTokens, ev.cacheReadTokens)
  config.budgetMeter?.tick("input_tokens", ev.inputTokens)
  config.budgetMeter?.tick("output_tokens", ev.outputTokens)
  // Autonomous-safety cost cap (L0): price THIS event via the pricing SSOT
  // using the per-event model id (the only place `ev.model` is available) and
  // accumulate USD into the meter — the same single seam that ticks tokens. An
  // unpriced model yields `null` (cost is best-effort evidence, never
  // authoritative — `@/observability` pricing doctrine) ⇒ skip the tick so the
  // cost cap stays a no-op rather than billing $0 falsely. `maxCostUsd` is only
  // set on autonomous modes (batch/daemon/ci-bot); interactive has no dial so
  // this accrues but never gates (human-paced, by design).
  const eventCostUsd = costUsd(ev.model, ev.inputTokens, ev.outputTokens, ev.cacheReadTokens ?? 0)
  if (eventCostUsd !== null) config.budgetMeter?.tick("cost_usd", eventCostUsd)
  // L4 cross-run cost ledger (default-OFF: no `budgetLedger` slot ⇒ no-op,
  // byte-identical). Records this event into the persistent session/daily
  // ledger from the SAME single seam, mapping the provider's cache-CREATION
  // tokens onto the ledger's cache-write bucket (which the ledger bills and
  // `costUsd` does not). The ledger prices from the same SSOT rate card, so the
  // meter (per-run) and ledger (cross-run) never disagree. A hard breach is
  // surfaced to the loop via `ledger.hardBreach()` at the turn epilogue.
  config.budgetLedger?.record({
    model: ev.model,
    inputTokens: ev.inputTokens,
    outputTokens: ev.outputTokens,
    ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
    ...(ev.cacheCreationTokens !== undefined ? { cacheWriteTokens: ev.cacheCreationTokens } : {}),
    sessionId: config.sessionId ?? "",
    at: Date.now(),
  })
  collector?.recordUsage({
    tokensInput: ev.inputTokens,
    tokensOutput: ev.outputTokens,
    ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
  })
  if (taskSpend !== undefined) {
    const inTok = Number.isFinite(ev.inputTokens) && ev.inputTokens > 0 ? ev.inputTokens : 0
    const outTok = Number.isFinite(ev.outputTokens) && ev.outputTokens > 0 ? ev.outputTokens : 0
    taskSpend.tokens += inTok + outTok
  }
  config.promptCacheObserver?.record({
    model: ev.model,
    sessionId: config.sessionId ?? "",
    turnIndex: 0,
    atMs: Date.now(),
    inputTokens: ev.inputTokens,
    cacheCreationTokens: ev.cacheCreationTokens ?? 0,
    cacheReadTokens: ev.cacheReadTokens ?? 0,
    outputTokens: ev.outputTokens,
  })
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

export const isSessionApprovalRequiredError = (error: unknown): boolean => {
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
