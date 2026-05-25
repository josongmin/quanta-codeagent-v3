import type { FollowUpQueue } from "@/agent/follow-up-queue"
import type { PlanStore } from "@/agent/plan/state"
import type { ImageBlock, LLMPort, Message } from "@/llm"
import type { StructuredLogger } from "@/observability"
import type { PermissionMode, PermissionStore } from "@/permission"
import type { StreamPort } from "@/stream"
import type { TaskRegistry } from "@/subagent"
import type { BranchProgressTracker } from "../branch-search-progress"
import type { CostPanel } from "../cost-panel"
import type { DebugCmdState } from "../debug-cmd"
import type { IdleMonitor } from "../idle-monitor"
import type { SessionDeps, Tooling } from "../internal"
import type { LifecyclePills } from "../lifecycle-pills"
import type { McpSurfaceInfo } from "../mcp-cmd"
import type { RejectCounter } from "../reject-counter"
import { clearFsJailDecisionSink, setFsJailDecisionSink } from "@/storage"
import { installStatusBar, type StatusBar } from "../status-bar"
import type { createStatusPills } from "../status-pills"
import type { TimelinePanel } from "../timeline-panel"
import type { TurnIndicator } from "../turn-indicator"
import type { TurnSummaryCollector } from "../turn-summary"
import {
  bootstrapSession,
  type SessionBootstrapDeps,
  type SessionBootstrapResult,
} from "./session-bootstrap"
import { composeCliSessionDeps } from "./session-deps-compose"
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
  /** Track D — build the debug-tracer + tee-wrap the stream. Returns
   *  `{stream, debugHandle: undefined}` (literal input ref) when the
   *  boot env disables the tracer, so the tee consumer count is
   *  byte-identical to today's; returns a wrapped stream + a live
   *  handle when enabled so `/debug` runtime toggles affect emission. */
  readonly buildDebugTracerAndStream: (
    stream: StreamPort,
    envSource: NodeJS.ProcessEnv,
    isTTY: boolean | undefined,
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
    stream: StreamPort,
    envSource: NodeJS.ProcessEnv,
    isTTY: boolean | undefined,
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
  /** Track D — present iff `QUANTA_DEBUG` enabled the debug tracer at
   *  boot AND stderr is a TTY. Absent ⇒ `/debug` slash prints "not wired". */
  readonly debugHandle: DebugTracerHandle | undefined
  /** Track T — present iff `QUANTA_TIMELINE=<N>` (N > 0) enabled the
   *  ring-buffer panel at boot AND stderr is a TTY. The host calls
   *  `panel.teardown()` in `runRepl`'s `finally` so subsequent prompts
   *  land on a clean screen. Absent ⇒ no tee allocated (byte-identical
   *  default-OFF). */
  readonly timelinePanel: TimelinePanel | undefined
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
  /** ADR-0301 — `--playbook-trigger` CLI flag echo (forwarded from the
   *  bootstrap layer). When `true`, the host threads this into
   *  `runSessionLoop({ playbookCliFlag })` so
   *  `maybeStartPlaybookTriggerWire` opts in even when
   *  `QUANTA_PLAYBOOK_TRIGGER` is unset. `undefined` ⇒ slot omitted at the
   *  loop call site (default-OFF byte-identical). */
  readonly playbookCliFlag: boolean | undefined
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
  // Track D — interpose the debug tracer BEFORE the indicator so the
  // debug emit sees the same upstream events the indicator does. When
  // the env disables it, the builder returns the literal `summaryStream`
  // and `debugHandle: undefined` (byte-identical, no extra tee).
  const { stream: debugStream, debugHandle } = deps.buildDebugTracerAndStream(
    summaryStream,
    runtime.env,
    process.stderr.isTTY,
  )
  // Track T — interpose the timeline panel AFTER the debug tracer and
  // BEFORE the indicator so the ring buffer sees the same upstream
  // events both consumers do. When `QUANTA_TIMELINE` is unset / 0 /
  // non-TTY the builder returns the literal `debugStream` + `panel:
  // undefined` ⇒ byte-identical to pre-T code (no extra tee).
  const { stream: timelineStream, panel: timelinePanel } = deps.buildTimelinePanelAndStream(
    debugStream,
    runtime.env,
    process.stderr.isTTY,
  )
  const { indicator: turnIndicator, turnStream } = deps.buildTurnIndicatorAndStream(
    statusBar,
    timelineStream,
    runtime.env,
    runtime.stdoutIsTTY,
    runtime.spinnerIntervalMs,
  )

  const { sessionDeps } = await composeCliSessionDeps({
    boot,
    turnStream,
    loadPermissionStore: deps.loadPermissionStore,
    sandboxProfile: runtime.sandboxProfile,
  })
  // ADR-0269 Phase 3 closure — install the process-level fs-jail decision
  // sink. fs-jail (storage/service.ts) can't import @/stream (slice-fence),
  // so it carries a module-level sink slot the composition root fills with
  // the *same* DecisionEmitter that's now in `sessionDeps.decisionEmitter`.
  // FsJailDecisionEvent is a structural mirror of DecisionEvent so both
  // ends type-check without a cross-slice import. The matching
  // `clearFsJailDecisionSink()` is wrapped into `shutdownMcp` below so
  // session-end tears it down before sibling processes (or a re-entered
  // setupSession in tests) inherit a stale sink.
  if (sessionDeps.decisionEmitter !== undefined) {
    setFsJailDecisionSink(sessionDeps.decisionEmitter)
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

  return {
    provider: boot.provider,
    model: boot.model,
    mode: boot.mode,
    cwd: boot.cwd,
    slog: boot.slog,
    idleMonitor: boot.idleMonitor,
    rejectCounter: boot.rejectCounter,
    effortStore: boot.effortStore,
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
    debugHandle,
    timelinePanel,
    sessionDeps,
    costPanel: boot.costPanel,
    branchProgress: boot.branchProgress,
    planStore: boot.planStore,
    abort: boot.abort,
    pills,
    argPrompt: boot.argPrompt,
    shutdownMcp: async () => {
      // ADR-0269 Phase 3 closure — clear the fs-jail sink BEFORE MCP
      // teardown so a sibling/re-entered session never inherits this
      // run's emitter (the slot is process-global by slice-fence design).
      clearFsJailDecisionSink()
      await boot.shutdownMcp()
    },
    // ADR-0301 — forward the CLI flag echo so `runRepl` can hand it to
    // `runSessionLoop({ playbookCliFlag })`. Bootstrap maps absent → undefined
    // already; we just propagate the same shape.
    playbookCliFlag: boot.playbookCliFlag,
  }
}
