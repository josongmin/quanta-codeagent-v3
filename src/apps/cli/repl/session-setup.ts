import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import type { FollowUpQueue } from "@/agent/follow-up-queue"
import type { PlanStore } from "@/agent/plan/state"
import {
  bootstrapSession,
  type SessionBootstrapDeps,
  type SessionBootstrapResult,
} from "@/host/bootstrap"
import type { ImageBlock, LLMPort, Message, ResponsesContinuationStore } from "@/llm"
import type { StructuredLogger } from "@/observability"
import type { PermissionMode, PermissionStore } from "@/permission"
import type { PendingApprovalView } from "@/protocol/session"
import type { ApprovalDecisionResult } from "@/runner/orchestrate"
import type { RuntimeContext } from "@/sdk/runtime"
import { runtimeConfig } from "@/shared"
import { clearFsJailDecisionSink, setFsJailDecisionSink } from "@/storage"
import type { StreamPort } from "@/stream"
import type { TaskRegistry } from "@/subagent"
import type { BranchProgressTracker } from "../branch-search-progress"
import type { CostPanel } from "../cost-panel"
import type { DebugCmdState } from "../debug-cmd"
import type { IdleMonitor } from "../idle-monitor"
import type { Tooling } from "../internal"
import type { LifecyclePills } from "../lifecycle-pills"
import type { McpSurfaceInfo } from "../mcp-cmd"
import type { RejectCounter } from "../reject-counter"
import { installStatusBar, type StatusBar } from "../status-bar"
import type { SessionStatusView } from "../status-command-runner"
import { createStatusLineDriver, type StatusLineDriver } from "../status-line-driver"
import type { createStatusPills } from "../status-pills"
import type { TimelinePanel } from "../timeline-panel"
import type { TurnIndicator } from "../turn-indicator"
import type { TurnSummaryCollector } from "../turn-summary"
import { type CliFeatureConfig, readCliFeatureConfig } from "./cli-feature-config"
import { type ContextUsageHolder, createContextUsageHolder } from "./context-usage-snapshot"
import { maybeRunEnvProbeWire } from "./env-probe-wire"
import type { IndicatorUsageObserver } from "./factories/indicator-stream-port"
import { composeCliRuntimeContext } from "./runtime-context-compose"
import { readSessionRuntimeConfig } from "./session-runtime-config"
/** Track D — DebugTracerHandle. Surface owns the live state + the
 *  swap-in/out side effect (mutable proxy port in the stream tee).
 *  The slash adapter consumes ONLY {@link DebugCmdState} I/O — it never
 *  touches the stream layer. Absent ⇒ `QUANTA_DEBUG` was unset (or
 *  parsed disabled / non-TTY) at boot, so no tee consumer was
 *  allocated; the `/debug` slash then prints "not wired" + exits 0. */
export interface DebugTracerHandle {
  readonly get: () => DebugCmdState
  readonly set: (state: DebugCmdState) => void
}

/** Inputs for {@link setupSession} — bundled so the call site stays narrow
 *  and tests can construct it with a small literal. */
