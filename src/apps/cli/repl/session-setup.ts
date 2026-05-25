import * as readline from "node:readline/promises"
import { createOnConfirmReviewerPort } from "@/agent"
import type { FollowUpQueue } from "@/agent/follow-up-queue"
import type { PlanStore } from "@/agent/plan/state"
import { createClassifierBackedAutoReview } from "@/agent/reviewer-port"
import type { ImageBlock, LLMPort, Message } from "@/llm"
import type { StructuredLogger } from "@/observability"
import type { PermissionMode, ToolAction } from "@/permission"
import type { StreamPort } from "@/stream"
import type { TaskRegistry } from "@/subagent"
import type { BranchProgressTracker } from "../branch-search-progress"
import type { CostPanel } from "../cost-panel"
import { diffPreviewEnabled, renderActionDiff } from "../diff-preview"
import type { IdleMonitor } from "../idle-monitor"
import {
  buildShellSnapshotConfig,
  buildSummarizerLlm,
  type SessionDeps,
  type Tooling,
} from "../internal"
import type { LifecyclePills } from "../lifecycle-pills"
import type { McpSurfaceInfo } from "../mcp-cmd"
import type { RejectCounter } from "../reject-counter"
import { installStatusBar, type StatusBar } from "../status-bar"
import type { createStatusPills } from "../status-pills"
import type { TurnIndicator } from "../turn-indicator"
import type { TurnSummaryCollector } from "../turn-summary"
import {
  bootstrapSession,
  type SessionBootstrapDeps,
  type SessionBootstrapResult,
} from "./session-bootstrap"
import { createCliPlanExitPort, createCliUserInputPort } from "./session-host-ports"
import { readSessionRuntimeConfig } from "./session-runtime-config"

const askLine = async (prompt: string): Promise<string> => {
  const adhoc = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await adhoc.question(prompt)
  } finally {
    adhoc.close()
  }
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
    const ans = await askLine(`Allow ${action.tool}? [y/N] `)
    const accepted = ans.trim().toLowerCase() === "y"
    if (accepted) rejectCounter.recordAccept()
    else rejectCounter.recordDeny()
    idleMonitor.markActive()
    return accepted
  }

/** Inputs for {@link setupSession} — bundled so the call site stays narrow
 *  and tests can construct it with a small literal. */
