import { homedir } from "node:os"
import * as readline from "node:readline/promises"
import { buildSystemPrompt, RetryingLLM } from "@/agent"
import type { FollowUpQueue } from "@/agent/follow-up-queue"
import type { PlanStore } from "@/agent/plan/state"
import type { ImageBlock, LLMPort, Message } from "@/llm"
import { buildShellOtelObserver, StructuredLogger } from "@/observability"
import type { PermissionContext, PermissionMode, ToolAction } from "@/permission"
import { logger } from "@/shared"
import type { StreamPort } from "@/stream"
import type { TaskRegistry } from "@/subagent"
import { composeShellObservers } from "@/tool"
import type { BranchProgressTracker } from "../branch-search-progress"
import type { CostPanel } from "../cost-panel"
import { diffPreviewEnabled, renderActionDiff } from "../diff-preview"
import { createIdleMonitor, type IdleMonitor } from "../idle-monitor"
import { loadImageBlock } from "../image-loader"
import {
  argvImages,
  argvPrompt,
  buildLLM,
  buildStreaming,
  buildSummarizerLlm,
  buildTooling,
  composeLLM,
  DEFAULT_MODEL,
  env,
  isPathLikeToken,
  loadFeatures,
  newSessionFlag,
  observeDir,
  pickPersona,
  pickProvider,
  resolveResume,
  type SessionDeps,
  titleFlag,
} from "../internal"
import type { LifecyclePills, McpPillServer } from "../lifecycle-pills"
import type { McpSurfaceInfo } from "../mcp-cmd"
import { createRejectCounter, type RejectCounter } from "../reject-counter"
import { buildMcpSurfaceInfo } from "./mcp-surface-wire"
import { switchToSessionCwd } from "../session-io"
import { buildShellStreamPainter } from "../shell-stream-painter"
import { installStatusBar, type StatusBar } from "../status-bar"
import type { createStatusPills } from "../status-pills"
import type { TurnIndicator } from "../turn-indicator"
import type { TurnSummaryCollector } from "../turn-summary"

/** Build the idle monitor + reject counter the prompt-pipeline gate and the
 *  permission onConfirm both observe. Default-ON; `QUANTA_IDLE_SUPPRESS=0`
 *  collapses both to no-ops (`Infinity` thresholds). */
const buildIdleGuards = (): { idleMonitor: IdleMonitor; rejectCounter: RejectCounter } => {
  const idleSuppressOn = env("QUANTA_IDLE_SUPPRESS", "1") !== "0"
  const idleMsRaw = Number(env("QUANTA_IDLE_MS", "60000"))
  const snoozeDefaultMsRaw = Number(env("QUANTA_SNOOZE_DEFAULT_MS", "300000"))
  const rejectLimitRaw = Number(env("QUANTA_REJECT_LIMIT", "20"))
  const idleMonitor = createIdleMonitor({
    idleThresholdMs:
      idleSuppressOn && Number.isFinite(idleMsRaw) ? idleMsRaw : Number.POSITIVE_INFINITY,
    defaultSnoozeMs:
      idleSuppressOn && Number.isFinite(snoozeDefaultMsRaw) ? snoozeDefaultMsRaw : 300_000,
  })
  const rejectCounter = createRejectCounter({
    threshold:
      idleSuppressOn && Number.isFinite(rejectLimitRaw) && rejectLimitRaw > 0
        ? rejectLimitRaw
        : Number.POSITIVE_INFINITY,
  })
  return { idleMonitor, rejectCounter }
}

/** Build the `onConfirm` callback for tool-permission prompts. Inline diff
 *  preview before the readline question; accept/deny is counted by
 *  `rejectCounter` so consecutive denials can trigger graceful auto-exit. */
const buildOnConfirm =
  (idleMonitor: IdleMonitor, rejectCounter: RejectCounter) =>
  async (action: ToolAction): Promise<boolean> => {
    if (diffPreviewEnabled()) {
      const preview = await renderActionDiff(action)
      if (preview !== undefined) process.stderr.write(`${preview}\n`)
    }
    const adhoc = readline.createInterface({ input: process.stdin, output: process.stderr })
    try {
      const ans = await adhoc.question(`Allow ${action.tool}? [y/N] `)
      const accepted = ans.trim().toLowerCase() === "y"
      if (accepted) rejectCounter.recordAccept()
      else rejectCounter.recordDeny()
      idleMonitor.markActive()
      return accepted
    } finally {
      adhoc.close()
    }
  }

/** Build the LLM stack: buildLLM (fatal-exit on failure) → RetryingLLM →
 *  composeLLM (fallback + auto-classifier). Default-OFF ⇒ `finalLLM ===
 *  retryingLLM` byte-identical to the prior wiring. */
