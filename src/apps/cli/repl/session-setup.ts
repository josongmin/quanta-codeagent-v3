import { join } from "node:path"
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
import { buildSkillRuntimeAuthority } from "@/runner/assemble/session-authorities"
import type { ApprovalDecisionResult } from "@/runner/orchestrate"
import type { RuntimeContext } from "@/sdk/runtime"
import { errMessage, gateOn, logger, quantaHomeDirFrom, runtimeConfig } from "@/shared"
import type { SkillRuntimeAuthority } from "@/skill"
import { clearFsJailDecisionSink, setFsJailDecisionSink } from "@/storage"
import type { AgentEvent, StreamPort } from "@/stream"
import type { TaskRegistry } from "@/subagent"
import type { BranchProgressTracker } from "../branch-search-progress"
import type { CostPanel } from "../cost-panel"
import type { DebugCmdState } from "../debug-cmd"
import type { IdleMonitor } from "../idle-monitor"
import type { Tooling } from "../internal"
import type { LifecyclePills } from "../lifecycle-pills"
import type { McpSurfaceInfo } from "../mcp-cmd"
import { installCliOperatorNoticeSink } from "../operator-notice"
import type { RejectCounter } from "../reject-counter"
import { installStatusBar, type StatusBar } from "../status-bar"
import {
  buildSessionStatusView,
  createLiveModelSource,
  createStatusLineDriver,
  type LiveModelSource,
  type StatusLineDriver,
} from "../status-line-driver"
import type { createStatusPills } from "../status-pills"
import type { TimelinePanel } from "../timeline-panel"
import type { TurnIndicator } from "../turn-indicator"
import type { TurnSummaryCollector } from "../turn-summary"
import { type BackgroundStreamCapture, buildBackgroundCaptureTee } from "./background-capture-tee"
import { BG_TURN_ENV_GATE } from "./background-turn-portal"
import { type CliFeatureConfig, readCliFeatureConfig } from "./cli-feature-config"
import { type ContextUsageHolder, createContextUsageHolder } from "./context-usage-snapshot"
import { maybeRunEnvProbeWire } from "./env-probe-wire"
import type { IndicatorUsageObserver } from "./factories/indicator-stream-port"
import { composeCliRuntimeContext } from "./runtime-context-compose"
import { readSessionRuntimeConfig } from "./session-runtime-config"
import { buildSpinnerStallLiveWire, SPINNER_STALL_ENV_GATE } from "./spinner-stall-live-wire"
import { resolveStickyModelBoot } from "./sticky-model-boot"
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
  /** aug-28 — the operator pinned the model for THIS invocation (`QUANTA_MODEL` /
   *  `--model`), so the surface must NOT let a persisted `/model` pick override it.
   *  Optional so a bootstrap double that predates the flag still compiles (absent
   *  ⇒ treated as "not pinned", the pre-aug-28 behavior). */
  readonly modelPinnedExplicitly?: boolean
  /** aug-28 — the model this session will ACTUALLY run on turn 1: the persisted
   *  `/model` pick when there is a runnable one, else {@link model}. Resolved ONCE
   *  in setup so every first-paint surface (status-bar preamble, status-line
   *  source, welcome banner) reports the same thing; they used to resolve it
   *  independently, and two of them resolved it not at all. */
  readonly effectiveBootModel: string
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
  /** RFC-05 E4 — the posture FRONT-DOOR control forwarded from `boot.postureControl`
   *  (the SAME live authority the host `session.posture.set` projection + the gate
   *  read). The surface composer wires the CLI `/posture` selector over the EXACT
   *  instance the host mutates (one control, both consumers) — so a `/posture`
   *  edit changes the next turn's gate. Absent only on a bootstrap that predates
   *  the wire (hermetic test doubles); the live bootstrap always sets it. Gated for
   *  REGISTRATION by `QUANTA_POSTURE_SELECTOR` in the surface composer. */
  readonly postureControl?: import("@/permission/posture/control").PostureControl | undefined
  readonly llm: LLMPort
  readonly planMode: boolean
  /** Live provider quota remaining percentage from the session BudgetMeter.
   *  Undefined when no meter exists or no provider headers have been observed;
   *  consumers must treat that as unavailable rather than infer headroom. */
  readonly providerRateLimitRemainingPercent: (() => number | undefined) | undefined
  readonly metrics: SessionBootstrapResult["features"]["metrics"]
  readonly state: SessionBootstrapResult["features"]["state"]
  readonly mcpClients: SessionBootstrapResult["features"]["mcpClients"]
  readonly mcpTools: SessionBootstrapResult["features"]["mcpTools"]
  readonly mcpSurface: McpSurfaceInfo | undefined
  readonly skillsConfig: Tooling["skillsConfig"]
  /** RFC-06 F4 — the SINGLE durable per-session skill runtime authority, built
   *  ONCE here (`buildSkillRuntimeAuthority`) and threaded to BOTH the agent
   *  (attached to `boot.tooling.skillsConfig.authority`, so `buildSkillBlock`
   *  reads it for the prompt/ToolSearch/invocation) AND the REPL slash surface
   *  (`/skills` + `/reload-skills` project its management view). One authority ⇒
   *  a disable converges across prompt, search, invocation, CLI and web at one
   *  revision. Absent when skills are unconfigured (`QUANTA_SKILLS=0`) or the
   *  build failed (fail-open: `buildSkillBlock` mints the interim authority and
   *  the slash re-scans — pre-F4 behavior). */
  readonly skillAuthority?: SkillRuntimeAuthority
  /** `/memory` slash store — the SAME {@link PersistentStorePort} the loop
   *  reads (built once in `tooling`). Absent ⇒ no store (`QUANTA_MEMORY=off`)
   *  ⇒ the `/memory` slash prints "not wired". Forwarded from
   *  `boot.tooling.store` so the slash and the agent share ONE store. */
  readonly memoryStore: Tooling["store"]
  /** Optional embedder for `/memory search` semantic recall (same instance
   *  the loop's recall uses). Absent ⇒ lexical-only fallback. */
  readonly memoryEmbedder: Tooling["embedder"]
  /** ADR-0555 — the RESOLVED kind of `memoryStore` (+ sqlite path), forwarded
   *  from `boot.tooling.memoryKind` / `.memoryStorePath` so the `/memory` slash
   *  state (`MemorySlashState.kind` / `.storePath`) tells the operator the same
   *  truth the banner does. Absent ⇒ the slash derives kind from the instance. */
  readonly memoryKind?: Tooling["memoryKind"]
  readonly memoryStorePath?: Tooling["memoryStorePath"]
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
  /** WS-G (UUX-6-22) — live MCP server-health registry (down overlay for the
   *  lifecycle pill, written by the load exit/error callbacks). Narrowed from
   *  `boot.features` like `mcpResourceCapture`. Absent ⇒ no MCP configured. */
  readonly mcpHealth: import("../mcp-health").McpHealthHolder | undefined
  /** WS-G (UUX-1-17) — repointable model source the statusline view reads per
   *  tick. surface-compose re-points it at the `/model` adapter's `current()`
   *  once that adapter exists, so a mid-session model switch paints live. */
  readonly liveModelSource: LiveModelSource
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
  /** RFC-01 A4 — the session pending-question authority (present under
   *  `QUANTA_ATTENTION_NAV`). The `/attention` slash surface reads it (answer)
   *  and the runtime overlay already wired it onto `AgentConfig.questionBroker`.
   *  Absent ⇒ `/attention` prints "not wired". */
  readonly lifecycleQuestionBroker?: SessionBootstrapResult["lifecycleQuestionBroker"]
  /** RFC-01 A4 — the live fleet-attention reader for the `/attention` list/next
   *  surface. Absent ⇒ `/attention` prints "not wired". */
  readonly lifecycleAttention?: SessionBootstrapResult["lifecycleAttention"]
  readonly sessionId: string
  readonly history: readonly Message[]
  readonly pendingImages: readonly ImageBlock[]
  readonly idMeta: SessionBootstrapResult["idMeta"]
  /** RFC-03 C2 — the reopened session's durable objective snapshot (id-mode
   *  resume only), forwarded from `boot.restoredObjective`. The surface composer
   *  (`buildSurfaceCoreState`) threads it into
   *  `resolveGatedObjectiveAuthority({ restoreFrom })` so a reopened `/goal`
   *  authority restores ids / revision / provenance. Absent ⇒ fresh authority
   *  (byte-identical legacy). */
  readonly restoredObjective?: SessionBootstrapResult["restoredObjective"]
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
  /** WS-H / UUX-3-01 — present iff `QUANTA_BG_TURN` (the portal gate). The
   *  session loop `install`s a sink here at Ctrl+B detach time so the live
   *  turn's stream is teed into the portal entry's bounded buffer until the
   *  body settles. Absent ⇒ no tee allocated (byte-identical default-OFF). */
  readonly backgroundStreamCapture: BackgroundStreamCapture | undefined
  readonly approvalPrompt: (approval: PendingApprovalView) => Promise<ApprovalDecisionResult>
  readonly midTurnApprovalChannel: import("./mid-turn-approval-channel").MidTurnApprovalChannel
  readonly runtimeContext: RuntimeContext
  /** UUX-4-04 — the loaded `PermissionStore` (the EXACT instance the
   *  admissibility gate consults), forwarded so the surface composer can
   *  wire the `/permission` inspector's live store view. `undefined` when
   *  the load failed ⇒ the slot is omitted and the inspector renders its
   *  stateless view (the gate has no store either — no lie). */
  readonly permissionStore: PermissionStore | undefined
  /** RFC-def `/undo` — the durable hunk-mutation journal store (built ONLY under
   *  `QUANTA_HUNK_UNDO=1`). Same instance the HITL prompt persists applies into;
   *  forwarded so the surface composer wires the `/undo` slash context. Absent ⇒
   *  no `/undo` slot (byte-identical). */
  readonly hunkUndoStore:
    | import("@/runner/hunk-mutation-journal").HunkMutationJournalStore
    | undefined
  readonly costPanel: CostPanel | undefined
  readonly branchProgress: BranchProgressTracker | undefined
  readonly planStore: PlanStore | undefined
  readonly abort: AbortController
  /** RFC02-3 (A8, feeder) — the gated route-event forwarder sink (bound to the
   *  live stream) forwarded from `boot.routeEventSink`. The surface composer
   *  attaches it to the `/retry-with` state's `onModelReroute` AND the scheduler
   *  reroute compose's `onModelReroute`, so operator-retry + scheduler reroute
   *  transitions reach the SAME `AgentEvent` stream as provider-fallback. Absent
   *  when `QUANTA_MODEL_REROUTE_EVENT` is off ⇒ no sink attached (byte-identical). */
  readonly routeEventSink?: ((ev: AgentEvent) => void) | undefined
  readonly pills: ReturnType<typeof createStatusPills>
  readonly argPrompt: string | undefined
  /** ADR-0297 fence — the host (`repl.ts`) may not read `process` directly;
   *  these surface facts are resolved ONCE at this layer (which owns the
   *  process reads) and consumed as plain data by the host's interactive-only
   *  gates (welcome banner, crash-resume reinject offer). */
  readonly stderrIsTTY: boolean | undefined
  /** `$HOME` snapshot for ~-shortening (empty string => unknown). */
  readonly homeDir: string
  /** F1a — the session's repo-rules snapshot, resolved ONCE at bootstrap and
   *  already threaded onto the per-turn `AgentConfig`. Handed to `/rules` so
   *  the surface reports exactly what the model received instead of a second,
   *  independent disk read that can disagree with it. */
  readonly repoRules?: SessionBootstrapResult["repoRules"]
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
/**
 * RFC-06 F4 — build the ONE durable skill runtime authority for a CLI
 * interactive session. Mirrors the pre-F4 discovery `buildSkillBlock` performed
 * (userDir only ⇒ byte-identical active set) but makes it DURABLE (a JSON
 * disabled-set store under `~/.quanta`, or `<userSkillsDir>/.disabled.json`) and
 * SHARED across every surface. `orgConfigDir` is left null (no admin policy
 * wired at this surface yet — same posture as the interim `policy: null`; the
 * builder's real `loadAdminPolicy` still runs and returns null). Fail-open: on
 * any error the session degrades to the pre-F4 path (no authority ⇒
 * `buildSkillBlock` mints the interim one, the slash re-scans) — session setup
 * must never crash on the skill surface.
 */
