/**
 * `@/host/bootstrap/types` — shared shapes for the surface-agnostic bootstrap.
 *
 * SLICE INVARIANT (ADR-0299): `src/host/bootstrap/**` MUST NOT import from
 * `src/apps/**` (no surface coupling). Every env / argv / terminal-bound
 * factory (`buildLLM`, `buildTooling`, `loadFeatures`, `materializeReviewerAgent`,
 * …) is injected via {@link SessionBootstrapDeps} so the same bootstrap can
 * back the CLI today and a Web/Tauri surface tomorrow without a fork.
 */

import type {
  AgentConfig,
  BriefStore,
  EffortStore,
  McpReloadableSource,
  PersonaKind,
} from "@/agent"
import type { FocusChainPort } from "@/agent/focus-chain"
import type { FollowUpQueue } from "@/agent/follow-up-queue"
import type { PlanStore } from "@/agent/plan/state"
import type { ImageBlock, LLMPort, Message } from "@/llm"
import type { Metrics, StructuredLogger } from "@/observability"
import type { PermissionContext, PermissionMode, PermissionStore, ReviewerPort } from "@/permission"
import type {
  IdentityModeSessionState,
  PermissionModeSessionState,
  Provider,
  SystemSource,
  Tooling,
  ToolProfileSessionState,
} from "@/runner/assemble"
import type { ResolveResumeInput, ResumeResolution } from "@/runner/orchestrate"
import type { ProxyEnvInput } from "@/runtime/network-proxy"
import type { AgentEvent, StreamPort } from "@/stream"
import type { TaskRegistry } from "@/subagent"
import type { ShellExecObserver, Tool } from "@/tool"
import type { McpResourceCaptureHolder } from "@/tool/mcp_resources/capture"
import type { ReviewerRunner } from "@/tool/types"
import type { McpHealthHolder } from "../mcp-health"
import type { McpToolReloadController } from "../runtime/mcp-tool-reload"

/** Closed enum of bootstrap failure kinds. The single source of truth used by
 *  `SessionBootstrapError.kind` and surface-side error handlers. */
export type SessionBootstrapFailureKind =
  | "llm_build_failed"
  | "image_load_failed"
  | "resume_conflict"
  | "resume_missing_id"

/** Typed bootstrap failure. Surfaces map this to an exit code / UI string. */
export class SessionBootstrapError extends Error {
  readonly kind: SessionBootstrapFailureKind
  readonly exitCode = 1

  override readonly cause: unknown