const buildLlmStack = (
  provider: ReturnType<typeof pickProvider>,
  model: string,
  mode: PermissionMode,
  permission: PermissionContext,
  signal: AbortSignal,
  slog: StructuredLogger,
): LLMPort => {
  let llm: LLMPort
  try {
    llm = buildLLM(provider, model)
  } catch (e) {
    logger.error((e as Error).message)
    process.exit(1)
  }
  const retryingLLM = new RetryingLLM({ inner: llm, signal })
  return composeLLM(retryingLLM, provider, signal, mode, permission, slog)
}

/** ADR-0083: resolve `--image <path>` attachments to {@link ImageBlock}s, or
 *  exit 1 with a clear message on a load failure (bad path / unsupported type /
 *  oversize). Empty when no `--image` is passed (byte-identical text-only seed). */
const loadSeedImages = (): ImageBlock[] => {
  try {
    return argvImages().map(loadImageBlock)
  } catch (e) {
    logger.error((e as Error).message)
    process.exit(1)
  }
}

/** Shell-event observer composition (painter + OTel). Returns `undefined`
 *  when neither observer is built so `runShell` skips event allocation. */
const composeShellEvent = (
  metrics: Awaited<ReturnType<typeof loadFeatures>>["metrics"],
): SessionDeps["onShellEvent"] => {
  const painterObs = process.stdin.isTTY ? buildShellStreamPainter() : undefined
  const otelObs = metrics ? buildShellOtelObserver(metrics) : undefined
  return painterObs !== undefined || otelObs !== undefined
    ? composeShellObservers(painterObs, otelObs)
    : undefined
}

/** Inputs for {@link setupSession} — bundled so the call site stays narrow
 *  and tests can construct it with a small literal. The pipeline-specific
 *  inputs (`buildLifecycleBundle` ⇒ pills, etc.) are reached via injected
 *  factories so the surface composer can swap them without recompiling
 *  the setup module. */
export interface SetupSessionDeps {
  /** Allocate the lifecycle bundle (pills + task registry + follow-up queue).
   *  Default impl lives in the host (`buildLifecycleBundle`) — injected here
   *  so tests can stub the full bundle without booting a TaskRegistry. */
  readonly buildLifecycleBundle: () => {
    pills: LifecyclePills
    taskRegistry: TaskRegistry | undefined
    followUpQueue: FollowUpQueue | undefined
  }
  /** Snapshot the MCP pill from the bridged tools list (server prefix scan).
   *  Returns `[]` when no MCP tools are bridged. */
  readonly deriveMcpPillServers: (
    mcpTools: ReadonlyArray<{ name: string }>,
  ) => readonly McpPillServer[]
  /** Build the optional cost panel (S3 adapter). */
  readonly buildCostPanelOrUndefined: (
    envSource: NodeJS.ProcessEnv,
    isTTY: boolean | undefined,
    model: string,
  ) => CostPanel | undefined
  /** Build the optional branch-search progress tracker. */
  readonly buildBranchProgressOrUndefined: (
    envSource: NodeJS.ProcessEnv,
    isTTY: boolean | undefined,
  ) => BranchProgressTracker | undefined
  /** Build the optional plan store. */
  readonly buildPlanStoreOrUndefined: (envSource: NodeJS.ProcessEnv) => PlanStore | undefined
  /** Build the per-turn turn-summary collector + stream tee. */
  readonly buildTurnSummaryAndStream: (
    stream: StreamPort,
    envSource: NodeJS.ProcessEnv,
    isTTY: boolean | undefined,
  ) => { collector: TurnSummaryCollector; stream: StreamPort }
  /** Build the live turn indicator + indicator-tee'd stream. */
  readonly buildTurnIndicatorAndStream: (
    statusBar: StatusBar,
    stream: StreamPort,
    envSource: NodeJS.ProcessEnv,
    isTTY: boolean | undefined,
    intervalEnv: string,
  ) => { indicator: TurnIndicator; turnStream: StreamPort }
  /** Build the optional work-metrics sink (gated on metrics-enabled). */
  readonly buildWorkMetricsSink: (
    enabled: boolean,
  ) => import("@/agent").AgentConfig["workMetricsSink"] | undefined
  /** Install the status pills row (workspace / mode+effort / skills / sandbox). */
  readonly installPills: (args: {
    statusBar: StatusBar
    cwd: string
    planMode: boolean
    skillsConfig: import("@/agent").AgentConfig["skills"] | undefined
  }) => ReturnType<typeof createStatusPills>
}

/** Outcome of {@link setupSession}. Carries every binding the per-turn loop
 *  needs — including the surface-mutable initial values (`pendingImages`,
 *  `history`, `sessionId`, `cwd`) which the host migrates into a
 *  {@link import("./session-state").SessionState} record. */