const buildCliSkillAuthority = async (
  skillsConfig: AgentConfigSkills,
  env: Record<string, string | undefined>,
): Promise<SkillRuntimeAuthority | undefined> => {
  if (skillsConfig === undefined) return undefined
  const dir = skillsConfig.dir
  try {
    return await buildSkillRuntimeAuthority({
      snapshotInputs: dir !== undefined ? { userDir: dir } : {},
      disabledSetPath:
        dir !== undefined
          ? join(dir, ".disabled.json")
          : join(quantaHomeDirFrom(env), "skills-disabled.json"),
    })
  } catch (e) {
    logger.warn("skill runtime authority build failed; continuing without convergence", {
      error: errMessage(e),
    })
    return undefined
  }
}

type AgentConfigSkills = import("@/agent").AgentConfig["skills"]

/** Boot: resolve the runtime + feature config, install the operator-notice
 *  sink, and bring up the session's LLM. */
const setupBoot = async (
  deps: SetupSessionDeps,
  options: {
    readonly convStore?: ConversationCheckpointStore
    readonly responsesStore?: ResponsesContinuationStore
  } = {},
) => {
  /** The factory's MUTABLE state. `let` bindings cannot cross a function
   *  boundary by value, so they live here and every link mutates in place —
   *  observationally identical to the closure they replace. */
  const mut = {
    statusLineDriver: undefined as StatusLineDriver | undefined,
  }
  const runtime = readSessionRuntimeConfig()
  const featureCfg = readCliFeatureConfig(runtime.env, runtime.stdoutIsTTY, process.stderr.isTTY)
  // WS-G operator-notice sink — installed BEFORE bootstrapSession (audit W3-A1:
  // MCP servers load inside bootstrap, so a startup load-error notice emitted
  // into a not-yet-installed bus was silently dropped; only the pill ✗
  // survived). Same composition-root pattern as the fs-jail decision sink.
  // Emitters anywhere (`@/shared#emitOperatorNotice`) route degrade signals
  // here; without this install every emit is a no-op (headless/bench surfaces
  // stay byte-identical). Uninstalled in `shutdownMcp` below.
  const uninstallOperatorNoticeSink = installCliOperatorNoticeSink()
  const boot = await bootstrapSession(deps, runtime, featureCfg)

  // RFC-06 F4 — build the ONE durable skill runtime authority and thread it to
  // the AGENT by attaching it onto the shared `boot.tooling.skillsConfig` object
  // (which `context-binding/base.ts` spreads BY REFERENCE into `config.skills`;
  // `buildSkillBlock` runs at the loop's first turn, AFTER this attach, so it
  // reads `config.skills.authority` instead of minting an interim one). The SAME
  // instance is returned on `skillAuthority` for the slash surface — so `/skills`,
  // `/reload-skills`, the prompt, ToolSearch and invocation all read one authority
  // at one revision (no split-brain). Fail-open ⇒ pre-F4 behavior.
  const skillAuthority = await buildCliSkillAuthority(boot.tooling.skillsConfig, runtime.env)
  if (skillAuthority !== undefined && boot.tooling.skillsConfig !== undefined) {
    boot.tooling.skillsConfig.authority = skillAuthority
  }

  // Spinner-stall live wire (ADR-0227 → operator-notice, follow-up from
  // e81010371). NEW default-OFF gate `QUANTA_SPINNER_STALL`: when on, the
  // session LLM is decorated so every stream call is stall-tracked and one
  // 1s poll timer surfaces stall/recover edges as latched operator notices.
  // Gate OFF ⇒ `undefined` ⇒ the LITERAL `boot.llm` is forwarded and no
  // timer exists (byte-identical; pinned by session-setup-hellgate). The
  // timer is cancelled in `shutdownMcp` below (no leaked interval).
  const spinnerStallWire = buildSpinnerStallLiveWire(gateOn(runtime.env, SPINNER_STALL_ENV_GATE))
  const sessionLlm = spinnerStallWire === undefined ? boot.llm : spinnerStallWire.wrapLlm(boot.llm)

  process.on("SIGINT", () => {
    process.stderr.write("\n(interrupt — finishing current step)\n")
    boot.abort.abort()
  })

  const shortCwd = boot.cwd.startsWith(runtime.homeDir)
    ? `~${boot.cwd.slice(runtime.homeDir.length)}`
    : boot.cwd
  // aug-28 — THE effective boot model: the persisted `/model` pick when there is a
  // runnable one, else the boot model. Computed ONCE here and consumed by every
  // first-paint surface (the status-bar preamble, the repointable status-line
  // source, and the welcome banner), because they are separate producers reading
  // the same fact. MEASURED over a real pty before this existed: the banner said
  // the pick while the status bar said the boot model, in the same frame — and the
  // status bar paints exactly once at boot, so it never corrected itself.
  const effectiveBootModel = resolveStickyModelBoot({
    planMode: boot.features.planMode,
    env: runtime.env,
    provider: boot.provider,
    // Same precedence as the surface: an explicit `QUANTA_MODEL` pin means THIS
    // session runs that model, so no display may announce a stored preference.
    ...(runtime.modelPinnedExplicitly ? { explicitPin: true } : {}),
  }).effectiveModel(boot.model)
  return {
    deps,
    options,
    runtime,
    effectiveBootModel,
    featureCfg,
    uninstallOperatorNoticeSink,
    boot,
    skillAuthority,
    spinnerStallWire,
    sessionLlm,
    shortCwd,
    mut,
  }
}

