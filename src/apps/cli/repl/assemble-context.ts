import { homedir } from "node:os"
import * as readline from "node:readline/promises"
import { buildSystemPrompt, RetryingLLM } from "@/agent"
import type { FollowUpQueue } from "@/agent/follow-up-queue"
import type { ImageBlock, LLMPort, Message } from "@/llm"
import { buildShellOtelObserver, StructuredLogger } from "@/observability"
import type { PermissionContext, PermissionMode, ToolAction } from "@/permission"
import { logger } from "@/shared"
import type { TaskRegistry } from "@/subagent"
import { composeShellObservers } from "@/tool"
import { diffPreviewEnabled, renderActionDiff } from "../diff-preview"
import { createIdleMonitor, type IdleMonitor } from "../idle-monitor"
import {
  argvPrompt,
  buildLLM,
  buildStreaming,
  buildSummarizerLlm,
  buildTooling,
  composeLLM,
  DEFAULT_MODEL,
  env,
  loadFeatures,
  observeDir,
  pickPersona,
  pickProvider,
  type resolveResume,
  type SessionDeps,
} from "../internal"
import type { LifecyclePills } from "../lifecycle-pills"
import type { McpSurfaceInfo } from "../mcp-cmd"
import { createRejectCounter, type RejectCounter } from "../reject-counter"
import { buildShellStreamPainter } from "../shell-stream-painter"
import { installStatusBar, type StatusBar } from "../status-bar"
import type { createStatusPills } from "../status-pills"
import type { TurnIndicator } from "../turn-indicator"
import type { TurnSummaryCollector } from "../turn-summary"
import { buildLifecycleBundle, deriveMcpPillServers } from "./lifecycle-wire"
import { buildMcpSurfaceInfo } from "./mcp-surface-wire"
import { buildWorkMetricsSink } from "./metrics-sink"
import { driveResumeFsm } from "./resume-fsm"
import { loadSeedImages } from "./seed-images"
import { installPills } from "./status-pills-wire"
import { buildTurnIndicatorAndStream } from "./turn-indicator-wire"
import { buildTurnSummaryAndStream } from "./turn-summary-wire"

/** Fully-assembled REPL context. Owns the LLM stack, the lifecycle handles,
 *  the streaming tee chain, the status bar, and the `sessionDeps` consumed by
 *  runOnce/runInteractive. Returned by {@link assembleReplContext} so the two
 *  dispatch branches (one-shot vs interactive) share a single bundle. */
export interface ReplContext {
  readonly provider: ReturnType<typeof pickProvider>
  readonly model: string
  readonly slog: StructuredLogger
  readonly cwd: string
  readonly abort: AbortController
  readonly idleMonitor: IdleMonitor
  readonly rejectCounter: RejectCounter
  readonly planMode: boolean
  readonly metrics: Awaited<ReturnType<typeof loadFeatures>>["metrics"]
  readonly state: Awaited<ReturnType<typeof loadFeatures>>["state"]
  readonly skillsConfig: ReturnType<typeof buildTooling>["skillsConfig"]
  readonly lifecyclePills: LifecyclePills
  readonly lifecycleTaskRegistry: TaskRegistry | undefined
  readonly lifecycleFollowUpQueue: FollowUpQueue | undefined
  readonly statusBar: StatusBar
  readonly turnIndicator: TurnIndicator
  readonly turnSummary: TurnSummaryCollector
  readonly sessionDeps: SessionDeps
  readonly argPrompt: string | undefined
  pendingImages: ImageBlock[]
  history: Message[]
  readonly idMeta: Awaited<ReturnType<typeof resolveResume>>["idMeta"]
  readonly shutdownMcp: () => Promise<void>
  readonly pills: ReturnType<typeof createStatusPills>
  /** Snapshot for the `/mcp` slash command. Undefined when no MCP is wired
   *  in this surface ⇒ `/mcp` prints "not wired in this surface". */
  readonly mcpSurface: McpSurfaceInfo | undefined
}