export interface SetupSessionDeps extends SessionBootstrapDeps {
  /** Load the host-owned permission store. The CLI injects the process
   *  singleton; tests inject an isolated fake/store so `setupSession`
   *  never reaches global disk state directly. */
  readonly loadPermissionStore: () => Promise<PermissionStore | undefined>
  /** Build the per-turn turn-summary collector + stream tee. */
  readonly buildTurnSummaryAndStream: (
    featureCfg: CliFeatureConfig,
    stream: StreamPort,
  ) => { collector: TurnSummaryCollector; stream: StreamPort }
  /** Build the live turn indicator + indicator-tee'd stream. S3 (jul-03) — the
   *  optional `usageObserver` is threaded onto the indicator port so a live
   *  `usage` AgentEvent's reasoning-token split feeds the `/context` gauge
   *  holder (absent ⇒ no feed, byte-identical). */
  readonly buildTurnIndicatorAndStream: (
    featureCfg: CliFeatureConfig,
    statusBar: StatusBar,
    stream: StreamPort,
    usageObserver?: IndicatorUsageObserver,
  ) => { indicator: TurnIndicator; turnStream: StreamPort }
  /** Track D — build the debug-tracer + tee-wrap the stream. Returns
   *  `{stream, debugHandle: undefined}` (literal input ref) when the
   *  boot env disables the tracer, so the tee consumer count is
   *  byte-identical to today's; returns a wrapped stream + a live
   *  handle when enabled so `/debug` runtime toggles affect emission. */
  readonly buildDebugTracerAndStream: (
    featureCfg: CliFeatureConfig,
    stream: StreamPort,
  ) => { stream: StreamPort; debugHandle: DebugTracerHandle | undefined }
  /** Track T — build the timeline panel + tee-wrap the stream. Returns
   *  `{stream, panel: undefined}` (literal input ref) when
   *  `QUANTA_TIMELINE` is unset / 0 / non-finite OR stderr is not a TTY,
   *  so the tee consumer count is byte-identical to pre-T code; returns a
   *  wrapped stream + a live panel when enabled so the ring-buffer
   *  receives every `AgentEvent`. The host calls `panel.teardown()` in
   *  its `runRepl` `finally` so a follow-on shell prompt lands on a
   *  clean screen. */
  readonly buildTimelinePanelAndStream: (
    featureCfg: CliFeatureConfig,
    stream: StreamPort,
  ) => { stream: StreamPort; panel: TimelinePanel | undefined }
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
  /** Session-level reasoning-effort store (forwarded from bootstrap so the
   *  REPL surface composer can wire `/effort` against the SAME instance the
   *  loop reads via `AgentConfig.sessionEffort`). */
  readonly effortStore: import("@/agent").EffortStore
  // #17 (Agent-B, additive) — brief-mode store forwarded from bootstrap so the
  // REPL surface composer can wire `/brief` against the SAME instance the loop
  // reads via `AgentConfig.sessionBrief`. Mirrors `effortStore`.
  readonly briefStore: import("@/agent").BriefStore
  readonly llm: LLMPort
  readonly planMode: boolean
  readonly metrics: SessionBootstrapResult["features"]["metrics"]
  readonly state: SessionBootstrapResult["features"]["state"]
  readonly mcpClients: SessionBootstrapResult["features"]["mcpClients"]
  readonly mcpTools: SessionBootstrapResult["features"]["mcpTools"]
  readonly mcpSurface: McpSurfaceInfo | undefined
  readonly skillsConfig: Tooling["skillsConfig"]
  /** `/memory` slash store — the SAME {@link PersistentStorePort} the loop
   *  reads (built once in `tooling`). Absent ⇒ no store (`QUANTA_MEMORY=off`)
   *  ⇒ the `/memory` slash prints "not wired". Forwarded from
   *  `boot.tooling.store` so the slash and the agent share ONE store. */
  readonly memoryStore: Tooling["store"]
  /** Optional embedder for `/memory search` semantic recall (same instance
   *  the loop's recall uses). Absent ⇒ lexical-only fallback. */
  readonly memoryEmbedder: Tooling["embedder"]
  /** A3 (jul-04 CLI-surfacing) `/kb` — the SAME {@link ProjectsKbStore} the
   *  `projects_kb` tool was registered over (built once in `tooling` when
   *  `QUANTA_PROJECTS_KB` is on). Forwarded from `boot.tooling.projectsKbStore` so
   *  the surface wires the `/kb` slash over the EXACT instance the tool writes into
   *  (one store, both consumers). Absent ⇒ the tool was not registered ⇒ `/kb`
   *  prints "not wired" (byte-identical default-OFF). */
  readonly projectsKbStore: Tooling["projectsKbStore"]
  /** B4 (jul-04 CLI-surfacing) `/mcp-resources` — the SAME bounded capture holder
   *  the `mcp_read_resource_dir` / `mcp_read_resource` tools write each fetch into
   *  (present iff `QUANTA_MCP_RESOURCES` is on + a capable server). Narrowed from
   *  the host-opaque `boot.features` back to the CLI `Features` shape (the host
   *  forwards it as `BootstrapFeatures`, which does not carry the field). The
   *  surface wires `/mcp-resources` over the EXACT ring the tools write into (one
   *  holder, both consumers). Absent ⇒ `/mcp-resources` prints "not wired". */
  readonly mcpResourceCapture: import("@/tool").McpResourceCaptureHolder | undefined
  /** L5 M-11 — per-session search-wire teardown (delta-scan interval + indexer)
   *  forwarded from `boot.tooling`. The host threads this into
   *  `runSessionLoop({ searchPipelineDispose })` so session close releases THIS
   *  session's wire (not a module singleton). Absent ⇒ no wire was built. */
  readonly searchPipelineDispose: Tooling["searchPipelineDispose"]
  readonly lifecyclePills: LifecyclePills
  readonly lifecycleTaskRegistry: TaskRegistry | undefined
  /** jun-15 P0-b — session Activity Spine store; `/activity` reads it +
   *  `run_workflow` writes its live run into the SAME instance. */
  readonly lifecycleActivityStore: import("@/activity").ActivityStore
  readonly lifecycleFollowUpQueue: FollowUpQueue | undefined
  readonly sessionId: string
  readonly history: readonly Message[]
  readonly pendingImages: readonly ImageBlock[]
  readonly idMeta: SessionBootstrapResult["idMeta"]
  readonly statusBar: StatusBar
  readonly turnIndicator: TurnIndicator
  /** Track D / S3 — the `/context` gauge holder, created at setup so its
   *  `observeUsage` rides the indicator tee (live `usage` AgentEvent →
   *  reasoning-token split). surface-compose consumes THIS instance for the
   *  `/context` `contextUsage` slot + the `onPromptAssembled` sink so the
   *  gauge reads the same retained snapshot the tee feeds. */
  readonly contextUsageHolder: ContextUsageHolder
  readonly turnSummary: TurnSummaryCollector
  /** Track D — present iff `QUANTA_DEBUG` enabled the debug tracer at
   *  boot AND stderr is a TTY. Absent ⇒ `/debug` slash prints "not wired". */
  readonly debugHandle: DebugTracerHandle | undefined
  /** Track T — present iff `QUANTA_TIMELINE=<N>` (N > 0) enabled the
   *  ring-buffer panel at boot AND stderr is a TTY. The host calls
   *  `panel.teardown()` in `runRepl`'s `finally` so subsequent prompts
   *  land on a clean screen. Absent ⇒ no tee allocated (byte-identical
   *  default-OFF). */
  readonly timelinePanel: TimelinePanel | undefined
  readonly approvalPrompt: (approval: PendingApprovalView) => Promise<ApprovalDecisionResult>
  readonly midTurnApprovalChannel: import("./mid-turn-approval-channel").MidTurnApprovalChannel
  readonly runtimeContext: RuntimeContext
  readonly costPanel: CostPanel | undefined
  readonly branchProgress: BranchProgressTracker | undefined
  readonly planStore: PlanStore | undefined
  readonly abort: AbortController
  readonly pills: ReturnType<typeof createStatusPills>
  readonly argPrompt: string | undefined
  /** ADR-0297 fence — the host (`repl.ts`) may not read `process` directly;
   *  these surface facts are resolved ONCE at this layer (which owns the
   *  process reads) and consumed as plain data by the host's interactive-only
   *  gates (welcome banner, crash-resume reinject offer). */
  readonly stderrIsTTY: boolean | undefined
  /** `$HOME` snapshot for ~-shortening (empty string => unknown). */
  readonly homeDir: string
  readonly systemSource: SessionBootstrapResult["systemSource"]
  readonly refreshSystemPrompt: SessionBootstrapResult["refreshSystemPrompt"]
  /** Tear down MCP clients on REPL exit. The host calls this in the
   *  `finally` of `runRepl`. */
  readonly shutdownMcp: () => Promise<void>
  /** ADR-0301 — `--playbook-trigger` CLI flag echo (forwarded from the
   *  bootstrap layer). When `true`, the host threads this into
   *  `runSessionLoop({ playbookCliFlag })` so
   *  `maybeStartPlaybookTriggerWire` opts in even when
   *  `QUANTA_PLAYBOOK_TRIGGER` is unset. `undefined` ⇒ slot omitted at the
   *  loop call site (default-OFF byte-identical). */
  readonly playbookCliFlag: boolean | undefined
  /** ADR-0297 — the typed, surface-level feature config resolved once at
   *  setup time and threaded through to the host's `build*` factories
   *  (`buildImageQueue`, `buildPromptUx`, `buildRewindSlashState`). */
  readonly featureCfg: CliFeatureConfig
}

