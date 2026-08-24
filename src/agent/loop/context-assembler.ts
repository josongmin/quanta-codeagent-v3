import type { Message } from "@/llm"
import { resolveModelWindow } from "@/llm"
import type { WorkingMemory } from "@/memory"
import type { PromptActiveLeversSnapshot } from "@/shared"
import { errMessage, runtimeConfig } from "@/shared"
import type { TaskBudget } from "../budget"
import type { BgSummaryPayload } from "../compaction"
import { TokenBaselineBox } from "../compaction"
import type { BackgroundSummarizationController } from "../compaction/index"
import type { BreakerVerdict, CompactionBreaker } from "../compaction-breaker"
import type { ConversationSummaryArchive } from "../conversation-summary-archive"
import { probeRepoMap } from "../env-context"
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
import { isSyntheticUserMessage } from "../synthetic-user"
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
    if (m === undefined || m.role !== "user" || isSyntheticUserMessage(m)) continue
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

/** ALBB-19 #3 — publish the LIVE per-turn skill ids to the composition-root
 *  side-channel cursor that the `getSnapshot` closure
 *  (`agent-config-assembler.ts`) reads. The cursor is a mutable
 *  `{ ids: readonly string[] }` box mirroring the `metricsEmitter` structural
 *  side-channel. We project skill OBJECTS → `skill.name` id STRINGS (the
 *  snapshot's `readonly string[]` shape) before publishing.
 *
 *  Fail-closed: if no cursor was installed (bench / replay surfaces), this is a
 *  no-op and the snapshot stays `activeSkills: []` (byte-identical). Structural-
 *  only — does NOT touch the AgentConfig type surface. */