/** The status surfaces — status bar, turn summary, debug/timeline streams,
 *  context-usage holder, background capture and the turn indicator. */
const setupStatus = (ctx: Awaited<ReturnType<typeof setupBoot>>) => {
  const { deps, runtime, featureCfg, boot, shortCwd, effectiveBootModel } = ctx
  const statusDefault =
    `${boot.provider} · ${effectiveBootModel} · ${boot.mode} · ${shortCwd}` +
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
  // WS-H / UUX-3-01 — background-turn output capture tee. Interposed in the
  // same chain as the debug/timeline tees so a Ctrl+B-detached turn's stream
  // can be teed into its portal entry (`entry.appendOutput`) between detach
  // and settle (the loop installs/removes the sink; see
  // `wireBackgroundOutputCapture`). Gate OFF (`QUANTA_BG_TURN` unset — the
  // SAME gate that builds the portal in surface-compose, via the shared
  // BG_TURN_ENV_GATE const) ⇒ literal `timelineStream` + no handle ⇒
  // byte-identical.
  const { stream: bgCaptureStream, capture: backgroundStreamCapture } = buildBackgroundCaptureTee(
    gateOn(runtime.env, BG_TURN_ENV_GATE),
    timelineStream,
  )
  const { indicator: turnIndicator, turnStream } = deps.buildTurnIndicatorAndStream(
    featureCfg,
    statusBar,
    bgCaptureStream,
    { observeUsage: contextUsageHolder.observeUsage },
  )
  return {
    statusDefault,
    statusBar,
    turnSummary,
    summaryStream,
    debugStream,
    debugHandle,
    timelineStream,
    timelinePanel,
    contextUsageHolder,
    bgCaptureStream,
    backgroundStreamCapture,
    turnIndicator,
    turnStream,
  }
}

