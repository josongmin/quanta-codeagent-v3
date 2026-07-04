import type { Message } from "@/llm"
import { resolveModelWindow } from "@/llm"
import type { WorkingMemory } from "@/memory"
import { errMessage, runtimeConfig } from "@/shared"
import type { TaskBudget } from "../budget"
import type { BgSummaryPayload } from "../compaction"
import { TokenBaselineBox } from "../compaction"
import type { BackgroundSummarizationController } from "../compaction/index"
import type { BreakerVerdict, CompactionBreaker } from "../compaction-breaker"
import type { ConversationSummaryArchive } from "../conversation-summary-archive"
import type { HookPromptInject } from "../hooks"
import { renderIdeContext } from "../ide-context"
import { buildLanguageHint } from "../language-detect"
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
import { configuredModel, resolveWindowModel } from "./emit-helpers"

/** The memory-recall QUERY = the last user message with NON-EMPTY text, skipping
 *  pure `tool_result` carrier turns and whitespace-only user turns. After a tools
 *  turn the loop appends `{role:"user", content:[tool_result…]}` whose text is
 *  empty; the naive "last user message" pick collapsed the query to "" on EVERY
 *  turn following a tools turn, so recall ran unfocused. Mirrors the
 *  `captureInterruptedTurn` skip-carrier predicate. Returns `undefined` when no
 *  user message carries real text (byte-identical to the prior empty-query path).
 *  NOTE: intentionally LOCAL to recall — `latestUserTextFromWm` must NOT adopt
 *  this walk-back (mention injection relies on it going empty after a tools turn
 *  so `@`-mentions are not re-injected every subsequent turn). */
export const deriveRecallQuery = (wm: WorkingMemory<Message>): string | undefined => {
  const snap = wm.snapshot()
  for (let i = snap.length - 1; i >= 0; i--) {
    const m = snap[i]
    if (m === undefined || m.role !== "user") continue
    const t = m.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
      .trim()
    if (t.length === 0) continue
    return t
  }
  return undefined
}

export const resolveMemoryContext = async (
  config: AgentConfig,
  wm: WorkingMemory<Message>,
  recorder: AgentRecorder | undefined,
  citations: MemoryCitation[],
): Promise<string | undefined> => {
  if (!config.store) return undefined
  const queryText = deriveRecallQuery(wm)
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
        // §10.6 routing weighting — opt-in (QUANTA_MEMORY_ROUTING). Supply the
        // current cwd as the routing context so memories scoped to this
        // checkout (Codex `applies_to: cwd=...`) are weighted up. Absent flag
        // (the default) ⇒ no routing passed ⇒ ranking is byte-identical.
        ...(config.memory?.routingEnabled && config.cwd ? { routing: { cwd: config.cwd } } : {}),
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
  } catch (e) {
    // A throwing mention/@-file injector must be OBSERVABLE — otherwise a failed
    // `@file` expansion is indistinguishable from "no mentions to inject" and the
    // user's referenced context silently vanishes. Mirror the sibling
    // `resolveMemoryContext` above which surfaces a NON-FATAL `error` event on
    // throw. Still degrade clean (return `[]`); the emit only ADDS visibility. The
    // SUCCESS path is untouched (no emit when nothing throws) ⇒ byte-identical.
    config.stream.emit({
      type: "error",
      message: `mention injection failed: ${errMessage(e)}`,
    })
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

/** The first user message's text ONLY when this is the OPENING turn — i.e. the
 *  working memory holds EXACTLY ONE user message. A resumed/continued transcript
 *  (≥2 user messages) returns `undefined` so auto-title fires once per session,
 *  never per-turn (the title is the session's first prompt, set once). */
export const openingTurnUserText = (wm: WorkingMemory<Message>): string | undefined => {
  const snap = wm.snapshot()
  let firstUserText: string | undefined
  let userCount = 0
  for (const msg of snap) {
    if (msg === undefined || msg.role !== "user") continue
    userCount++
    if (userCount > 1) return undefined // not the opening turn
    for (const block of msg.content) {
      if (block.type === "text") {
        firstUserText = block.text
        break
      }
    }
  }
  return userCount === 1 ? firstUserText : undefined
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

/** Prepend `prefix` (+ a blank line) to the FIRST text block of the LAST user
 *  message, skipping a text block that already opens with `<system-reminder>`
 *  (so an injected banner never stacks onto another one). Mutates `messages`
 *  in place — the last user turn's text is where turn-scoped context/banners
 *  ride. No-op when there is no eligible user text block. Shared by
 *  {@link injectIdeContext} and {@link injectRedactionBanner}, which differ
 *  ONLY in the prefix string. */
const prependToLastUserText = (
  messages: ReturnType<typeof buildTurnContext>["messages"],
  prefix: string,
): void => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== "user") continue
    const idx = m.content.findIndex((b) => b.type === "text")
    const tb = idx >= 0 ? m.content[idx] : undefined
    if (tb?.type !== "text" || tb.text.startsWith("<system-reminder>")) continue
    const newContent = [...m.content]
    newContent[idx] = { ...tb, text: `${prefix}\n\n${tb.text}` }
    messages[i] = { ...m, content: newContent }
    break
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
  prependToLastUserText(ctx.messages, block)
  return ctx
}