/** Terminal host wiring over the bootstrap session core. All env/argv/feature
 *  resolution happens in {@link bootstrapSession}; this layer attaches the
 *  status chrome and interactive prompt-only ports. */
export const setupSession = async (
  deps: SetupSessionDeps,
  options: {
    readonly convStore?: ConversationCheckpointStore
    readonly responsesStore?: ResponsesContinuationStore
  } = {},
): Promise<SessionSetupResult> => {
  const runtime = readSessionRuntimeConfig()
  const featureCfg = readCliFeatureConfig(runtime.env, runtime.stdoutIsTTY, process.stderr.isTTY)
  const boot = await bootstrapSession(deps, runtime, featureCfg)

  process.on("SIGINT", () => {
    process.stderr.write("\n(interrupt — finishing current step)\n")
    boot.abort.abort()
  })

  const shortCwd = boot.cwd.startsWith(runtime.homeDir)
    ? `~${boot.cwd.slice(runtime.homeDir.length)}`
    : boot.cwd
  const statusDefault =
    `${boot.provider} · ${boot.model} · ${boot.mode} · ${shortCwd}` +
    "    Esc Esc · cancel    Ctrl+C · exit"
  const statusBar = installStatusBar(statusDefault)

  const { collector: turnSummary, stream: summaryStream } = deps.buildTurnSummaryAndStream(
    featureCfg,
    boot.stream,
  )
  // Track D — interpose the debug tracer BEFORE the indicator so the
  // debug emit sees the same upstream events the indicator does. When
  // the env disables it, the builder returns the literal `summaryStream`
  // and `debugHandle: undefined` (byte-identical, no extra tee).
  const { stream: debugStream, debugHandle } = deps.buildDebugTracerAndStream(
    featureCfg,
    summaryStream,
  )
  // Track T — interpose the timeline panel AFTER the debug tracer and
  // BEFORE the indicator so the ring buffer sees the same upstream
  // events both consumers do. When `QUANTA_TIMELINE` is unset / 0 /
  // non-TTY the builder returns the literal `debugStream` + `panel:
  // undefined` ⇒ byte-identical to pre-T code (no extra tee).
  const { stream: timelineStream, panel: timelinePanel } = deps.buildTimelinePanelAndStream(
    featureCfg,
    debugStream,
  )
  // Track D / S3 — the `/context` gauge holder. Created HERE (before the
  // indicator tee) so its `observeUsage` can ride the indicator port that
  // already consumes the live `usage` AgentEvent (the ordering constraint: the
  // stream tee is built at setup time, but the holder was historically created
  // later in surface-compose — hence the split flowed wire→event but nothing
  // fed the holder). Its `sink`/`view` are forwarded on the result so
  // surface-compose wires `/context` + `onPromptAssembled` against the SAME
  // instance. `observeUsage` retains only a real reasoning split (absent ⇒
  // no-op), so the tee stays byte-identical for providers with no split.
  const contextUsageHolder = createContextUsageHolder()
  const { indicator: turnIndicator, turnStream } = deps.buildTurnIndicatorAndStream(
    featureCfg,
    statusBar,
    timelineStream,
    { observeUsage: contextUsageHolder.observeUsage },
  )

  const { approvalPrompt, midTurnApprovalChannel, runtimeContext } = await composeCliRuntimeContext(
    {
      boot,
      turnStream,
      loadPermissionStore: deps.loadPermissionStore,
      sandboxProfile: runtime.sandboxProfile,
      ...(options.convStore !== undefined ? { convStore: options.convStore } : {}),
      ...(options.responsesStore !== undefined ? { responsesStore: options.responsesStore } : {}),
      envSource: runtime.env,
    },
  )
  // ADR-0269 Phase 3 closure — install the process-level fs-jail decision
  // sink. fs-jail (storage/service.ts) can't import @/stream (slice-fence),
  // so it carries a module-level sink slot the composition root fills with
  // the *same* DecisionEmitter that's now on the runtime bridge.
  // FsJailDecisionEvent is a structural mirror of DecisionEvent so both
  // ends type-check without a cross-slice import. The matching
  // `clearFsJailDecisionSink()` is wrapped into `shutdownMcp` below so
  // session-end tears it down before sibling processes (or a re-entered
  // setupSession in tests) inherit a stale sink.
  const decisionEmitter = runtimeContext.decisionEmitter()
  if (decisionEmitter !== undefined) {
    setFsJailDecisionSink(decisionEmitter)
  }

  const pills = deps.installPills({
    statusBar,
    cwd: boot.cwd,
    planMode: boot.features.planMode,
    skillsConfig: boot.tooling.skillsConfig,
  })
  // Reflect the boot-time effort tier on the pill the moment install is
  // done. `installPills` ALSO reads `QUANTA_EFFORT` for its own initial
  // state today (skills-surface.ts), so this is a defensive sync — if the
  // pill module switches to reading from the store instead, the call
  // remains a no-op (same value re-applied).
  pills.update({ effort: boot.effortStore.get() })

  // #15 — scriptable statusLine driver (the missing prod consumer). DOUBLE-gated
  // default-OFF: `runtimeConfig().statusLineConfig` is `undefined` unless
  // `QUANTA_STATUS_LINE` is on AND a valid `QUANTA_STATUS_LINE_CONFIG` parses, so
  // OFF ⇒ no driver, no view thunk, no poll ⇒ byte-identical. When ON, the
  // command's first line is routed into the pills row as the far-right segment
  // (NOT a direct `setDefault`, which would clobber the pill composer).
  const statusLineCfg = runtimeConfig().statusLineConfig
  let statusLineDriver: StatusLineDriver | undefined
  if (statusLineCfg !== undefined) {
    const costPanel = boot.costPanel as CostPanel | undefined
    const statusView = (): SessionStatusView => {
      const cost = costPanel?.snapshot()
      return {
        ...(boot.sessionId !== undefined ? { sessionId: boot.sessionId } : {}),
        cwd: boot.cwd,
        currentDir: boot.cwd,
        modelId: boot.model,
        modelDisplayName: boot.model,
        effortLevel: boot.effortStore.get(),
        ...(cost?.totalCostUsd != null ? { totalCostUsd: cost.totalCostUsd } : {}),
      }
    }
    statusLineDriver = createStatusLineDriver({
      cfg: statusLineCfg,
      view: statusView,
      pills,
      width: process.stdout.columns ?? 0,
    })
    void statusLineDriver.tick() // initial paint (async, non-blocking)
    statusLineDriver.start() // poll iff the config carries refreshInterval
  }

  // ADR-0466 — one-shot startup environment probe. Default-OFF: a no-op that
  // builds no exec port and spawns nothing unless QUANTA_ENABLE_ENV_PROBE="1".
  // Awaited so a degradation notice (missing toolchain / test runner) lands
  // before the first prompt; no-throw (worst case: empty warnings).
  await maybeRunEnvProbeWire({ env: runtime.env, logger: boot.slog, stream: turnStream })

  // ADR-0292 — narrow the host's opaque ports back to their CLI-surface
  // concrete types at the seam. The host result types them as `unknown`
  // because it only forwards them through; the CLI surface owns the real
  // shapes (concrete McpClient instances, the surface `LifecyclePills`,
  // the surface `IdleMonitor` etc.).
  return {
    provider: boot.provider,
    model: boot.model,
    mode: boot.mode,
    cwd: boot.cwd,
    slog: boot.slog,
    idleMonitor: boot.idleMonitor as IdleMonitor,
    rejectCounter: boot.rejectCounter as RejectCounter,
    effortStore: boot.effortStore,
    // #17 (Agent-B, additive) — forward the bootstrap brief-mode store.
    briefStore: boot.briefStore,
    llm: boot.llm,
    planMode: boot.features.planMode,
    metrics: boot.features.metrics,
    state: boot.features.state,
    mcpClients: boot.features.mcpClients as unknown as SessionSetupResult["mcpClients"],
    mcpTools: boot.features.mcpTools,
    mcpSurface: boot.mcpSurface as McpSurfaceInfo | undefined,
    skillsConfig: boot.tooling.skillsConfig,
    memoryStore: boot.tooling.store,
    memoryEmbedder: boot.tooling.embedder,
    // A3 (jul-04) — forward the minted KB store so `/kb` reads the SAME instance
    // the `projects_kb` tool writes into. Absent (gate off) ⇒ `/kb` "not wired".
    projectsKbStore: boot.tooling.projectsKbStore,
    // B4 (jul-04) — narrow the host-opaque `boot.features` back to the CLI
    // `Features` shape to read the capture holder the mcp resource tools write
    // into (the host forwards `Features` as `BootstrapFeatures`, which does not
    // declare the field, but the runtime object still carries it — mirrors the
    // `mcpClients` narrow below). Absent ⇒ `/mcp-resources` "not wired".
    mcpResourceCapture: (boot.features as unknown as import("../internal/mcp").Features)
      .mcpResourceCapture,
    searchPipelineDispose: boot.tooling.searchPipelineDispose,
    lifecyclePills: boot.lifecyclePills as unknown as LifecyclePills,
    lifecycleTaskRegistry: boot.lifecycleTaskRegistry,
    lifecycleActivityStore: boot.lifecycleActivityStore,
    lifecycleFollowUpQueue: boot.lifecycleFollowUpQueue,
    sessionId: boot.sessionId,
    history: boot.history,
    pendingImages: boot.pendingImages,
    idMeta: boot.idMeta,
    statusBar,
    turnIndicator,
    contextUsageHolder,
    turnSummary,
    debugHandle,
    timelinePanel,
    approvalPrompt,
    midTurnApprovalChannel,
    runtimeContext,
    costPanel: boot.costPanel as CostPanel | undefined,
    branchProgress: boot.branchProgress as BranchProgressTracker | undefined,
    planStore: boot.planStore,
    abort: boot.abort,
    pills,
    argPrompt: boot.argPrompt,
    stderrIsTTY: process.stderr.isTTY,
    homeDir: runtime.homeDir,
    systemSource: boot.systemSource,
    refreshSystemPrompt: boot.refreshSystemPrompt,
    shutdownMcp: async () => {
      // ADR-0269 Phase 3 closure — clear the fs-jail sink BEFORE MCP
      // teardown so a sibling/re-entered session never inherits this
      // run's emitter (the slot is process-global by slice-fence design).
      clearFsJailDecisionSink()
      // #15 — stop the status-line poll on session end (idempotent; undefined
      // when the feature is gated off).
      statusLineDriver?.stop()
      await boot.shutdownMcp()
    },
    // ADR-0301 — forward the CLI flag echo so `runRepl` can hand it to
    // `runSessionLoop({ playbookCliFlag })`. Bootstrap maps absent → undefined
    // already; we just propagate the same shape.
    playbookCliFlag: boot.playbookCliFlag,
    featureCfg,
  }
}
