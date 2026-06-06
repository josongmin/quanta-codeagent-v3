import type { Message } from "@/llm"
import { withImageSanitizationRetry } from "@/llm/image-sanitization-retry"
import { createRateLimitSnapshotStore } from "@/llm/ratelimit-snapshot"
import { createWorkingMemory, type WorkingMemory } from "@/memory"
import { createWorkingMemoryHistorySanitization } from "@/memory/history-sanitization"
import type { TurnTiming } from "@/observability"
import { normalizeRedactionConfig } from "@/security"
import { errMessage, logger, runtimeConfig } from "@/shared"
import { type BgSummaryPayload, makeBgCompactionController } from "../compaction"
import { type BackgroundSummarizationController, BG_COMPACTION_ENV } from "../compaction/index"
import { CompactionBreaker } from "../compaction-breaker"
import { type ConversationSummaryArchive, createArchive } from "../conversation-summary-archive"
import { buildSessionFeatures } from "../features"
import type { TurnDiffSession } from "../git-observability"
import { buildGuardChain } from "../guards"
import {
  attachCapEnforcer,
  attachDedupGate,
  attachLocalizePhase,
  buildGitDirectiveEmit,
  buildSeedMessages,
  buildTurnDiffSession,
  wireHookPromptPending,
} from "../loop-helpers"
import { AgentRecorder } from "../metrics"
import {
  buildCloseoutGuard,
  buildEffectiveConfig,
  buildVerifyGuard,
  createRedactionRollup,
} from "../session-resources"
import { buildShellSnapshotSession, type ShellSnapshotSession } from "../shell-snapshot-session"
import { runSessionPrewarm, type TtfmMarker } from "../startup-prewarm"
import { createToolChoiceTurnState } from "../tool-choice"
import type { TurnSession } from "../turn-context"
import type { AgentConfig, MemoryCitation } from "../types"
import { finishAgentSession } from "./session-lifecycle"
import { buildSkillGate } from "./skill-gate"
import { sleep } from "./sleep"
import type {
  FinishAgentSession,
  PendingPlanExit,
  RunAgentContext,
  RunAgentTurnStateSeed,
} from "./types"

export const maybeWrapImageSanitizationRetry = (
  cfg: AgentConfig,
  wm: WorkingMemory<Message>,
): AgentConfig["llm"] => {
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

export const maybeRunSessionPrewarm = async (
  cfg: AgentConfig,
  recorder: AgentRecorder | undefined,
): Promise<TtfmMarker | undefined> => {
  if (cfg.prewarm?.enabled !== true) return undefined
  return await runSessionPrewarm({
    llm: cfg.llm,
    recorder,
    now: cfg.prewarm.now ?? Date.now,
    ...(cfg.prewarm.warmSignal !== undefined ? { warmSignal: cfg.prewarm.warmSignal } : {}),
    onError: (m) => logger.warn(m),
  })
}

export const createRunAgentContext = async (config: AgentConfig): Promise<RunAgentContext> => {
  const features = await buildSessionFeatures(config)
  if (config.onWorkingStateReady !== undefined) {
    try {
      const ws = features.workingState
      config.onWorkingStateReady(() => ws?.snapshot())
    } catch (e) {
      config.stream.emit({
        type: "error",
        message: `onWorkingStateReady observer threw: ${errMessage(e)}`,
      })
    }
  }
  const baseCfg = buildEffectiveConfig(config, features.extraTools)
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
  const ttfm = await maybeRunSessionPrewarm(cfg, recorder)
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
  const turnDiffSession: TurnDiffSession | undefined = buildTurnDiffSession(cfg)
  const gitDirectiveCollector = buildGitDirectiveEmit(cfg)
  const bgCompaction: BackgroundSummarizationController<BgSummaryPayload> | undefined =
    makeBgCompactionController(
      { [BG_COMPACTION_ENV]: runtimeConfig().bgCompaction ? "1" : "0" },
      cfg.compaction?.summarizerLlm ?? cfg.llm,
      () => wm.snapshot(),
      () => Date.now(),
    )
  const rateLimitProactive: TurnSession["rateLimitProactive"] = runtimeConfig().proactiveRateLimit
    ? {
        store: createRateLimitSnapshotStore(),
        now: cfg.proactiveRateLimit?.now ?? Date.now,
        sleep: cfg.proactiveRateLimit?.sleep ?? ((ms: number) => sleep(ms, cfg.signal)),
      }
    : undefined
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
    ...(ttfm !== undefined ? { ttfm } : {}),
    ...(bgCompaction !== undefined ? { bgCompaction } : {}),
    ...(rateLimitProactive !== undefined ? { rateLimitProactive } : {}),
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
    bgCompaction,
  }
}
