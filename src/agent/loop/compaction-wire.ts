import type { Message, SystemPromptInput } from "@/llm"
import type { CompactionEventVariant } from "@/memory/typed-event"
import { errMessage, logger, runtimeConfig } from "@/shared"
import {
  type BgSummaryPayload,
  compactIfNeeded,
  estimateTokens,
  resolveCompactionLimitTokens,
} from "../compaction"
import type { BackgroundSummarizationController } from "../compaction/index"
import type { BreakerVerdict, CompactionBreaker } from "../compaction-breaker"
import { appendSummary, type ConversationSummaryArchive } from "../conversation-summary-archive"
import { buildPostCompactEmit, buildPreCompactHook } from "../loop-helpers"
import { buildTurnContext } from "../prompt"
import type { AgentConfig } from "../types"
import { emitRecovery, objectiveBudgetExhausted } from "./emit-helpers"

export const maybeCompact = async (
  config: AgentConfig,
  system: SystemPromptInput,
  wm: import("@/memory").WorkingMemory<Message>,
  breaker: CompactionBreaker | undefined,
  archive: ConversationSummaryArchive | undefined,
  turn: number,
  bgController: BackgroundSummarizationController<BgSummaryPayload> | undefined,
  resetClassifier: (classifier: AgentConfig["effortClassifier"]) => void,
): Promise<BreakerVerdict> => {
  if (!config.compaction) return { abort: false }
  const verdict = breaker?.check() ?? { abort: false }
  if (verdict.abort) {
    emitRecovery(config, "compact", "breaker-disabled")
    return verdict
  }
  const onPreCompact = config.onPreCompact
  const snapshot = [...wm.snapshot()]
  const before = estimateTokens(snapshot)
  const bgLimitTokens = resolveCompactionLimitTokens(config.compaction?.thresholdTokens)
  const borrowed =
    bgController !== undefined
      ? await bgController.reconcileAtTurnBoundary({
          usedTokens: before,
          limitTokens: bgLimitTokens,
        })
      : undefined
  const turnId = config.run?.turn !== undefined ? `t${config.run.turn}` : `t${turn}`
  const fromTurnId = archive?.summaries.at(-1)?.toTurnId ?? "t0"
  let result: Awaited<ReturnType<typeof compactIfNeeded>>
  const isFirstCompaction = archive !== undefined && archive.summaries.length === 0
  const preCompactHook = buildPreCompactHook(config.hooks)
  const postCompactEmit = buildPostCompactEmit(config.hooks, config.sessionId ?? "")
  const objectiveSetNextActions = config.objective
    ? (tid: string, actions: readonly string[]): void => {
        try {
          if (objectiveBudgetExhausted(config, tid)) return
          config.objective?.setNextActions(tid, actions)
        } catch (e) {
          logger.warn(`loop.objectiveSetNextActions: ${errMessage(e)}`)
        }
      }
    : undefined
  try {
    if (borrowed?.kind === "install") {
      const installed = [...borrowed.summary]
      result = {
        compacted: true,
        messages: installed,
        summaryTokens: estimateTokens(installed.slice(0, 1)),
      }
    } else {
      result = await compactIfNeeded({
        messages: snapshot,
        llm: config.compaction.summarizerLlm ?? config.llm,
        system,
        isFirstCompaction,
        ...(config.compaction.thresholdTokens !== undefined
          ? { thresholdTokens: config.compaction.thresholdTokens }
          : {}),
        ...(config.compaction.keepRecentTurns !== undefined
          ? { keepRecentTurns: config.compaction.keepRecentTurns }
          : {}),
        ...(postCompactEmit !== undefined ? { postCompactEmit } : {}),
        ...(objectiveSetNextActions !== undefined ? { objectiveSetNextActions } : {}),
        ...(postCompactEmit !== undefined || objectiveSetNextActions !== undefined
          ? { recoveryReason: "token_budget_exceeded" as const }
          : {}),
        ...(config.sessionId !== undefined && config.sessionId.length > 0
          ? { threadId: config.sessionId }
          : {}),
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
    }
  } catch (e) {
    const message = errMessage(e)
    config.stream.emit({
      type: "error",
      message: `proactive compaction failed: ${message}`,
    })
    return { abort: false }
  }
  if (result.compacted) {
    emitRecovery(config, "compact", "proactive")
    const after = estimateTokens(result.messages)
    breaker?.recordProactive(before, after)
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
    resetClassifier(config.effortClassifier)
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
  } else if (result.reason === "no_boundary") {
    breaker?.recordProactive(before, before)
  }
  bgController?.maybeStart({
    usedTokens: estimateTokens([...wm.snapshot()]),
    limitTokens: bgLimitTokens,
  })
  return { abort: false }
}

export const SUMMARY_WRAPPER_RE = /^<conversation summary>\n/

export const extractSummaryText = (msg: Message | undefined): string => {
  if (!msg || msg.content.length === 0) return ""
  const first = msg.content[0]
  if (!first || first.type !== "text") return ""
  return first.text.replace(SUMMARY_WRAPPER_RE, "")
}

export const staticSystemFor = (config: AgentConfig): SystemPromptInput =>
  buildTurnContext({
    baseMessages: [],
    cwd: config.cwd,
    planMode: config.planMode ?? false,
    system: config.system,
    untrustedEnvelope: runtimeConfig().untrustedEnvelope,
  }).system

export const emitCompactionEvent = (config: AgentConfig, event: CompactionEventVariant): void => {
  if (config.compactionEventEmit === undefined) return
  try {
    config.compactionEventEmit(event)
  } catch {
    // Pure observability.
  }
}

export const resolveContextEventsForTurn = (
  config: AgentConfig,
): readonly import("../context-change").ContextEvent[] => {
  if (config.contextEventsForTurn === undefined) return []
  try {
    return config.contextEventsForTurn()
  } catch {
    return []
  }
}