export const injectRedactionBanner = (
  config: AgentConfig,
  ctx: ReturnType<typeof buildTurnContext>,
): ReturnType<typeof buildTurnContext> => {
  if (config.redaction?.disabled !== true) return ctx
  const ack = config.redaction.acknowledgedRisk ?? ""
  const banner = `<system-reminder>\nSecret redaction DISABLED for this session — tool output and model context may contain raw secrets. Acknowledged risk: ${ack}\n</system-reminder>`
  prependToLastUserText(ctx.messages, banner)
  return ctx
}

export const resolveTaskBudgetForTurn = (
  config: AgentConfig,
  taskSpend: { tokens: number } | undefined,
): TaskBudget | undefined =>
  config.taskBudget !== undefined
    ? { tokens: config.taskBudget.tokens, spent: taskSpend?.tokens ?? 0 }
    : undefined

/** Inputs for {@link prepareTurnContext}. A single readonly object (was 14
 *  positionals) so a mis-ordered arg of a compatible type can no longer compile
 *  silently — matching the `prepareTurnIteration`/`finishAgentSession` arg-object
 *  convention the rest of the loop already uses. */
export interface PrepareTurnContextArgs {
  readonly config: AgentConfig
  readonly wm: WorkingMemory<Message>
  readonly recorder: AgentRecorder | undefined
  readonly breaker: CompactionBreaker | undefined
  readonly activeSkills:
    | { name: string; description: string; rawDependencies?: unknown }[]
    | undefined
  readonly workingState: WorkingStateSession | undefined
  readonly archive: ConversationSummaryArchive | undefined
  readonly turn: number
  readonly citations: MemoryCitation[]
  readonly hookPromptInjects: readonly HookPromptInject[] | undefined
  readonly taskSpend: { tokens: number } | undefined
  readonly bgController: BackgroundSummarizationController<BgSummaryPayload> | undefined
  /** D5 (jun-7) — the per-session token-baseline BOX. `current` (set by the prior
   *  turn's exact usage) anchors this turn's compaction trigger; `undefined` ⇒
   *  chars/4 estimate (legacy, byte-identical). After compaction settles we record
   *  `sendCount` = the wm length of the prompt about to be sent, so the usage
   *  capture can pair it with the provider's authoritative input count. */
  readonly tokenBaselineBox: import("../compaction").TokenBaselineBoxState | undefined
  /** D4 (jun-7) — the model that will ACTUALLY process this turn (sticky/skill
   *  swap resolved in `runTurn`), so the compaction window threshold tracks the
   *  active model, not base `config.llm`. Omit ⇒ the base model id. */
  readonly activeModel?: string
}

