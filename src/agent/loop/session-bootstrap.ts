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
  type AutomationEngineTickerHandle,
  type AutomationTickerDeps,
  attachCapEnforcer,
  attachDedupGate,
  attachLocalizePhase,
  attachReproDoubt,
  buildGitDirectiveEmit,
  buildSeedMessages,
  buildTurnDiffSession,
  startAutomationEngineTicker,
  wireHookPromptPending,
} from "../loop-helpers"
import { startBackgroundLspPrewarm } from "../lsp-bridge"
import { AgentRecorder } from "../metrics"
import {
  buildCloseoutGuard,
  buildEffectiveConfig,
  buildVerifyGuard,
  createRedactionRollup,
} from "../session-resources"
import { buildShellSnapshotSession, type ShellSnapshotSession } from "../shell-snapshot-session"
import { runSessionPrewarm, type TtfmMarker } from "../startup-prewarm"
import { decorateWithDeltaCounter } from "../token-delta/wm-decorator"
import { createToolChoiceTurnState } from "../tool-choice"
import type { TurnSession } from "../turn-context"
import { buildTurnRegistrySnapshot } from "../turn-registry-snapshot"
import type { AgentConfig, MemoryCitation } from "../types"
import {
  disposeSessionResources,
  finishAgentSession,
  type SessionDisposeGuard,
} from "./session-lifecycle"
import { buildSkillGate } from "./skill-gate"
import { buildSkillScopeView } from "./skill-scope-view"
import { sleep } from "./sleep"
import type {
  FinishAgentSession,
  PendingPlanEntry,
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

/**
 * RFC jun-17 — kick off a session-start BACKGROUND warm of the LSP workspace.
 * Fire-and-forget: returns immediately, the warm runs concurrently so session
 * bootstrap is never delayed. Gated on `cfg.lspPrewarm.enabled` (set by the
 * composition root only when `QUANTA_LSP_PREWARM` AND the nav tools are on).
 * Absent/disabled ⇒ no-op, byte-identical. The orchestrator is NO-THROW, so an
 * unhandled-rejection can never escape the `void`.
 */
export const maybeStartLspPrewarm = (cfg: AgentConfig): void => {
  if (cfg.lspPrewarm?.enabled !== true) return
  void startBackgroundLspPrewarm(cfg.cwd, cfg.lspPrewarm.warmSignal)
}

/**
 * ADR-0240 §B / ALBB-14 — arm the automation-engine background ticker as part
 * of the SHARED session lifecycle so ALL surfaces that assemble an
 * `AgentConfig` (web-daemon / headless, not just the CLI REPL) get scheduled-
 * fire delivery. Previously `startAutomationEngineTicker` had exactly one non-
 * test call site (the CLI), so a non-CLI surface with `QUANTA_AUTOMATION=on`
 * scheduled fires but never ticked them.
 *
 * Delegates to `startAutomationEngineTicker`, which already returns `undefined`
 * when the wire is incomplete (slot absent / no handler / non-positive
 * interval) — so this is byte-identical when `automationEngine` is absent
 * (the default). The returned handle's `stop()` is registered by
 * `createRunAgentContext` on the guaranteed `disposeResources` teardown (runs
 * on BOTH the clean-finish and throw paths), mirroring the CLI's close-stack
 * registration. `deps` is a test-injection seam for `setInterval`/`clearInterval`.
 */
export const maybeStartAutomationTicker = (
  cfg: AgentConfig,
  deps?: AutomationTickerDeps,
): AutomationEngineTickerHandle | undefined =>
  deps !== undefined ? startAutomationEngineTicker(cfg, deps) : startAutomationEngineTicker(cfg)

export const createRunAgentContext = async (config: AgentConfig): Promise<RunAgentContext> => {
  const cfg: AgentConfig = { ...config }
  // Finalize the session-owned LLM BEFORE feature construction so any
  // stateful feature that captures `config.llm` (classifier, branch-search,
  // etc.) sees the same decorated port the main turn path uses.
  const rawWm: WorkingMemory<Message> = createWorkingMemory<Message>(buildSeedMessages(cfg))
  const wm: WorkingMemory<Message> = runtimeConfig().deltaTokenCount
    ? decorateWithDeltaCounter(rawWm)
    : rawWm
  cfg.llm = maybeWrapImageSanitizationRetry(cfg, wm)
  const features = await buildSessionFeatures(cfg)
  if (cfg.onWorkingStateReady !== undefined) {
    try {
      const ws = features.workingState
      cfg.onWorkingStateReady(() => ws?.snapshot())
    } catch (e) {
      cfg.stream.emit({
        type: "error",
        message: `onWorkingStateReady observer threw: ${errMessage(e)}`,
      })
    }
  }
  buildEffectiveConfig(cfg, features.extraTools)
  const pendingPlanExitRef: { current: PendingPlanExit[] } = { current: [] }
  const onPlanExitOutcome = cfg.onPlanExitOutcome
  cfg.onPlanExitOutcome = (event) => {
    pendingPlanExitRef.current.push(event)
    onPlanExitOutcome?.(event)
  }
  // Plan-ENTRY mirror: the dispatch seam calls cfg.onPlanEnterRequest when the
  // model fires `enter_plan_mode`; record it so the turn boundary flips into
  // plan mode (applyPendingPlanEntry). Chains any host-supplied observer.
  const pendingPlanEntryRef: { current: PendingPlanEntry[] } = { current: [] }
  const onPlanEnterRequest = cfg.onPlanEnterRequest
  cfg.onPlanEnterRequest = (event) => {
    pendingPlanEntryRef.current.push(event)
    onPlanEnterRequest?.(event)
  }

  const skillGate = buildSkillGate(features.skillAllowlists, features.skillOverrides)
  const recorder = cfg.metrics ? new AgentRecorder(cfg.metrics) : undefined
  const ttfm = await maybeRunSessionPrewarm(cfg, recorder)
  // RFC jun-17 — fire-and-forget background LSP workspace warm (default-OFF).
  maybeStartLspPrewarm(cfg)
  const sessionId = cfg.sessionId ?? "default"
  const breaker = cfg.compactionBreaker?.disabled
    ? undefined
    : new CompactionBreaker(cfg.compactionBreaker?.caps)
  const dedupGate = attachDedupGate(cfg)
  const { state: verifyGuardState, history: toolHistory } = buildVerifyGuard(cfg)
  const closeoutGuardState = buildCloseoutGuard(cfg)
  attachCapEnforcer(cfg)
  const localizePhaseState = attachLocalizePhase(cfg)
  attachReproDoubt(cfg)
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
  // F3 decouple: the snapshot store + response-header capture are built when
  // EITHER proactive-backoff OR the `QUANTA_RATELIMIT_NOTICE` render wants them,
  // so the notice knob ALONE produces `ratelimit_snapshot` events. `proactive`
  // distinguishes the two — only the backoff knob applies the pre-request sleep.
  const rlProactive = runtimeConfig().proactiveRateLimit
  const rateLimitProactive: TurnSession["rateLimitProactive"] =
    rlProactive || runtimeConfig().ratelimitNotice
      ? {
          store: createRateLimitSnapshotStore(),
          now: cfg.proactiveRateLimit?.now ?? Date.now,
          sleep: cfg.proactiveRateLimit?.sleep ?? ((ms: number) => sleep(ms, cfg.signal)),
          proactive: rlProactive,
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

  // RFC04-0 — pin ONE capability generation binding the pinned registry to its
  // OWN specs. `specs` below is read from the snapshot (derived from
  // `cfg.registry`), so the model advertisement and the dispatch registry are
  // provably the same generation. Byte-identical: `snapshot.specs` is exactly
  // `cfg.registry.specs()` — the prior expression — just routed through the
  // record that carries the generation id for the reload publish (RFC04-3).
  const registrySnapshot = buildTurnRegistrySnapshot(cfg.registry)

  const session: TurnSession = {
    config: cfg,
    specs: registrySnapshot.specs,
    registrySnapshot,
    ...(recorder !== undefined ? { recorder } : {}),
    ...(features.classifier !== undefined ? { classifier: features.classifier } : {}),
    ...(skillGate !== undefined ? { skillGate } : {}),
    ...(features.activeSkills !== undefined ? { activeSkills: features.activeSkills } : {}),
    ...(summaryArchive !== undefined ? { archive: summaryArchive } : {}),
    ...(ttfm !== undefined ? { ttfm } : {}),
    ...(bgCompaction !== undefined ? { bgCompaction } : {}),
    ...(rateLimitProactive !== undefined ? { rateLimitProactive } : {}),
    // UUX-5-05 — thread the task registry so the MID-turn conversation-action
    // drain (same-turn-engine) serves `cancel_subagent` with boundary parity.
    ...(features.taskRegistry !== undefined ? { taskRegistry: features.taskRegistry } : {}),
    guards: guardChain,
    hookPromptPending,
  }

  // ADR-0512 P3 — publish a live skill-scope getter for `/state` ("왜 이 도구가
  // 없지?"). Mirrors `onWorkingStateReady`: fire ONCE with a getter that re-reads
  // the live `skillGate` each call (a mid-turn `Skill` arms scope) and projects
  // the L1 availability filter via `buildSkillScopeView` (reuse — no scope logic
  // here). Gated on `skillScopeV2`; OFF / no observer ⇒ no publish (byte-
  // identical). Pure observation; never throws into the loop.
  if (config.onSkillScopeReady !== undefined && runtimeConfig().skillScopeV2) {
    try {
      config.onSkillScopeReady(() => buildSkillScopeView(session.skillGate, session.specs))
    } catch (e) {
      config.stream.emit({
        type: "error",
        message: `onSkillScopeReady observer threw: ${errMessage(e)}`,
      })
    }
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
    // D5 (jun-7) — one shared mutable box per session (spread by reference into
    // every turn's TurnState, so the capture persists across turns). Empty until
    // an exact provider usage lands; absent a baseline the trigger is legacy
    // chars/4 (byte-identical). Allocated only when compaction is configured.
    ...(cfg.compaction !== undefined ? { tokenBaseline: {} } : {}),
  }

  // ADR-0240 §B / ALBB-14 — arm the automation-engine ticker for EVERY surface
  // (not just the CLI). Default-OFF byte-identical: `undefined` when the
  // `automationEngine` slot / handler / interval are absent (the common case).
  // Its `stop()` rides `disposeResources` below — guaranteed on clean finish AND
  // throw (idempotent).
  const automationTicker = maybeStartAutomationTicker(cfg)

  // D12 — ONE dispose guard shared by the normal finish chain and the throw-path
  // `finally` in `runAgentInner`, so the resource-dispose pass runs at most once.
  const disposeGuard: SessionDisposeGuard = { disposed: false }

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
      disposeGuard,
      ...(stopCategory !== undefined ? { stopCategory } : {}),
      ...(refusal !== undefined ? { refusal } : {}),
    })

  // D12 — the dispose-only teardown the throw-path `finally` calls. Shares the
  // guard above, so a clean finish that already disposed makes this a no-op (and
  // vice-versa). Persist-side snapshots are deliberately NOT run here: a throw
  // mid-turn has no clean turn-derived state to persist.
  const disposeResources = async (): Promise<void> => {
    // ALBB-14 — stop the automation ticker on teardown (idempotent). Runs BEFORE
    // the resource dispose so the background `setInterval` stops burning before
    // the resident daemons are reaped. `stop()` is a no-throw idempotent guard.
    automationTicker?.stop()
    await disposeSessionResources({ cfg, features, guard: disposeGuard })
  }

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
    pendingPlanEntryRef,
    shellSnapshotSession,
    turnDiffSession,
    gitDirectiveCollector,
    session,
    turnStateSeed,
    finish,
    disposeResources,
    bgCompaction,
  }
}