/** Build the idle monitor + reject counter that the prompt-source idle gate
 *  and the permission onConfirm both observe. Default-ON; `QUANTA_IDLE_SUPPRESS=0`
 *  collapses both mechanisms to no-ops (`Infinity` thresholds). */
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
 *  composeLLM (fallback + auto-classifier). Default-OFF ⇒ `finalLLM === retryingLLM`
 *  byte-identical to the prior wiring. */
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

/** Compose the shell-event observer chain (painter + OTel). Returns `undefined`
 *  when neither observer is built so `runShell` skips event allocation entirely. */
const composeShellEvent = (
  metrics: Awaited<ReturnType<typeof loadFeatures>>["metrics"],
): SessionDeps["onShellEvent"] => {
  const painterObs = process.stdin.isTTY ? buildShellStreamPainter() : undefined
  const otelObs = metrics ? buildShellOtelObserver(metrics) : undefined
  return painterObs !== undefined || otelObs !== undefined
    ? composeShellObservers(painterObs, otelObs)
    : undefined
}

/** Build a fully-wired REPL context. Mirrors the prior monolithic prelude of
 *  `runRepl` byte-identically; the orchestration entry only branches on
 *  `argPrompt` after this returns. */
export const assembleReplContext = async (): Promise<ReplContext> => {
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
  } = buildLifecycleBundle()

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

  if (mcpClients.length > 0) {
    lifecyclePills.update({ mcp: { servers: deriveMcpPillServers(mcpTools) } })
  }

  // Snapshot the MCP surface for the `/mcp` slash command. The wire honors
  // `QUANTA_MCP_CONFIG` for the config-path render and gracefully reports
  // failed servers (configured but absent from `mcpClients`). The snapshot
  // is `undefined` when nothing is configured ⇒ `/mcp` prints the
  // "not wired in this surface" fallback (parity with `/skills`).
  const mcpSurface = buildMcpSurfaceInfo({
    configs: mcpConfigs,
    bridgedTools: mcpTools,
    configPath: process.env.QUANTA_MCP_CONFIG,
  })

  let sessionId = initialSessionId
  const { stream, run } = buildStreaming(observeDir(), slog)

  const shutdownMcpAll = async (): Promise<void> => {
    for (const c of mcpClients) await c.stop().catch(() => undefined)
  }

  const onConfirm = buildOnConfirm(idleMonitor, rejectCounter)

  const argPrompt = argvPrompt()
  const pendingImages: ImageBlock[] = loadSeedImages()

  const resumed = await driveResumeFsm({
    slog,
    provider,
    model,
    mode,
    cwd,
    initialSessionId: sessionId,
    resume,
  })
  cwd = resumed.cwd
  sessionId = resumed.sessionId
  const history: Message[] = resumed.history
  const { idMeta } = resumed

  const system = buildSystemPrompt(cwd, { persona: pickPersona() })
  const onShellEvent = composeShellEvent(metrics)
  const workMetricsSink = buildWorkMetricsSink(metrics !== undefined)

  const home = homedir()
  const shortCwd = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
  const statusDefault = `${provider} · ${model} · ${mode} · ${shortCwd}    Esc Esc · cancel    Ctrl+C · exit`
  const statusBar = installStatusBar(statusDefault)

  const { collector: turnSummary, stream: summaryStream } = buildTurnSummaryAndStream(
    stream,
    process.env,
    process.stdout.isTTY,
  )
  const { indicator: turnIndicator, turnStream } = buildTurnIndicatorAndStream(
    statusBar,
    summaryStream,
    process.env,
    process.stdout.isTTY,
    env("QUANTA_SPINNER_INTERVAL_MS", "80"),
  )

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
  }

  const pills = installPills({ statusBar, cwd, planMode, skillsConfig })

  return {
    provider,
    model,
    slog,
    cwd,
    abort,
    idleMonitor,
    rejectCounter,
    planMode,
    metrics,
    state,
    skillsConfig,
    lifecyclePills,
    lifecycleTaskRegistry,
    lifecycleFollowUpQueue,
    statusBar,
    turnIndicator,
    turnSummary,
    sessionDeps,
    argPrompt,
    pendingImages,
    history,
    idMeta,
    shutdownMcp: shutdownMcpAll,
    pills,
    mcpSurface,
  }
}