export const prepareTurnContext = async (
  args: PrepareTurnContextArgs,
): Promise<{
  readonly ctx: ReturnType<typeof buildTurnContext>
  readonly breakerVerdict: BreakerVerdict
}> => {
  const {
    config,
    wm,
    recorder,
    breaker,
    activeSkills,
    workingState,
    archive,
    turn,
    citations,
    hookPromptInjects,
    taskSpend,
    bgController,
    tokenBaselineBox,
  } = args
  const activeModel = args.activeModel ?? configuredModel(config.llm)
  const memoryContext = await resolveMemoryContext(config, wm, recorder, citations)
  // D5 (jun-7) — capture the pre-compaction length. If `maybeCompact` SHRINKS the
  // transcript (proactive summarize / microcompact replaces the prefix), any
  // `tokenBaseline.current` measured against the OLD prefix is now STALE: its
  // `measuredAtMessageCount` index points at content that was replaced, and once
  // the transcript regrows past that index the `> messages.length` fail-safe no
  // longer fires — `triggerTokenCount` would then return a huge stale value and
  // force a premature compaction on a tiny transcript. So we INVALIDATE the
  // baseline whenever the transcript shrinks; a fresh exact usage re-establishes
  // it against the new prefix. (This turn's `maybeCompact` already consumed the
  // still-valid `.current` above — the clear only affects subsequent turns.)
  const lenBeforeCompact = wm.snapshot().length
  const breakerVerdict = await maybeCompact({
    config,
    system: staticSystemFor(config),
    wm,
    breaker,
    archive,
    turn,
    bgController,
    resetClassifier: resetEffortClassifier,
    tokenBaselineBox,
    activeModel,
  })
  if (tokenBaselineBox !== undefined) {
    const baseline = TokenBaselineBox.wrap(tokenBaselineBox)
    // Invalidate a baseline whose measured prefix was just replaced by a
    // shrinking compaction (proactive summarize / microcompact).
    baseline.invalidateOnShrink(lenBeforeCompact, wm.snapshot().length)
    // Record the send-time wm length AFTER compaction settled — the base the NEXT
    // turn's compaction will slice + the count the usage capture pairs with the
    // authoritative `inputTokens` for this prompt.
    baseline.recordSendCount(wm.snapshot().length)
  }
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
  // N1 — assistant language auto-detect (default-OFF `QUANTA_LANG_DETECT`). Reuse
  // the latest-user-text helper (already computed for plugin activation above);
  // `buildLanguageHint` returns undefined when the gate is off / English /
  // ambiguous, so the prompt stays byte-identical.
  const languageHint = buildLanguageHint(latestUserTextFromWm(wm), runtimeConfig().langDetect)
  const turnInput: import("../prompt").TurnContextInput = {
    baseMessages: [...wm.snapshot()],
    cwd: config.cwd,
    planMode: config.planMode ?? false,
    ...(languageHint !== undefined ? { languageHint } : {}),
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
    // #17 (C3) — brief-mode posture. Read the session accessor once per turn so a
    // mid-session `/brief on` (or a `set_brief` control-op) splices BRIEF_NOTICE
    // into the per-turn DYNAMIC tail (prompt.ts). Absent/false ⇒ omitted ⇒
    // byte-identical default-OFF. ORTHOGONAL to effort/language (all compose).
    ...(config.sessionBrief?.() === true ? { brief: true } : {}),
    untrustedEnvelope: runtimeConfig().untrustedEnvelope,
  }
  // Trajectory fork-experiment seam (AgentConfig.turnContextMutator). DEFAULT-OFF:
  // absent ⇒ `turnInput` reaches buildTurnContext untouched ⇒ byte-identical.
  const ctx = buildTurnContext(
    config.turnContextMutator !== undefined
      ? config.turnContextMutator(turn, turnInput)
      : turnInput,
  )
  const finalCtx = injectRedactionBanner(config, await injectIdeContext(config, ctx))
  emitPromptAssembled(config, finalCtx, activeModel)
  return { ctx: finalCtx, breakerVerdict }
}

export const emitPromptAssembled = (
  config: AgentConfig,
  ctx: ReturnType<typeof buildTurnContext>,
  // D4 (jun-7) — the active turn model (sticky/skill swap); defaults to base.
  activeModel: string = configuredModel(config.llm),
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
      // D4 (jun-7) — the model's real context window (or 0 for an un-tabled
      // model, the surface's "unknown" sentinel), so the usage gauge is
      // window-relative instead of always reporting 0.
      // GAP 3 (ADR-0505): the gauge tracks the 1M window when context-1m is
      // active; `model` stays the real active id for reporting.
      max: resolveModelWindow(resolveWindowModel(config.llm, activeModel))?.contextWindow ?? 0,
      model: activeModel,
    })
  } catch (e) {
    config.stream.emit({
      type: "error",
      message: `onPromptAssembled observer threw: ${errMessage(e)}`,
    })
  }
}