/** Interaction: approval prompting, the decision emitter, the status pills
 *  and the status-line config. */
const setupInteraction = async (
  ctx: Awaited<ReturnType<typeof setupBoot>> & ReturnType<typeof setupStatus>,
) => {
  const { deps, options, runtime, boot, statusBar, turnStream } = ctx

  const { approvalPrompt, midTurnApprovalChannel, runtimeContext, permissionStore, hunkUndoStore } =
    await composeCliRuntimeContext({
      boot,
      turnStream,
      loadPermissionStore: deps.loadPermissionStore,
      sandboxProfile: runtime.sandboxProfile,
      ...(options.convStore !== undefined ? { convStore: options.convStore } : {}),
      ...(options.responsesStore !== undefined ? { responsesStore: options.responsesStore } : {}),
      envSource: runtime.env,
    })
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
  return {
    approvalPrompt,
    midTurnApprovalChannel,
    runtimeContext,
    permissionStore,
    hunkUndoStore,
    decisionEmitter,
    pills,
    statusLineCfg,
  }
}

/** The live model source the REPL rebinds on a model switch. */
const setupModel = async (
  ctx: Awaited<ReturnType<typeof setupBoot>> &
    ReturnType<typeof setupStatus> &
    Awaited<ReturnType<typeof setupInteraction>>,
) => {
  const { runtime, boot, mut, turnStream, pills, statusLineCfg } = ctx
  // WS-G (UUX-1-17) — the model is read through a REPOINTABLE source so a
  // mid-session `/model` change shows up on the next tick. Created here
  // (anchored at the boot model), re-pointed by surface-compose once the
  // `/model` adapter exists. Minted unconditionally (cheap) so the wiring in
  // surface-compose never has to branch on the statusline gate.
  const liveModelSource = createLiveModelSource(ctx.effectiveBootModel)
  if (statusLineCfg !== undefined) {
    const costPanel = boot.costPanel as CostPanel | undefined
    const statusView = buildSessionStatusView({
      ...(boot.sessionId !== undefined ? { sessionId: boot.sessionId } : {}),
      cwd: boot.cwd,
      model: liveModelSource,
      effort: () => boot.effortStore.get(),
      cost: () => costPanel?.snapshot(),
    })
    mut.statusLineDriver = createStatusLineDriver({
      cfg: statusLineCfg,
      view: statusView,
      pills,
      width: process.stdout.columns ?? 0,
    })
    void mut.statusLineDriver.tick() // initial paint (async, non-blocking)
    mut.statusLineDriver.start() // poll iff the config carries refreshInterval
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
  return { liveModelSource }
}

/** Assemble the chained builders. */
/** The slash-surface slots forwarded VERBATIM from the one per-session
 *  `Tooling` — the `/memory` store + embedder (the SAME instances the loop
 *  reads/writes), their ADR-0555 resolved kind + sqlite path (so `/memory
 *  stats` tells the banner's truth), and the A3 (jul-04) `/kb` store (the SAME
 *  instance the `projects_kb` tool writes into; absent when the gate is off ⇒
 *  `/kb` "not wired"). Hoisted out of `setupSession` (god-function ceiling). */
const toolingSlashSlots = (
  tooling: SessionBootstrapResult["tooling"],
): Pick<
  SessionSetupResult,
  "memoryStore" | "memoryEmbedder" | "memoryKind" | "memoryStorePath" | "projectsKbStore"
> => ({
  memoryStore: tooling.store,
  memoryEmbedder: tooling.embedder,
  memoryKind: tooling.memoryKind,
  memoryStorePath: tooling.memoryStorePath,
  projectsKbStore: tooling.projectsKbStore,
})

/**
 * Fold the four setup phases into the {@link SessionSetupResult} the REPL consumes.
 *
 * Split out of {@link setupSession} so the phase ORCHESTRATION (four ordered
 * awaits) and the RESULT ASSEMBLY (one wide literal, ~90 fields) are separate
 * units — the combined function had grown past the god-function cap, and the two
 * halves change for entirely different reasons: a new phase is a pipeline change,
 * a new field is a projection change.
 */
const assembleSetupResult = (
  parts: Awaited<ReturnType<typeof setupBoot>> &
    ReturnType<typeof setupStatus> &
    Awaited<ReturnType<typeof setupInteraction>> &
    Awaited<ReturnType<typeof setupModel>>,
): SessionSetupResult => {
  const {
    runtime,
    featureCfg,
    effectiveBootModel,
    uninstallOperatorNoticeSink,
    boot,
    skillAuthority,
    spinnerStallWire,
    sessionLlm,
    statusBar,
    turnSummary,
    debugHandle,
    timelinePanel,
    contextUsageHolder,
    backgroundStreamCapture,
    turnIndicator,
    approvalPrompt,
    midTurnApprovalChannel,
    runtimeContext,
    permissionStore,
    hunkUndoStore,
    pills,
    liveModelSource,
    mut,
  } = parts
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
    // RFC-05 E4 — forward the posture front-door control so the surface composer
    // wires `/posture` over the SAME live authority the host `session.posture.set`
    // + the gate read. Undefined only for a bootstrap double that predates the wire.
    postureControl: boot.postureControl,
    llm: sessionLlm,
    planMode: boot.features.planMode,
    modelPinnedExplicitly: runtime.modelPinnedExplicitly === true,
    effectiveBootModel,
    providerRateLimitRemainingPercent:
      boot.budgetMeter !== undefined
        ? () => boot.budgetMeter?.providerRateLimitRemainingPercent()
        : undefined,
    metrics: boot.features.metrics,
    state: boot.features.state,
    mcpClients: boot.features.mcpClients as unknown as SessionSetupResult["mcpClients"],
    mcpTools: boot.features.mcpTools,
    mcpSurface: boot.mcpSurface as McpSurfaceInfo | undefined,
    skillsConfig: boot.tooling.skillsConfig,
    // RFC-06 F4 — the shared session skill authority for the slash surface
    // (`/skills` + `/reload-skills` project its management view; the SAME
    // instance the agent reads via `config.skills.authority`). Omitted when the
    // build returned undefined (skills off / fail-open).
    ...(skillAuthority !== undefined ? { skillAuthority } : {}),
    ...toolingSlashSlots(boot.tooling),
    // B4 (jul-04) — narrow the host-opaque `boot.features` back to the CLI
    // `Features` shape to read the capture holder the mcp resource tools write
    // into (the host forwards `Features` as `BootstrapFeatures`, which does not
    // declare the field, but the runtime object still carries it — mirrors the
    // `mcpClients` narrow below). Absent ⇒ `/mcp-resources` "not wired".
    mcpResourceCapture: (boot.features as unknown as import("../internal/mcp").Features)
      .mcpResourceCapture,
    // WS-G (UUX-6-22) — same narrow for the MCP health registry (the pill's
    // down overlay). Absent ⇒ no MCP configured ⇒ pill behavior unchanged.
    mcpHealth: (boot.features as unknown as import("../internal/mcp").Features).mcpHealth,
    // WS-G (UUX-1-17) — the statusline's repointable model source.
    liveModelSource,
    searchPipelineDispose: boot.tooling.searchPipelineDispose,
    lifecyclePills: boot.lifecyclePills as unknown as LifecyclePills,
    lifecycleTaskRegistry: boot.lifecycleTaskRegistry,
    // RFC-01 A4 — forward the pending-question authority + attention reader so the
    // `/attention` slash surface reads the SAME instances the loop's
    // `config.questionBroker` producer writes to. Absent (gate off) ⇒ omitted.
    ...(boot.lifecycleQuestionBroker !== undefined
      ? { lifecycleQuestionBroker: boot.lifecycleQuestionBroker }
      : {}),
    ...(boot.lifecycleAttention !== undefined
      ? { lifecycleAttention: boot.lifecycleAttention }
      : {}),
    lifecycleActivityStore: boot.lifecycleActivityStore,
    lifecycleFollowUpQueue: boot.lifecycleFollowUpQueue,
    sessionId: boot.sessionId,
    history: boot.history,
    pendingImages: boot.pendingImages,
    idMeta: boot.idMeta,
    // RFC-03 C2 — forward the reopened objective snapshot (id-mode resume only)
    // so the surface composer restores the goal authority. Absent ⇒ omitted ⇒
    // fresh authority (byte-identical legacy).
    ...(boot.restoredObjective !== undefined ? { restoredObjective: boot.restoredObjective } : {}),
    statusBar,
    turnIndicator,
    contextUsageHolder,
    turnSummary,
    debugHandle,
    timelinePanel,
    backgroundStreamCapture,
    approvalPrompt,
    midTurnApprovalChannel,
    runtimeContext,
    permissionStore,
    hunkUndoStore,
    costPanel: boot.costPanel as CostPanel | undefined,
    branchProgress: boot.branchProgress as BranchProgressTracker | undefined,
    planStore: boot.planStore,
    abort: boot.abort,
    // RFC02-3 (A8, feeder) — forward the gated route-event forwarder sink so the
    // surface composer attaches it to the `/retry-with` state + scheduler reroute
    // `onModelReroute` slots. Absent (gate off) ⇒ slot omitted ⇒ byte-identical.
    ...(boot.routeEventSink !== undefined ? { routeEventSink: boot.routeEventSink } : {}),
    pills,
    argPrompt: boot.argPrompt,
    stderrIsTTY: process.stderr.isTTY,
    homeDir: runtime.homeDir,
    repoRules: boot.repoRules,
    systemSource: boot.systemSource,
    refreshSystemPrompt: boot.refreshSystemPrompt,
    shutdownMcp: async () => {
      // ADR-0269 Phase 3 closure — clear the fs-jail sink BEFORE MCP
      // teardown so a sibling/re-entered session never inherits this
      // run's emitter (the slot is process-global by slice-fence design).
      clearFsJailDecisionSink()
      // WS-G — release the operator-notice sink with the same lifecycle (the
      // slot is process-global; a re-entered setup must not inherit it).
      uninstallOperatorNoticeSink()
      // #15 — stop the status-line poll on session end (idempotent; undefined
      // when the feature is gated off).
      mut.statusLineDriver?.stop()
      // Spinner-stall live wire — cancel the 1s stall-poll interval
      // (idempotent; undefined when QUANTA_SPINNER_STALL is off).
      spinnerStallWire?.teardown()
      await boot.shutdownMcp()
    },
    // ADR-0301 — forward the CLI flag echo so `runRepl` can hand it to
    // `runSessionLoop({ playbookCliFlag })`. Bootstrap maps absent → undefined
    // already; we just propagate the same shape.
    playbookCliFlag: boot.playbookCliFlag,
    featureCfg,
  }
}

export const setupSession = async (
  deps: SetupSessionDeps,
  options: {
    readonly convStore?: ConversationCheckpointStore
    readonly responsesStore?: ResponsesContinuationStore
  } = {},
): Promise<SessionSetupResult> => {
  const p0 = await setupBoot(deps, options)
  const p1 = setupStatus({ ...p0 })
  const p2 = await setupInteraction({ ...p0, ...p1 })
  const p3 = await setupModel({ ...p0, ...p1, ...p2 })
  return assembleSetupResult({ ...p0, ...p1, ...p2, ...p3 })
}