  constructor(kind: SessionBootstrapFailureKind, message: string, cause?: unknown) {
    super(message)
    this.name = "SessionBootstrapError"
    this.kind = kind
    this.cause = cause
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export const isSessionBootstrapError = (value: unknown): value is SessionBootstrapError =>
  value instanceof SessionBootstrapError

// ── Aliases / type re-exports the host needs without a direct surface coupling.

/** Minimal MCP server descriptor — the host slice cannot import `@/mcp`
 *  (outside its allowed cross-cuts) so we mirror the shape structurally.
 *  Matches `@/mcp#McpServerConfig` (the surface forwards real config rows). */
export interface BootstrapMcpServerConfig {
  name: string
  command: string[]
  cwd?: string
  env?: Record<string, string>
}

/** Minimal MCP client handle — host only calls `.stop()` on these. The surface
 *  passes real `McpClient` instances through. */
export interface BootstrapMcpClient {
  readonly stop: () => Promise<void>
}

/** The feature-flag bundle the bootstrap consumes from `deps.loadFeatures`.
 *  Structurally compatible with `apps/cli/internal#Features` so CLI composition
 *  can assign through. `mcpClients` uses the narrower {@link BootstrapMcpClient}
 *  shape (only `.stop()` required). The tool arrays are declared mutable because
 *  the per-turn tooling builder mutates the registry through them; the bootstrap
 *  itself never mutates the bundle (the host body treats every field as
 *  read-only). */
export interface BootstrapFeatures {
  readonly planMode: boolean
  readonly metrics: Metrics | undefined
  readonly state: string | undefined
  readonly resume: string | undefined
  readonly mcpTools: Tool[]
  readonly mcpClients: readonly BootstrapMcpClient[]
  readonly mcpConfigs: BootstrapMcpServerConfig[]
  readonly lspTools: Tool[]
  readonly lspNavTools: Tool[]
  readonly gitToolList: Tool[]
  readonly astGrepTools: Tool[]
  readonly mcpResourceCapture?: McpResourceCaptureHolder
  readonly mcpHealth?: McpHealthHolder
  /** RFC04-2/3 (hot-reload) — the per-(non-supervised)-server reload sources the
   *  load collected, present ONLY when `QUANTA_MCP_HOT_RELOAD` is on. The
   *  bootstrap feeds them into the reload controller's all-source relist. */
  readonly mcpReloadSources?: McpReloadableSource[]
  /** RFC04-2/3 (hot-reload) — late-bind the built controller into the observer
   *  wired at load time. Called ONCE by the bootstrap after the registry exists.
   *  Present iff {@link mcpReloadSources} is (same gate). */
  readonly bindMcpReloadController?: (controller: McpToolReloadController) => void
}

/** Per-surface MCP pill descriptor — the host only forwards rows from
 *  `deps.deriveMcpPillServers` into `lifecyclePills.update`. The shape mirrors
 *  the CLI surface's `McpPillServer` exactly so the surface concrete type is
 *  assignable through. */
export interface BootstrapMcpPillServer {
  name: string
  status: "connected" | "degraded" | "down"
  toolCount?: number
}

/** The single concrete patch shape the bootstrap pushes through
 *  `LifecyclePills.update` — wiring MCP servers when the loaded features
 *  expose any. Declared loose (mutable + structurally subset of the surface's
 *  `Partial<LifecycleState>`) so the surface's concrete `LifecyclePills.update`
 *  parameter type is assignable to the factory shape. */
export interface BootstrapLifecyclePatch {
  mcp?: { servers: BootstrapMcpPillServer[] }
}

/** Lifecycle pill bundle the host hands back to the surface. The host only
 *  calls `update` (to wire MCP servers when present); the surface's concrete
 *  type may carry additional methods (`dispose`, `flush`, …) which the
 *  bootstrap never touches but the surface can access through its own typed
 *  reference. */
export interface BootstrapLifecyclePills {
  readonly update: (next: BootstrapLifecyclePatch) => void
}

/** Bootstrap-shaped MCP surface descriptor — opaque value the host carries
 *  from `deps.buildMcpSurfaceInfo` straight through to the result so the
 *  surface's slash-command wiring sees the SAME object the surface produced. */
export type BootstrapMcpSurface = unknown

/** Opaque surface feature-config record (ADR-0291).  The host slice never
 *  inspects it — every field-aware decision lives in the surface factories
 *  that consume the config.  The opaqueness keeps the slice fence intact
 *  (host cannot import `apps/cli/repl/cli-feature-config`). */
export type SessionFeatureConfig = unknown

/** Bootstrap-shaped cost-panel handle — opaque to the host. */
export type BootstrapCostPanel = unknown

/** Bootstrap-shaped branch-progress tracker — opaque to the host. */
export type BootstrapBranchProgress = unknown

/** Minimal surface contract for the idle monitor — the host never calls any
 *  methods on it (it only carries the value through `SessionBootstrapResult`).
 *  Surface-side HITL helpers read only `markActive`; the full concrete type
 *  from `apps/cli/idle-monitor#IdleMonitor` is a structural superset and is
 *  therefore assignable here without a cast. */
export interface BootstrapIdleMonitor {
  markActive(): void
}

/** Minimal surface contract for the reject counter — the host carries it
 *  opaquely.  Surface-side HITL helpers read `recordAccept`, `recordDeny`,
 *  and `shouldAutoExit`; the full concrete type from
 *  `apps/cli/reject-counter#RejectCounter` is a structural superset. */
export interface BootstrapRejectCounter {
  recordAccept(): void
  recordDeny(): number
  shouldAutoExit(): boolean
}

// ── Dep factories injected by the surface.

/** Build the main LLM adapter stack (retry + optional fallback + classifier).
 *  Replaces the prior internal `buildLlmStack` helper.
 *
 *  MAY be async (jun-6 H7-BYOK): the legacy vendor path can pre-resolve its key
 *  through an `apiKeyHelper` mint (one `await`ed shell) before the synchronous
 *  `createLLM`. The host `await`s the result, so a `Promise<LLMPort>` return is
 *  accepted; a synchronous `LLMPort` (the byte-identical default-OFF path)
 *  resolves immediately. */
export type BuildLlmFactory = (
  provider: Provider,
  model: string,
  mode: PermissionMode,
  permission: PermissionContext,
  signal: AbortSignal,
  slog: StructuredLogger,
  /** RFC02-3 (A8) — PRODUCTION model-route sink. When wired (ONLY under
   *  `QUANTA_MODEL_REROUTE_EVENT`), the surface threads it into `composeLLMCore`
   *  so a real `FallbackLLM` provider swap projects a `model_route_changed`
   *  AgentEvent onto it. The host passes a LATE-BOUND forwarder whose target is
   *  set to the live `stream.emit` AFTER `buildStreaming` (the LLM stack is built
   *  BEFORE the stream exists). Absent ⇒ no sink reaches `FallbackLLM` ⇒
   *  byte-identical (no controller, no event). */
  routeEventSink?: (ev: AgentEvent) => void,
) => LLMPort | Promise<LLMPort>

/** jun-6 (RFC jun-6-ai-session-title) — build the fire-and-forget AI session
 *  titler. Returns `undefined` (the default-OFF byte-identical path) unless
 *  `QUANTA_SESSION_AUTO_TITLE` is on AND `QUANTA_SESSION_TITLE_MODEL` resolves a
 *  cheap `LLMPort`; the surface builds the port from those knobs (mirroring the
 *  `QUANTA_COMPACT_MODEL` precedent) and wires the real `renameSession` writer +
 *  `loadSessionById` title-reader. The host carries it onto the result so
 *  `context-binding.ts` can spread it into `AgentConfig.autoTitlePort`. The
 *  `signal` is the session abort signal so a per-session cheap LLM is cancelled
 *  on session end. */
export type BuildAutoTitlePortFactory = (
  provider: Provider,
  signal: AbortSignal,
) => AgentConfig["autoTitlePort"] | undefined

/** Build the streaming stack (StreamPort + optional observability RunContext). */
export type BuildStreamingFactory = (
  observe: string | undefined,
  slog: StructuredLogger,
) => { stream: StreamPort; run: AgentConfig["run"] }

/** Build the per-run tooling registry + memory/skill/subagent/etc. config.
 *  Tool arrays are declared mutable to align with the existing surface
 *  signature (`apps/cli/internal#buildTooling(mcpTools: Tool[], …)`); the
 *  bootstrap never mutates the inputs. */
export type BuildToolingFactory = (
  mcpTools: Tool[],
  lspTools: Tool[],
  lspNavTools: Tool[],
  gitToolList: Tool[],
  astGrepTools: Tool[],
  slog: StructuredLogger,
  taskRegistry: TaskRegistry | undefined,
  metrics?: Metrics,
  /** ADR-0432 — live 0..100 remaining-budget signal for the self-edit memory
   *  write-guard. The bootstrap threads `() => meter.remainingPercent()` from
   *  the session {@link BudgetMeter} so `QUANTA_MEMORY_WRITE_GUARD_PCT` actually
   *  guards on the live CLI surface (previously the param was omitted, so the
   *  guard was inert). Absent ⇒ byte-identical (the surface shim leaves the slot
   *  undefined and `buildMemoryExtras` builds no guard). */
  budgetRemainingPercent?: () => number,
  /** jun-15 P0-b — the session Activity Spine store the bootstrap threads from
   *  the lifecycle bundle so `run_workflow` records its live run into the SAME
   *  instance `/activity` renders. Absent ⇒ no recording (byte-identical). */
  activityStore?: import("@/activity").ActivityStore,
  /** jul-03 B3 — live PROVIDER rate-limit remaining % (0..100) or `undefined`,
   *  SEPARATE from `budgetRemainingPercent` (local cost). The bootstrap threads
   *  `() => meter.providerRateLimitRemainingPercent()` so the memory write-guard's
   *  provider arm reads the REAL `x-ratelimit-remaining` window (fed by the loop
   *  from response headers). Absent ⇒ the provider arm is never armed
   *  (byte-identical). */
  providerRateLimitRemainingPercent?: () => number | undefined,
) => Tooling

/** Resolve default-OFF feature flags + bridged MCP/LSP/git tools from the
 *  surface env.
 *
 *  B1 (jun-04) — `llm` is the assembled `LLMPort` the bootstrap builds just
 *  before this call. It is threaded so an inbound MCP `sampling/createMessage`
 *  can be fulfilled by the loaded `McpClient`s (advertise-iff-able, gated on
 *  `QUANTA_MCP_SAMPLING` + `QUANTA_MCP_CAPS=full` + user consent). Optional so a
 *  surface that does not opt into inbound sampling (or has no LLM at this point)
 *  stays byte-identical; the CLI surface passes its `finalLLM`. */
export type LoadFeaturesFactory = (
  slog: StructuredLogger,
  llm?: LLMPort,
  /** H3 (jun-10 session-scoped egress) — the SESSION-SCOPED egress-proxy env the
   *  bootstrap opened (`openSessionEgressProxy`) BEFORE MCP servers spawn, live
   *  for the whole session. Threaded so each stdio MCP server child's own sockets
   *  are forced through the loopback allowlist (per-turn `withEgressProxy` cannot
   *  gate a process-lifetime child). Absent / proxy OFF ⇒ byte-identical load. */
  proxyEnv?: ProxyEnvInput,
) => Promise<BootstrapFeatures>

/** Load one image at `path` synchronously — terminal-host helper. */
export type LoadImageBlockFactory = (path: string) => ImageBlock

/** Resolve `--identity` lines for the current REPL posture. Absent ⇒ undefined. */
export type PickIdentityFactory = () => readonly string[] | undefined

/** Resolve the current persona slot. */
export type PickPersonaFactory = () => PersonaKind

/** Run the resume-FSM with surface-provided callbacks. */
export type ResolveResumeFactory = (input: ResolveResumeInput) => Promise<ResumeResolution>

/** Compose the per-turn shell-event observer from the surface (TTY painter +
 *  OTEL observer when enabled). Returns `undefined` when both are absent so
 *  the bootstrap stays byte-identical to today. */
export type ComposeShellEventFactory = (
  metrics: Metrics | undefined,
  stdoutIsTTY: boolean | undefined,
) => ShellExecObserver | undefined

/** Switch the host process to the resumed session's cwd. The surface-supplied
 *  closure may call `process.chdir`; the host never touches `node:process`. */
export type SwitchToSessionCwdFactory = (
  currentCwd: string,
  resumedCwd: string,
  slog: StructuredLogger,
) => string

/** Materialize a child reviewer agent from the per-turn `AgentConfig`. Returns
 *  `undefined` when subagent config is OFF. */
export type MaterializeReviewerAgentFactory = (config: AgentConfig) => ReviewerRunner | undefined

/** Build the subagent-backed guardian review adapter. */
export type CreateGuardianReviewFactory = (opts: {
  reviewer: ReviewerRunner
  parentDepth?: number
  signal?: AbortSignal
}) => ReviewerPort["guardianReview"]

/** Build the subagent-backed guardian per-action ASSESSOR adapter (jun-7-misc
 *  03, ADR-0497). Sibling of {@link CreateGuardianReviewFactory} with an
 *  identical opts shape; emits the typed assessor servicer the composition root
 *  wires into `ReviewerPort.guardianAssess` ONLY when the
 *  `QUANTA_GUARDIAN_ASSESSOR` knob is on. */
export type CreateGuardianAssessFactory = (opts: {
  reviewer: ReviewerRunner
  parentDepth?: number
  signal?: AbortSignal
}) => NonNullable<ReviewerPort["guardianAssess"]>

/** Build the MCP `/mcp` surface descriptor from configs + bridged tools.
 *  Returns `undefined` when there is nothing to show. The CLI binds this to
 *  `apps/cli/repl/mcp-surface-wire#buildMcpSurfaceInfo`. */
export type BuildMcpSurfaceInfoFactory = (opts: {
  readonly configs: readonly BootstrapMcpServerConfig[]
  readonly bridgedTools: Tool[]
  readonly configPath: string | undefined
}) => BootstrapMcpSurface | undefined

/** Build the per-session idle monitor + reject counter pair from the
 *  surface-resolved knobs. These ports touch node:fs/node:os (snooze
 *  persistence) so they stay surface-side; the host only carries them
 *  through the result. */
export type BuildIdleGuardsFactory = (runtime: SessionRuntimeConfigShape) => {
  readonly idleMonitor: BootstrapIdleMonitor
  readonly rejectCounter: BootstrapRejectCounter
}

/** Runtime config the bootstrap takes from the surface (env / argv parsed). */
export interface SessionRuntimeConfigShape {
  readonly provider: Provider
  readonly model: string
  readonly mode: PermissionMode
  readonly maxTurns: number
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly homeDir: string
  readonly stdinIsTTY: boolean | undefined
  readonly stdoutIsTTY: boolean | undefined
  /** `process.stderr.isTTY`. The interactive welcome banner (repl.ts) and the
   *  human "quanta ready" / "session:" startup logs are gated on this exact
   *  bit (logs go to stderr). Optional so non-CLI surfaces / test stubs that
   *  omit it default to `undefined` ⇒ banner-suppression OFF ⇒ byte-identical. */
  readonly stderrIsTTY?: boolean | undefined
  readonly newSession: boolean
  readonly title: string | undefined
  readonly idleMs: number
  readonly snoozeDefaultMs: number
  readonly rejectLimit: number
  readonly idleSuppressOn: boolean
  readonly observeDir: string | undefined
  readonly pendingImagePaths: readonly string[]
  readonly mcpConfigPath: string | undefined
  readonly argPrompt: string | undefined
  readonly spinnerIntervalMs: string
  /** ADR-0301 — `--playbook-trigger` CLI flag echo, threaded from the
   *  surface argv parser. `false` ⇒ flag absent (default). Mapped to
   *  `playbookCliFlag: true | undefined` on the result so the loop call
   *  site can spread it conditionally under `exactOptionalPropertyTypes`. */
  readonly playbookTriggerFlag?: boolean
}

// ── The dep bundle.

/** All factories the bootstrap needs from a surface. Each is plain data
 *  (a closure) so the same shape works for terminal/web/headless surfaces. */
export interface SessionBootstrapDeps {
  // ── Existing surface-side composers ────────────────────────────────
  readonly buildLifecycleBundle: (
    featureCfg: SessionFeatureConfig,
    /** RFC-01 A4 — composition-root env bag the `QUANTA_ATTENTION_NAV` gate is
     *  resolved from (DI). Optional so surfaces that mint no attention authority
     *  (serve-stdio) may ignore it. */
    env?: Readonly<Record<string, string | undefined>>,
  ) => {
    pills: BootstrapLifecyclePills
    taskRegistry: TaskRegistry | undefined
    followUpQueue: FollowUpQueue | undefined
    /** jun-15 P0-b — session Activity Spine store shared by `run_workflow`
     *  (writer) and `/activity` (reader). */
    activityStore: import("@/activity").ActivityStore
    /** RFC-01 A4 — pending-question authority, minted ONLY under
     *  `QUANTA_ATTENTION_NAV` (else undefined ⇒ byte-identical). */
    questionBroker?: import("@/session/user-question").UserQuestionBroker
    /** RFC-01 A4 — live fleet-attention reader (A2's `AttentionReader`). */
    attentionReader?: import("@/runner/assemble/session-authorities").AttentionReader
  }
  readonly deriveMcpPillServers: (
    mcpTools: ReadonlyArray<{ name: string }>,
  ) => readonly BootstrapMcpPillServer[]
  readonly buildCostPanelOrUndefined: (
    featureCfg: SessionFeatureConfig,
    model: string,
    /** MR-04 — the session's usage-accounting authority. Supplied ⇒ the panel
     *  projects it instead of folding its own counter delta. */
    accounting?: import("@/observability/usage-accounting").UsageAccountingPort,
    /** MR-08 — `false` ⇒ shadow: hand the authority over for the receipt, but
     *  keep rendering the legacy feed. */
    accountingAuthoritative?: boolean,
  ) => BootstrapCostPanel | undefined
  readonly buildBranchProgressOrUndefined: (
    featureCfg: SessionFeatureConfig,
  ) => BootstrapBranchProgress | undefined
  readonly buildPlanStoreOrUndefined: (featureCfg: SessionFeatureConfig) => PlanStore | undefined
  readonly buildWorkMetricsSink: (enabled: boolean) => AgentConfig["workMetricsSink"] | undefined
  // ── New factory fields (ADR-0299) ──────────────────────────────────
  /** Build the LLM stack (retry + fallback + classifier). Replaces direct
   *  imports of `buildLLM` / `RetryingLLM` / `composeLLM` at the CLI seam. */
  readonly buildLlm: BuildLlmFactory
  /** jun-6 — build the fire-and-forget AI session titler (default-OFF ⇒
   *  `undefined`). Mirrors the `buildSummarizerLlm` second-LLM precedent. */
  readonly buildAutoTitlePort: BuildAutoTitlePortFactory
  /** Build the streaming stack. Replaces direct import of
   *  `apps/cli/internal#buildStreaming`. */
  readonly buildStreaming: BuildStreamingFactory
  /** Build the per-run tooling. Replaces direct import of
   *  `apps/cli/internal#buildTooling`. */
  readonly buildTooling: BuildToolingFactory
  /** Resolve default-OFF feature flags. Replaces direct import of
   *  `apps/cli/internal#loadFeatures`. */
  readonly loadFeatures: LoadFeaturesFactory
  /** Load one image — terminal-host helper. Replaces direct import of
   *  `apps/cli/image-loader#loadImageBlock`. */
  readonly loadImageBlock: LoadImageBlockFactory
  /** Resolve identity lines for the current posture. Replaces direct import of
   *  `apps/cli/internal#pickIdentity`. */
  readonly pickIdentity: PickIdentityFactory
  /** Resolve persona slot. Replaces direct import of
   *  `apps/cli/internal#pickPersona`. */
  readonly pickPersona: PickPersonaFactory
  /** Run the resume FSM. Replaces direct import of
   *  `apps/cli/internal#resolveResume`. */
  readonly resolveResume: ResolveResumeFactory
  /** Compose the per-turn shell-event observer. Replaces direct import of
   *  `@/observability#buildShellOtelObserver` + `apps/cli/shell-stream-painter`. */
  readonly composeShellEvent: ComposeShellEventFactory
  /** Switch the host process cwd to the resumed session's. Replaces direct
   *  import of `apps/cli/session-io#switchToSessionCwd`. */
  readonly switchToSessionCwd: SwitchToSessionCwdFactory
  /** Materialize a child reviewer agent. Replaces direct import of
   *  `@/agent/tier1/reviewer-subagent#materializeReviewerAgent` at the CLI seam. */
  readonly materializeReviewerAgent: MaterializeReviewerAgentFactory
  /** Build the guardian review adapter. Replaces direct import of
   *  `@/agent/tier1/reviewer-subagent#createSubagentBackedGuardianReview`. */
  readonly createSubagentBackedGuardianReview: CreateGuardianReviewFactory
  /** jun-7-misc 03 (ADR-0497) — build the guardian per-action ASSESSOR adapter.
   *  Sibling of {@link createSubagentBackedGuardianReview}; emits the typed
   *  `ActionAssessment` the composition root wires into `ReviewerPort.guardianAssess`
   *  ONLY when the `QUANTA_GUARDIAN_ASSESSOR` knob is on. Replaces a direct import
   *  of `@/agent/tier1/reviewer-subagent#createSubagentBackedGuardianAssess`,
   *  keeping `src/apps/cli/repl/**` free of the reviewer-subagent module (ADR-0299
   *  §3). The opts shape is identical to the review factory. */
  readonly createSubagentBackedGuardianAssess: CreateGuardianAssessFactory
  /** Build the `/mcp` surface descriptor. Replaces direct import of
   *  `apps/cli/repl/mcp-surface-wire#buildMcpSurfaceInfo`. */
  readonly buildMcpSurfaceInfo: BuildMcpSurfaceInfoFactory
  /** Build the per-session idle monitor + reject counter pair. The concrete
   *  ports touch node:fs/node:os and live in the surface; the host carries
   *  the values through opaquely. */
  readonly buildIdleGuards: BuildIdleGuardsFactory
  /** RFC-05 E3 (durable posture resume) — load the host-owned durable
   *  {@link PermissionStore} (the process singleton) so the live posture authority
   *  can be keyed by the RESOLVED per-session id and RESTORE the last effective
   *  posture across a restart. OPTIONAL: a surface that omits it (headless / bench /
   *  serve-stdio / brain-mode) keeps the legacy process-local in-memory seed
   *  (byte-identical, nothing persists). Even when supplied, the durable path is
   *  further gated by `QUANTA_POSTURE_DURABLE_RESUME` (default-OFF) at the assembly
   *  seam, so shipping this dep alone never changes default behavior. */
  readonly loadPermissionStore?: () => Promise<PermissionStore | undefined>
}

/** The result of `bootstrapSession` — everything the surface needs to wire
 *  the per-turn loop. Most fields are passthroughs of dep factories; the
 *  host owns only the orchestration (idle guards / LLM stack build /
 *  resume FSM run / system-prompt assembly). */
export interface SessionBootstrapResult {
  readonly runtime: SessionRuntimeConfigShape
  /** F1a — the session's repo-local rules (AGENTS.md / CLAUDE.md), resolved ONCE
   *  at bootstrap. `buildBaseFromBootstrap` lifts it onto the base as
   *  `repoRules` (⇒ the per-turn `AgentConfig`, rendered into the cached
   *  `project_md` system section), and the CLI `/rules` indicator consumes this
   *  SAME snapshot rather than re-reading disk — so the surface can never claim
   *  a rule the model did not receive. Absent ⇒ no rule file, an unreadable
   *  source (fail-open), or a rule-less trust class. */
  readonly repoRules?: import("@/agent").RepoRules
  readonly provider: Provider
  readonly model: string
  readonly mode: PermissionMode
  readonly maxTurns: number
  readonly cwd: string
  readonly slog: StructuredLogger
  readonly permission: PermissionContext
  /** ADR-0303 — engine-owned permission posture backing `permission.mode`'s
   *  accessor. The CLI `shift+tab` mode-cycle mutates THIS via
   *  `RuntimeContext.permissionModeState().set()`; the next turn reads it live. */
  readonly permissionModeState: PermissionModeSessionState
  /** RFC-05 E4 — the posture FRONT-DOOR control over the SAME live authority
   *  `permissionModeState` wraps. `buildBaseFromBootstrap` lifts it onto the base
   *  as `postureControl`, so the host `session.posture.set` projection applies the
   *  FULL lossless patch (mode + sandbox + askOutsidePlan) under CAS and `describe`
   *  echoes the live posture; the CLI `/posture` selector shares this SAME control.
   *  Always built (parity with the E3 mode adapter); byte-identical until a posture
   *  mutation occurs. Optional so hermetic-test result constructors stay valid; the
   *  live bootstrap always sets it. */
  readonly postureControl?: import("@/permission/posture/control").PostureControl
  /** RFC-05 E5 — the live `request_user_input` availability reader over the SAME
   *  authority. `buildBaseFromBootstrap` lifts it onto the base as `questionGuard`
   *  (⇒ `AgentConfig.questionGuard`), so the model tool-SPEC projection and the
   *  pre-dispatch admission consult BOTH consult the live `askOutsidePlan`. Default-
   *  OFF: with no posture change the guard returns AVAILABLE (byte-identical); it
   *  subtracts only after a `/posture ask off` denies. Optional for the same reason
   *  as `postureControl`. */
  readonly questionGuard?: import("@/agent/dispatch-guard").QuestionAvailabilityReader
  readonly idleMonitor: BootstrapIdleMonitor
  readonly rejectCounter: BootstrapRejectCounter
  /** Session-level reasoning-effort store (Codex `/model`-style UX, effort-
   *  only). Initial value comes from `QUANTA_EFFORT` (parsed via
   *  `parseEffort`); a present-but-unrecognised value parses to `undefined`
   *  ⇒ store defaults to `"default"`. The `/effort` slash mutates this; the
   *  agent loop reads it once per turn via `AgentConfig.sessionEffort`. */
  readonly effortStore: EffortStore
  /** #17 (C3) — session-level brief-mode store. Initial value comes from
   *  `QUANTA_BRIEF` (parsed via `parseBoolKnob`; unset/non-truthy ⇒ false). The
   *  `/brief` slash + a `set_brief` control-op mutate this; the agent loop reads
   *  it once per turn via `AgentConfig.sessionBrief` to splice BRIEF_NOTICE.
   *  Default-OFF ⇒ getter false ⇒ byte-identical (no notice). */
  readonly briefStore: BriefStore
  readonly llm: LLMPort
  readonly features: BootstrapFeatures
  readonly tooling: Tooling
  /** ADR-0432 / ADR-0138 — session budget meter, constructed ONLY when the
   *  operator opted into the self-edit memory write-guard
   *  (`QUANTA_MEMORY_WRITE_GUARD_PCT` set). The bootstrap threads
   *  `() => meter.remainingPercent()` into `buildTooling` so the guard reads a
   *  LIVE 0..100 signal, and `context-binding.ts` sets it on
   *  `AgentConfig.budgetMeter` so the loop's existing tick sites feed it.
   *  Absent ⇒ no meter is set on the config and the loop is byte-identical
   *  (the guard knob is the single activation gate). Optional so existing
   *  hermetic-test result constructors that predate this field stay valid;
   *  the live bootstrap always sets it (`undefined` when the guard is off). */
  readonly budgetMeter?: AgentConfig["budgetMeter"]
  /** MR-08 — the session's usage-accounting authority, minted at the
   *  composition root by default (`QUANTA_USAGE_ACCOUNTING_V2` unset ⇒ `on`;
   *  `shadow` records without rendering; only `off` skips the mint).
   *  Carried on the result because BOTH halves need the same object: the
   *  runtime overlay sets it on `AgentConfig` so `emitUsage` records into it,
   *  and the cost surfaces project it. Absent ⇒ `off`, and the accounting sink
   *  is a no-op. Optional so result constructors that predate it stay valid. */
  readonly usageAccounting?: AgentConfig["usageAccounting"]
  readonly mcpSurface: BootstrapMcpSurface | undefined
  readonly lifecyclePills: BootstrapLifecyclePills
  readonly lifecycleTaskRegistry: TaskRegistry | undefined
  /** jun-15 P0-b — session Activity Spine store (shared writer/reader). */
  readonly lifecycleActivityStore: import("@/activity").ActivityStore
  readonly lifecycleFollowUpQueue: FollowUpQueue | undefined
  /** RFC-01 A4 — the session pending-question authority, minted by the CLI
   *  lifecycle bundle ONLY under `QUANTA_ATTENTION_NAV`. The runtime overlay
   *  wires it onto `AgentConfig.questionBroker` (so `request_user_input` routes
   *  through it) and the `/attention` slash surface reads it. Absent (gate off /
   *  non-CLI surface) ⇒ byte-identical (`request_user_input` keeps the legacy
   *  `userInputPort`). Optional so hermetic-test result constructors stay valid. */
  readonly lifecycleQuestionBroker?: import("@/session/user-question").UserQuestionBroker
  /** RFC-01 A4 — the live fleet-attention reader (A2's `AttentionReader`), joined
   *  over the SAME registry + broker. Consumed ONLY by the `/attention` slash
   *  surface. Absent ⇒ `/attention` prints "not wired". */
  readonly lifecycleAttention?: import("@/runner/assemble/session-authorities").AttentionReader
  readonly sessionId: string
  readonly history: readonly Message[]
  readonly pendingImages: readonly ImageBlock[]
  readonly idMeta: ResumeResolution["idMeta"]
  /** RFC-03 C2 — the reopened session's durable objective snapshot (id-mode
   *  resume only; `ResumeResolution.objective`). The CLI surface threads it into
   *  `resolveGatedObjectiveAuthority({ restoreFrom })` so the goal / criterion
   *  ids / revision / provenance survive `--resume`. Absent on fresh / legacy /
   *  no-objective sessions ⇒ a fresh empty authority (byte-identical). */
  readonly restoredObjective?: ResumeResolution["objective"]
  readonly onShellEvent: ShellExecObserver | undefined
  readonly workMetricsSink: AgentConfig["workMetricsSink"] | undefined
  readonly stream: StreamPort
  readonly run: AgentConfig["run"]
  readonly costPanel: BootstrapCostPanel | undefined
  readonly branchProgress: BootstrapBranchProgress | undefined
  readonly planStore: PlanStore | undefined
  readonly abort: AbortController
  readonly argPrompt: string | undefined
  readonly system: string
  readonly promptSurfaceProfile: AgentConfig["promptSurfaceProfile"]
  /** Mutable system-prompt holder. Surfaces that mount the `/identity-mode`
   *  slash use {@link refreshSystemPrompt} to rebuild the prompt after a
   *  mode swap; turn assemblers read the latest value via `systemSource.get()`.
   *  Carried at the host boundary so a Web/Tauri surface gets the same shape
   *  without re-resolving env state. */
  readonly systemSource: SystemSource
  /** Idempotent rebuild of the current system prompt from the live identity
   *  mode. */
  readonly refreshSystemPrompt: () => void
  /** Authoritative session-owned tool-profile state. The slash surface and the
   *  admissibility gate read the SAME live cell. */
  readonly toolProfileState: ToolProfileSessionState
  /** Authoritative session-owned identity-mode state. `/identity` mutates this
   *  cell; the next turn reads the same live mode. */
  readonly identityModeState: IdentityModeSessionState
  /** Authoritative session-owned focus-chain tracker. The slash surface and
   *  the loop share the SAME tracker instance. */
  readonly focusChain: { readonly tracker: FocusChainPort; readonly reinjectEveryN: number }
  /** `session_config` tool seam — read + write over the agent's own SDK
   *  posture (effort tier, permission mode, identity mode, tool profile,
   *  model, provider). Built once at bootstrap from `effortStore` +
   *  `permissionModeState` + `identityModeState` + `toolProfileState` +
   *  `runtime.model` + `runtime.provider`. The downstream
   *  `context-binding.ts` wires it onto
   *  `AgentConfig.sessionConfigPort`; the dispatch seam then exposes it on
   *  `ToolContext.sessionConfig` for the `session_config` default tool.
   *  Absent ⇒ the tool yields a typed `not_wired` failure to the model
   *  (byte-identical default-OFF for any caller that never invokes it). */
  readonly sessionConfigPort: AgentConfig["sessionConfigPort"]
  /** jun-6 (RFC jun-6-ai-session-title) — fire-and-forget AI session titler,
   *  built ONLY when `QUANTA_SESSION_AUTO_TITLE` is on AND
   *  `QUANTA_SESSION_TITLE_MODEL` resolves a cheap `LLMPort` (else `undefined`).
   *  The downstream `context-binding.ts` spreads it onto
   *  `AgentConfig.autoTitlePort`; `runSessionStartSequence` then fires it ONCE on
   *  the opening turn (never awaited, never clobbers a human rename). Absent ⇒
   *  the loop's title branch is dead (byte-identical default-OFF). */
  readonly autoTitlePort: AgentConfig["autoTitlePort"]
  readonly shutdownMcp: () => Promise<void>
  /** ADR-0301 — `--playbook-trigger` CLI flag echo, threaded from
   *  `SessionRuntimeConfigShape.playbookTriggerFlag`. The downstream loop
   *  wires this into `maybeStartPlaybookTriggerWire({ cliFlag })`; the wire
   *  helper enforces env-on-wins precedence. Default-OFF byte-identical
   *  when the flag is absent on argv (`false` ⇒ slot omitted at the loop
   *  call site). `boolean | undefined` rather than `boolean` so the
   *  consumer can spread the slot conditionally under
   *  `exactOptionalPropertyTypes`. */
  readonly playbookCliFlag: boolean | undefined
  /** Re-exposed for {@link composeCliSessionDeps} so the CLI surface can call
   *  the surface-injected reviewer factories without re-importing them at the
   *  CLI seam. ADR-0299 §3 — keeps `src/apps/cli/repl/**` free of any direct
   *  reference to the reviewer subagent module. */
  readonly materializeReviewerAgent: MaterializeReviewerAgentFactory
  readonly createSubagentBackedGuardianReview: CreateGuardianReviewFactory
  /** jun-7-misc 03 (ADR-0497) — re-exposed guardian per-action ASSESSOR factory,
   *  threaded the same way as {@link createSubagentBackedGuardianReview} so the
   *  CLI surface can build the assessor servicer without re-importing the
   *  reviewer-subagent module (ADR-0299 §3). */
  readonly createSubagentBackedGuardianAssess: CreateGuardianAssessFactory
  /** RFC04-2/3 (MCP tool hot-reload) — the atomically-swappable turn capability
   *  snapshot pointer, present ONLY when `QUANTA_MCP_HOT_RELOAD` is on AND the
   *  load produced eligible (non-supervised) reload sources. `context-binding`
   *  spreads it onto `AgentConfig.registrySnapshotRef`; `session-bootstrap` reads
   *  `current()` at the turn boundary so a reload the controller published
   *  between turns surfaces at the NEXT turn. Seeded from `tooling.registry`, so
   *  turn-0 is byte-identical to the no-ref path. Absent (default) ⇒ omitted ⇒
   *  the loop builds the snapshot from `registry` exactly as today. */
  readonly registrySnapshotRef?: AgentConfig["registrySnapshotRef"]
  /** RFC02-3 (A8, feeder) — the SAME gated route-event forwarder `sink` handed to
   *  `buildLlm` for the provider-fallback path (bound to the live `stream.emit`).
   *  Exposed so the `/retry-with` state factory AND the scheduler reroute compose
   *  attach it to their `onModelReroute` slots — closing the feeder gap where only
   *  provider-fallback transitions reached the stream. Present ONLY when
   *  `QUANTA_MODEL_REROUTE_EVENT` is on; absent ⇒ no sink attached (byte-identical). */
  readonly routeEventSink?: (ev: AgentEvent) => void
}