export interface SessionSetupResult {
  readonly provider: ReturnType<typeof pickProvider>
  readonly model: string
  readonly mode: PermissionMode
  readonly cwd: string
  readonly slog: StructuredLogger
  readonly idleMonitor: IdleMonitor
  readonly rejectCounter: RejectCounter
  readonly llm: LLMPort
  readonly planMode: boolean
  readonly metrics: Awaited<ReturnType<typeof loadFeatures>>["metrics"]
  readonly state: Awaited<ReturnType<typeof loadFeatures>>["state"]
  readonly mcpClients: Awaited<ReturnType<typeof loadFeatures>>["mcpClients"]
  readonly mcpTools: Awaited<ReturnType<typeof loadFeatures>>["mcpTools"]
  readonly mcpSurface: McpSurfaceInfo | undefined
  readonly skillsConfig: ReturnType<typeof buildTooling>["skillsConfig"]
  readonly lifecyclePills: LifecyclePills
  readonly lifecycleTaskRegistry: TaskRegistry | undefined
  readonly lifecycleFollowUpQueue: FollowUpQueue | undefined
  readonly sessionId: string | undefined
  readonly history: readonly Message[]
  readonly pendingImages: readonly ImageBlock[]
  readonly idMeta: Awaited<ReturnType<typeof resolveResume>>["idMeta"]
  readonly statusBar: StatusBar
  readonly turnIndicator: TurnIndicator
  readonly turnSummary: TurnSummaryCollector
  readonly sessionDeps: SessionDeps
  readonly costPanel: CostPanel | undefined
  readonly branchProgress: BranchProgressTracker | undefined
  readonly planStore: PlanStore | undefined
  readonly abort: AbortController
  readonly pills: ReturnType<typeof createStatusPills>
  readonly argPrompt: string | undefined
  /** Tear down MCP clients on REPL exit. The host calls this in the
   *  `finally` of `runRepl`. */
  readonly shutdownMcp: () => Promise<void>
}

/** First-block setup that runs ONCE per `runRepl` call. Performs every
 *  block from the prior `runRepl` prelude (lines ~967-1333 in the
 *  pre-split monolith) byte-identically:
 *
 *   1. provider / model / mode / cwd / slog
 *   2. idle + reject counters
 *   3. LLM stack (buildLLM → RetryingLLM → composeLLM)
 *   4. features (mcp/lsp/git/plan + observability), tooling, lifecycle bundle
 *   5. seed images + resolveResume + history/sessionId
 *   6. system prompt, shell observers, work-metrics sink
 *   7. status bar + turn-summary tee + turn-indicator tee
 *   8. S3 adapters (cost panel + branch progress + plan store)
 *   9. SessionDeps composition (fed to runOnce / runInteractive)
 *  10. status pills install
 *
 *  Returns the {@link SessionSetupResult} carrying every binding. The host
 *  is responsible for installing the `SIGINT` listener AROUND the abort
 *  controller; setup itself doesn't subscribe to process signals so a
 *  one-shot call (`quanta "<prompt>"`) doesn't double-register the handler. */