export interface SetupSessionDeps extends SessionBootstrapDeps {
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
  readonly provider: SessionBootstrapResult["provider"]
  readonly model: string
  readonly mode: PermissionMode
  readonly cwd: string
  readonly slog: StructuredLogger
  readonly idleMonitor: IdleMonitor
  readonly rejectCounter: RejectCounter
  readonly llm: LLMPort
  readonly planMode: boolean
  readonly metrics: SessionBootstrapResult["features"]["metrics"]
  readonly state: SessionBootstrapResult["features"]["state"]
  readonly mcpClients: SessionBootstrapResult["features"]["mcpClients"]
  readonly mcpTools: SessionBootstrapResult["features"]["mcpTools"]
  readonly mcpSurface: McpSurfaceInfo | undefined
  readonly skillsConfig: Tooling["skillsConfig"]
  readonly lifecyclePills: LifecyclePills
  readonly lifecycleTaskRegistry: TaskRegistry | undefined
  readonly lifecycleFollowUpQueue: FollowUpQueue | undefined
  readonly sessionId: string
  readonly history: readonly Message[]
  readonly pendingImages: readonly ImageBlock[]
  readonly idMeta: SessionBootstrapResult["idMeta"]
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

/** Terminal host wiring over the bootstrap session core. All env/argv/feature
 *  resolution happens in {@link bootstrapSession}; this layer attaches the
 *  status chrome and interactive prompt-only ports. */
export const setupSession = async (deps: SetupSessionDeps): Promise<SessionSetupResult> => {
  const runtime = readSessionRuntimeConfig()
  const boot = await bootstrapSession(deps, runtime)

  process.on("SIGINT", () => {
    process.stderr.write("\n(interrupt — finishing current step)\n")
    boot.abort.abort()
  })

  const onConfirm = buildOnConfirm(boot.idleMonitor, boot.rejectCounter)
  const shortCwd = boot.cwd.startsWith(runtime.homeDir)
    ? `~${boot.cwd.slice(runtime.homeDir.length)}`
    : boot.cwd
  const statusDefault =
    `${boot.provider} · ${boot.model} · ${boot.mode} · ${shortCwd}` +
    "    Esc Esc · cancel    Ctrl+C · exit"
  const statusBar = installStatusBar(statusDefault)

  const { collector: turnSummary, stream: summaryStream } = deps.buildTurnSummaryAndStream(
    boot.stream,
    runtime.env,
    runtime.stdoutIsTTY,
  )
  const { indicator: turnIndicator, turnStream } = deps.buildTurnIndicatorAndStream(
    statusBar,
    summaryStream,
    runtime.env,
    runtime.stdoutIsTTY,
    runtime.spinnerIntervalMs,
  )

  const userReviewerPort = createOnConfirmReviewerPort({ onConfirm })
  const autoReview =
    boot.permission.classify !== undefined
      ? createClassifierBackedAutoReview({
          classify: boot.permission.classify,
          userReview: userReviewerPort.userReview,
        })
      : undefined
  const reviewerPort =
    autoReview !== undefined
      ? createOnConfirmReviewerPort({ onConfirm, autoReview })
      : userReviewerPort
  const planExitPort = createCliPlanExitPort({ ask: askLine })
  const userInputPort = createCliUserInputPort({ ask: askLine, stream: turnStream })
  const sessionDeps: SessionDeps = {
    llm: boot.llm,
    registry: boot.tooling.registry,
    stream: turnStream,
    permission: boot.permission,
    system: boot.system,
    cwd: boot.cwd,
    maxTurns: boot.maxTurns,
    signal: boot.abort.signal,
    onConfirm,
    store: boot.tooling.store,
    sessionId: boot.sessionId,
    embedder: boot.tooling.embedder,
    memoryConfig: boot.tooling.memoryConfig,
    planMode: boot.features.planMode,
    metrics: boot.features.metrics,
    run: boot.run,
    subagentConfig: boot.tooling.subagentConfig,
    skillsConfig: boot.tooling.skillsConfig,
    compactionBreakerConfig: boot.tooling.compactionBreakerConfig,
    verifyGuardConfig: boot.tooling.verifyGuardConfig,
    summarizerLlm: buildSummarizerLlm(boot.provider, boot.abort.signal),
    admissibility: {
      reviewerPort,
      defaultReviewer: autoReview !== undefined ? "auto_review" : "user",
    },
    planExitPort,
    userInputPort,
    onShellEvent: boot.onShellEvent,
    workMetricsSink: boot.workMetricsSink,
    ...(boot.lifecycleFollowUpQueue !== undefined
      ? { followUpQueue: boot.lifecycleFollowUpQueue }
      : {}),
    ...(boot.planStore !== undefined ? { planStore: boot.planStore } : {}),
    // ADR-0237 — per-turn shell-snapshot composition root opt-in. Returns
    // `undefined` when `QUANTA_SHELL_SNAPSHOT` is unset (and `--shell-snapshot`
    // is absent), so the conditional spread keeps the assembled `AgentConfig`
    // byte-identical to the legacy default-OFF shape. When enabled, the helper
    // builds a Bun-spawner backed `ShellSnapshotPort` and forwards the 5-knob
    // block (shell / captureAtTurnStart / cleanupOlderThanMs / maxSizeBytes /
    // shellEnv) — see `internal.ts#buildShellSnapshotConfig` for the env map.
    ...((): { shellSnapshot?: SessionDeps["shellSnapshot"] } => {
      const cfg = buildShellSnapshotConfig()
      return cfg !== undefined ? { shellSnapshot: cfg } : {}
    })(),
  }

  const pills = deps.installPills({
    statusBar,
    cwd: boot.cwd,
    planMode: boot.features.planMode,
    skillsConfig: boot.tooling.skillsConfig,
  })

  return {
    provider: boot.provider,
    model: boot.model,
    mode: boot.mode,
    cwd: boot.cwd,
    slog: boot.slog,
    idleMonitor: boot.idleMonitor,
    rejectCounter: boot.rejectCounter,
    llm: boot.llm,
    planMode: boot.features.planMode,
    metrics: boot.features.metrics,
    state: boot.features.state,
    mcpClients: boot.features.mcpClients,
    mcpTools: boot.features.mcpTools,
    mcpSurface: boot.mcpSurface,
    skillsConfig: boot.tooling.skillsConfig,
    lifecyclePills: boot.lifecyclePills,
    lifecycleTaskRegistry: boot.lifecycleTaskRegistry,
    lifecycleFollowUpQueue: boot.lifecycleFollowUpQueue,
    sessionId: boot.sessionId,
    history: boot.history,
    pendingImages: boot.pendingImages,
    idMeta: boot.idMeta,
    statusBar,
    turnIndicator,
    turnSummary,
    sessionDeps,
    costPanel: boot.costPanel,
    branchProgress: boot.branchProgress,
    planStore: boot.planStore,
    abort: boot.abort,
    pills,
    argPrompt: boot.argPrompt,
    shutdownMcp: boot.shutdownMcp,
  }
}