const publishActiveSkillCursor = (
  config: AgentConfig,
  augmentedSkills: { name: string }[] | undefined,
): void => {
  const cursor = (config as { activeSkillCursor?: { ids: readonly string[] } }).activeSkillCursor
  if (cursor === undefined) return
  cursor.ids = augmentedSkills !== undefined ? augmentedSkills.map((s) => s.name) : []
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

const resolvePromptActiveLevers = (config: AgentConfig): PromptActiveLeversSnapshot => ({
  budgetMeter: config.budgetMeter !== undefined,
  budgetLedger: config.budgetLedger !== undefined,
  subagentTurnGate: config.subagentTurnGate !== undefined,
})

/**
 * C2b — build the LIVE per-turn objective-visibility thunk. Gated EXACTLY like
 * the `objective_*` tools: only when `config.objective` (itself
 * `QUANTA_OBJECTIVE_TOOLS`-gated) AND a session-bound `sessionId` are wired — the
 * SAME thread identity the tools bind to (`ctx.ownerId` ← `AgentConfig.sessionId`).
 * The returned thunk reads the authority at buildDynamicContext time (NOT now), so
 * it tracks edit/pause/resume; it returns `undefined` when the thread has no goal
 * (⇒ NO block ⇒ byte-identical). Absent authority / sessionId ⇒ `undefined` ⇒ the
 * `objective` field is omitted ⇒ byte-identical default-OFF.
 */
export const resolveObjectiveThunk = (
  config: AgentConfig,
): (() => import("../prompt").ObjectiveContextView | undefined) | undefined => {
  const port = config.objective
  const threadId = config.sessionId
  if (port === undefined || threadId === undefined || threadId.length === 0) return undefined
  return () => {
    const o = port.get(threadId)
    return o === null ? undefined : { goal: o.goal, status: o.status }
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
    if (msg === undefined || msg.role !== "user" || isSyntheticUserMessage(msg)) continue
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
    if (msg === undefined || msg.role !== "user" || isSyntheticUserMessage(msg)) continue
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
    if (m?.role !== "user" || isSyntheticUserMessage(m)) continue
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

/** ALBB-20 #12 — apply the optional `turnContextMutator` with the SAME
 *  emit-on-throw parity as {@link injectIdeContext}. On throw, surface a
 *  non-fatal stream `error` and return the UN-mutated `turnInput` (fail-safe:
 *  the turn proceeds on the base context rather than crashing assembly).
 *  Absent mutator ⇒ `turnInput` returned untouched (byte-identical). */
export const applyTurnContextMutator = (
  config: AgentConfig,
  turn: number,
  turnInput: import("../prompt").TurnContextInput,
): import("../prompt").TurnContextInput => {
  if (config.turnContextMutator === undefined) return turnInput
  try {
    return config.turnContextMutator(turn, turnInput)
  } catch (e) {
    config.stream.emit({
      type: "error",
      message: `turn-context mutator failed: ${errMessage(e)}`,
    })
    return turnInput
  }
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

/**
 * §17 packet E — the turn-1 repo-map env context.
 *
 * `QUANTA_REPO_MAP` was a registered knob with a schema, presets, a bounded
 * probe, a scan adapter, a renderer and tests — everything except the CALL.
 * `probeRepoMap` had zero production call sites, `TurnContextInput.env` had no
 * producer, and measured through the real loop the knob produced a
 * BYTE-IDENTICAL prompt. An operator who set it got nothing.
 *
 * TURN 1 ONLY: the caps exist because turn-0 orientation is a one-time payment;
 * re-scanning every turn would be the cost without the premise.
 *
 * FAIL-SOFT: `probeRepoMap` collapses every failure to `undefined`, and an
 * absent scan adapter (a host that wired the caps but forgot the port) yields
 * `undefined` too — so the env block stays byte-identical rather than breaking
 * a turn over an orientation nicety.
 *
 * SCOPE: the repo map ONLY. `probeTurnEnv` (platform / shell / git status /
 * package manager) stays unwired — it costs a `git status` per session and has
 * no knob asking for it.
 */
const buildRepoMapEnv = async (
  config: AgentConfig,
  turn: number,
): Promise<{ env: import("../env-context").TurnEnvContext } | Record<string, never>> => {
  const caps = config.repoMap
  const scan = config.repoMapScan
  if (turn !== 1 || caps === undefined || scan === undefined) return {}
  const repoMap = await probeRepoMap({
    cwd: config.cwd,
    scan,
    maxDepth: caps.maxDepth,
    maxFiles: caps.maxFiles,
    maxChars: caps.maxChars,
  })
  return repoMap === undefined ? {} : { env: { repoMap } }
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
  // ALBB-19 #3 — resolve the LIVE per-turn skill set BEFORE consuming
  // `resolveContextEventsForTurn` so the composition-root `getSnapshot` closure
  // (which reads a mutable side-channel cursor published here) sees THIS turn's
  // skills. Previously the closure hardcoded `activeSkills: []`, making
  // `skill_activation` ContextEvents structurally unreachable. We compute the
  // plugin activation + augmentation first, project to `skill.name` id strings
  // (the snapshot's `readonly string[]` shape, NOT skill objects), publish to
  // the cursor, THEN consume — publish-before-consume so activation surfaces the
  // same turn (no one-turn lag). Absent cursor (bench/replay surfaces that never
  // installed it) ⇒ no-op ⇒ byte-identical.
  const pluginActivation = await resolvePluginActivationForTurn(
    config,
    latestUserTextFromWm(wm),
    `t${turn}`,
  )
  const augmentedSkills = augmentActiveSkillsWithPlugin(activeSkills, pluginActivation)
  publishActiveSkillCursor(config, augmentedSkills)
  const contextEvents = resolveContextEventsForTurn(config)
  const mentionMessages = await resolveMentionInjectionMessages(config, wm)
  await reconcileSkillMcpDepsForTurn(config, augmentedSkills)
  const taskBudgetForTurn = resolveTaskBudgetForTurn(config, taskSpend)
  // N1 — assistant language auto-detect (default-OFF `QUANTA_LANG_DETECT`). Reuse
  // the latest-user-text helper (already computed for plugin activation above);
  // `buildLanguageHint` returns undefined when the gate is off / English /
  // ambiguous, so the prompt stays byte-identical.
  const languageHint = buildLanguageHint(latestUserTextFromWm(wm), runtimeConfig().langDetect)
  const repoMapEnv = await buildRepoMapEnv(config, turn)
  const objectiveThunk = resolveObjectiveThunk(config)
  const turnInput: import("../prompt").TurnContextInput = {
    baseMessages: [...wm.snapshot()],
    ...repoMapEnv,
    cwd: config.cwd,
    planMode: config.planMode ?? false,
    ...(languageHint !== undefined ? { languageHint } : {}),
    system: config.system,
    ...(config.promptSurfaceProfile !== undefined
      ? { promptSurfaceProfile: config.promptSurfaceProfile }
      : {}),
    activeLevers: resolvePromptActiveLevers(config),
    ...(config.sessionCtx !== undefined ? { sessionCtx: config.sessionCtx } : {}),
    ...(config.memorySummaryMd !== undefined ? { memorySummaryMd: config.memorySummaryMd } : {}),
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
    // C2b — LIVE per-turn objective-visibility thunk. Gated like the objective_*
    // tools (config.objective + sessionId). Absent ⇒ omitted ⇒ byte-identical;
    // no goal for the thread ⇒ the thunk returns undefined ⇒ no block.
    ...(objectiveThunk !== undefined ? { objective: objectiveThunk } : {}),
    // #17 (C3) — brief-mode posture. Read the session accessor once per turn so a
    // mid-session `/brief on` (or a `set_brief` control-op) splices BRIEF_NOTICE
    // into the per-turn DYNAMIC tail (prompt.ts). Absent/false ⇒ omitted ⇒
    // byte-identical default-OFF. ORTHOGONAL to effort/language (all compose).
    ...(config.sessionBrief?.() === true ? { brief: true } : {}),
    untrustedEnvelope: runtimeConfig().untrustedEnvelope,
  }
  // Trajectory fork-experiment seam (AgentConfig.turnContextMutator). DEFAULT-OFF:
  // absent ⇒ `turnInput` reaches buildTurnContext untouched ⇒ byte-identical.
  // ALBB-20 #12 — the mutator USED to be called UNCAUGHT; a throwing mutator
  // crashed context assembly. Mirror the sibling `injectIdeContext` (same file)
  // emit-on-throw shape: surface the failure as a non-fatal stream `error` and
  // fall back to the UN-mutated `turnInput` so the turn proceeds. Parity only.
  const ctx = buildTurnContext(applyTurnContextMutator(config, turn, turnInput))
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
      ...(policy.surfaceProfile !== undefined ? { surfaceProfile: policy.surfaceProfile } : {}),
      ...(policy.activeLevers !== undefined ? { activeLevers: policy.activeLevers } : {}),
      // D4 (jun-7) — the model's real context window (or 0 for an un-tabled
      // model, the surface's "unknown" sentinel), so the usage gauge is
      // window-relative instead of always reporting 0.
      // GAP 3 (ADR-0505): the gauge tracks the 1M window when context-1m is
      // active; `model` stays the real active id for reporting.
      max: resolveModelWindow(resolveWindowModel(config.llm, activeModel))?.contextWindow ?? 0,
      model: activeModel,
      // ADR-0538 Phase 3 — forward the fired-atom manifest (additive; absent when
      // no atom manifest was emitted, byte-identical to the pre-ADR-0538 snapshot).
      ...(policy.firedAtomIds !== undefined ? { firedAtomIds: policy.firedAtomIds } : {}),
      ...(policy.byChannel !== undefined ? { byChannel: policy.byChannel } : {}),
    })
  } catch (e) {
    config.stream.emit({
      type: "error",
      message: `onPromptAssembled observer threw: ${errMessage(e)}`,
    })
  }
}
