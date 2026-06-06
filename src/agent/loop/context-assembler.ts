import type { Message } from "@/llm"
import type { WorkingMemory } from "@/memory"
import { errMessage, runtimeConfig } from "@/shared"
import type { TaskBudget } from "../budget"
import type { BgSummaryPayload } from "../compaction"
import type { BackgroundSummarizationController } from "../compaction/index"
import type { BreakerVerdict, CompactionBreaker } from "../compaction-breaker"
import type { ConversationSummaryArchive } from "../conversation-summary-archive"
import type { HookPromptInject } from "../hooks"
import { renderIdeContext } from "../ide-context"
import {
  augmentActiveSkillsWithPlugin,
  reconcileSkillMcpDepsForTurn,
  resolvePluginActivationForTurn,
} from "../loop-activation-hook"
import { recallContext } from "../memory"
import type { AgentRecorder } from "../metrics"
import { buildTurnContext } from "../prompt"
import type { AgentConfig, MemoryCitation } from "../types"
import type { WorkingStateSession } from "../working-state"
import { maybeCompact, resolveContextEventsForTurn, staticSystemFor } from "./compaction-wire"
import { configuredModel } from "./emit-helpers"

export const resolveMemoryContext = async (
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
  try {
    const block = await recallContext(
      {
        store: config.store,
        ...(config.embedder ? { embedder: config.embedder } : {}),
        ...(recorder ? { onStats: (s) => recorder.memoryRecall(s) } : {}),
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

export const resolveMentionInjectionMessages = async (
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

export const latestUserTextFromWm = (wm: WorkingMemory<Message>): string | undefined => {
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

export const observeEffortClassifierPrompt = (
  classifier: AgentConfig["effortClassifier"],
  text: string | undefined,
): void => {
  if (classifier === undefined || text === undefined || text.length === 0) return
  try {
    classifier.onUserPrompt(text)
  } catch {
    // Advisory only.
  }
}

export const resetEffortClassifier = (classifier: AgentConfig["effortClassifier"]): void => {
  if (classifier === undefined) return
  try {
    classifier.reset()
  } catch {
    // Advisory only.
  }
}

export const injectIdeContext = async (
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
    const newContent = [...m.content]
    newContent[idx] = { ...tb, text: `${block}\n\n${tb.text}` }
    messages[i] = { ...m, content: newContent }
    break
  }
  return ctx
}

export const injectRedactionBanner = (
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

export const resolveTaskBudgetForTurn = (
  config: AgentConfig,
  taskSpend: { tokens: number } | undefined,
): TaskBudget | undefined =>
  config.taskBudget !== undefined
    ? { tokens: config.taskBudget.tokens, spent: taskSpend?.tokens ?? 0 }
    : undefined

export const prepareTurnContext = async (
  config: AgentConfig,
  wm: WorkingMemory<Message>,
  recorder: AgentRecorder | undefined,
  breaker: CompactionBreaker | undefined,
  activeSkills: { name: string; description: string; rawDependencies?: unknown }[] | undefined,
  workingState: WorkingStateSession | undefined,
  archive: ConversationSummaryArchive | undefined,
  turn: number,
  citations: MemoryCitation[],
  hookPromptInjects: readonly HookPromptInject[] | undefined,
  taskSpend: { tokens: number } | undefined,
  bgController: BackgroundSummarizationController<BgSummaryPayload> | undefined,
): Promise<{
  readonly ctx: ReturnType<typeof buildTurnContext>
  readonly breakerVerdict: BreakerVerdict
}> => {
  const memoryContext = await resolveMemoryContext(config, wm, recorder, citations)
  const breakerVerdict = await maybeCompact(
    config,
    staticSystemFor(config),
    wm,
    breaker,
    archive,
    turn,
    bgController,
    resetEffortClassifier,
  )
  const wsSnapshot = workingState?.snapshot()
  const contextEvents = resolveContextEventsForTurn(config)
  const mentionMessages = await resolveMentionInjectionMessages(config, wm)
  const pluginActivation = await resolvePluginActivationForTurn(
    config,
    latestUserTextFromWm(wm),
    `t${turn}`,
  )
  const augmentedSkills = augmentActiveSkillsWithPlugin(activeSkills, pluginActivation)
  await reconcileSkillMcpDepsForTurn(config, augmentedSkills)
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
    ...(config.globRules !== undefined ? { globRules: config.globRules.rules } : {}),
    ...(config.globRules?.changedPaths !== undefined
      ? { changedPaths: config.globRules.changedPaths }
      : {}),
    ...(augmentedSkills !== undefined ? { activeSkills: augmentedSkills } : {}),
    ...(wsSnapshot !== undefined ? { workingState: wsSnapshot } : {}),
    ...(hookPromptInjects !== undefined && hookPromptInjects.length > 0
      ? { hookPromptInjects }
      : {}),
    ...(config.systemPromptCache !== undefined
      ? { systemPromptCache: config.systemPromptCache }
      : {}),
    ...(config.systemPromptCacheKey !== undefined
      ? { systemPromptCacheKey: config.systemPromptCacheKey }
      : {}),
    ...(contextEvents.length > 0 ? { contextChangeEvents: contextEvents } : {}),
    ...(mentionMessages.length > 0 ? { mentionInjectionMessages: mentionMessages } : {}),
    ...(taskBudgetForTurn !== undefined ? { taskBudget: taskBudgetForTurn } : {}),
    untrustedEnvelope: runtimeConfig().untrustedEnvelope,
  })
  const finalCtx = injectRedactionBanner(config, await injectIdeContext(config, ctx))
  emitPromptAssembled(config, finalCtx)
  return { ctx: finalCtx, breakerVerdict }
}

export const emitPromptAssembled = (
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
      message: `onPromptAssembled observer threw: ${errMessage(e)}`,
    })
  }
}