export const setupSession = async (deps: SetupSessionDeps): Promise<SessionSetupResult> => {
  const provider = pickProvider()
  const model = env("QUANTA_MODEL", DEFAULT_MODEL[provider])
  const maxTurns = Number(env("QUANTA_MAX_TURNS", "40"))
  const mode = env("QUANTA_PERMISSION", "default") as PermissionMode
  let cwd = process.cwd()
  const slog = new StructuredLogger()

  const { idleMonitor, rejectCounter } = buildIdleGuards()
  const permission: PermissionContext = { mode }
  const abort = new AbortController()
  process.on("SIGINT", () => {
    process.stderr.write("\n(interrupt — finishing current step)\n")
    abort.abort()
  })

  const finalLLM = buildLlmStack(provider, model, mode, permission, abort.signal, slog)

  const {
    planMode,
    metrics,
    state,
    resume,
    mcpTools,
    mcpClients,
    mcpConfigs,
    lspTools,
    lspNavTools,
    gitToolList,
  } = await loadFeatures(slog)

  const {
    pills: lifecyclePills,
    taskRegistry: lifecycleTaskRegistry,
    followUpQueue: lifecycleFollowUpQueue,
  } = deps.buildLifecycleBundle()

  const {
    store,
    embedder,
    sessionId: initialSessionId,
    registry,
    memoryConfig,
    subagentConfig,
    skillsConfig,
    compactionBreakerConfig,
    verifyGuardConfig,
  } = buildTooling(mcpTools, lspTools, lspNavTools, gitToolList, slog, lifecycleTaskRegistry)

  const mcpSurface = buildMcpSurfaceInfo({
    configs: mcpConfigs,
    bridgedTools: mcpTools,
    configPath: process.env.QUANTA_MCP_CONFIG,
  })

  if (mcpClients.length > 0) {
    lifecyclePills.update({
      mcp: { servers: [...deps.deriveMcpPillServers(mcpTools)] },
    })
  }

  let sessionId = initialSessionId
  const { stream, run } = buildStreaming(observeDir(), slog)

  const onConfirm = buildOnConfirm(idleMonitor, rejectCounter)

  const argPrompt = argvPrompt()
  // ADR-0083 multi-modal: load any `--image <path>` attachments ONCE. They
  // ride on the FIRST user turn only (see SessionState.pendingImages).
  const pendingImages: ImageBlock[] = loadSeedImages()

  const newSession = newSessionFlag()
  const inIdModeAtStart = newSession || (resume !== undefined && !isPathLikeToken(resume))
  if (!inIdModeAtStart) {
    logger.info(`quanta ready (provider=${provider}, model=${model}, mode=${mode}, cwd=${cwd})`)
  }
  const resolved = await resolveResume({
    resume,
    newSession,
    title: titleFlag(),
    cwd,
    initialSessionId: sessionId,
    slog,
    onSessionMinted: (id) => logger.info(`session: ${id}`),
  })
  if (resolved.conflictError !== undefined) {
    logger.error(resolved.conflictError)
    process.exit(1)
  }
  if (resolved.missingIdError !== undefined) {
    logger.error(`--resume: session id not found: ${resolved.missingIdError}`)
    process.exit(1)
  }
  const { idMeta } = resolved
  const history: Message[] = resolved.history
  sessionId = resolved.sessionId
  if (idMeta) cwd = switchToSessionCwd(cwd, idMeta.cwd, slog)
  if (inIdModeAtStart && idMeta) {
    logger.info(
      `quanta ready (provider=${provider}, model=${model}, mode=${mode}, cwd=${cwd}, session=${idMeta.id})`,
    )
  }

  const system = buildSystemPrompt(cwd, { persona: pickPersona() })
  const onShellEvent = composeShellEvent(metrics)
  const workMetricsSink = deps.buildWorkMetricsSink(metrics !== undefined)

  const home = homedir()
  const shortCwd = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
  const statusDefault = `${provider} · ${model} · ${mode} · ${shortCwd}    Esc Esc · cancel    Ctrl+C · exit`
  const statusBar = installStatusBar(statusDefault)

  const { collector: turnSummary, stream: summaryStream } = deps.buildTurnSummaryAndStream(
    stream,
    process.env,
    process.stdout.isTTY,
  )
  const { indicator: turnIndicator, turnStream } = deps.buildTurnIndicatorAndStream(
    statusBar,
    summaryStream,
    process.env,
    process.stdout.isTTY,
    env("QUANTA_SPINNER_INTERVAL_MS", "80"),
  )

  const costPanel = deps.buildCostPanelOrUndefined(process.env, process.stdout.isTTY, model)
  const branchProgress = deps.buildBranchProgressOrUndefined(process.env, process.stdout.isTTY)
  const planStore = deps.buildPlanStoreOrUndefined(process.env)

  const sessionDeps: SessionDeps = {
    llm: finalLLM,
    registry,
    stream: turnStream,
    permission,
    system,
    cwd,
    maxTurns,
    signal: abort.signal,
    onConfirm,
    store,
    sessionId,
    embedder,
    memoryConfig,
    planMode,
    metrics,
    run,
    subagentConfig,
    skillsConfig,
    compactionBreakerConfig,
    verifyGuardConfig,
    summarizerLlm: buildSummarizerLlm(provider, abort.signal),
    onShellEvent,
    workMetricsSink,
    ...(lifecycleFollowUpQueue !== undefined ? { followUpQueue: lifecycleFollowUpQueue } : {}),
    ...(planStore !== undefined ? { planStore } : {}),
  }

  const pills = deps.installPills({ statusBar, cwd, planMode, skillsConfig })

  const shutdownMcp = async (): Promise<void> => {
    for (const c of mcpClients) await c.stop().catch(() => undefined)
  }

  return {
    provider,
    model,
    mode,
    cwd,
    slog,
    idleMonitor,
    rejectCounter,
    llm: finalLLM,
    planMode,
    metrics,
    state,
    mcpClients,
    mcpTools,
    mcpSurface,
    skillsConfig,
    lifecyclePills,
    lifecycleTaskRegistry,
    lifecycleFollowUpQueue,
    sessionId,
    history,
    pendingImages,
    idMeta,
    statusBar,
    turnIndicator,
    turnSummary,
    sessionDeps,
    costPanel,
    branchProgress,
    planStore,
    abort,
    pills,
    argPrompt,
    shutdownMcp,
  }
}
