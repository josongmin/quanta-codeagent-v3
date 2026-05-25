import {
  type AgentConfig,
  buildSystemPrompt,
  createEffortStore,
  type EffortStore,
  parseEffort,
  RetryingLLM,
} from "@/agent"
import type { FollowUpQueue } from "@/agent/follow-up-queue"
import type { PlanStore } from "@/agent/plan/state"
import {
  createSubagentBackedGuardianReview,
  materializeReviewerAgent,
} from "@/agent/tier1/reviewer-subagent"
import type { ImageBlock, LLMPort, Message } from "@/llm"
import { buildShellOtelObserver, StructuredLogger } from "@/observability"
import type { PermissionContext, PermissionMode, ReviewerPort } from "@/permission"
import { errMessage, logger } from "@/shared"
import type { StreamPort } from "@/stream"
import type { TaskRegistry } from "@/subagent"
import { composeShellObservers } from "@/tool"
import type { BranchProgressTracker } from "../branch-search-progress"
import type { CostPanel } from "../cost-panel"
import { createIdleMonitor, type IdleMonitor } from "../idle-monitor"
import { loadImageBlock } from "../image-loader"
import {
  buildLLM,
  buildStreaming,
  buildTooling,
  composeLLM,
  isPathLikeToken,
  loadFeatures,
  pickIdentity,
  pickPersona,
  resolveResume,
  type SessionDeps,
  type Tooling,
} from "../internal"
import type { LifecyclePills, McpPillServer } from "../lifecycle-pills"
import type { McpSurfaceInfo } from "../mcp-cmd"
import { createRejectCounter, type RejectCounter } from "../reject-counter"
import { switchToSessionCwd } from "../session-io"
import { buildShellStreamPainter } from "../shell-stream-painter"
import { buildMcpSurfaceInfo } from "./mcp-surface-wire"
import type { SessionRuntimeConfig } from "./session-runtime-config"

export type SessionBootstrapFailureKind =
  | "llm_build_failed"
  | "image_load_failed"
  | "resume_conflict"
  | "resume_missing_id"

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

const failSessionBootstrap = (
  kind: SessionBootstrapFailureKind,
  message: string,
  cause?: unknown,
): never => {
  throw new SessionBootstrapError(kind, message, cause)
}

export interface SessionBootstrapDeps {
  readonly buildLifecycleBundle: () => {
    pills: LifecyclePills
    taskRegistry: TaskRegistry | undefined
    followUpQueue: FollowUpQueue | undefined
  }
  readonly deriveMcpPillServers: (
    mcpTools: ReadonlyArray<{ name: string }>,
  ) => readonly McpPillServer[]
  readonly buildCostPanelOrUndefined: (
    envSource: NodeJS.ProcessEnv,
    isTTY: boolean | undefined,
    model: string,
  ) => CostPanel | undefined
  readonly buildBranchProgressOrUndefined: (
    envSource: NodeJS.ProcessEnv,
    isTTY: boolean | undefined,
  ) => BranchProgressTracker | undefined
  readonly buildPlanStoreOrUndefined: (envSource: NodeJS.ProcessEnv) => PlanStore | undefined
  readonly buildWorkMetricsSink: (enabled: boolean) => AgentConfig["workMetricsSink"] | undefined
}

export interface SessionBootstrapResult {
  readonly runtime: SessionRuntimeConfig
  readonly provider: SessionRuntimeConfig["provider"]
  readonly model: string
  readonly mode: PermissionMode
  readonly maxTurns: number
  readonly cwd: string
  readonly slog: StructuredLogger
  readonly permission: PermissionContext
  readonly idleMonitor: IdleMonitor
  readonly rejectCounter: RejectCounter
  /** Session-level reasoning-effort store (Codex `/model`-style UX, effort-
   *  only). Initial value comes from `QUANTA_EFFORT` (parsed via
   *  `parseEffort`); a present-but-unrecognised value parses to `undefined`
   *  ⇒ store defaults to `"default"`. The `/effort` slash mutates this; the
   *  agent loop reads it once per turn via `AgentConfig.sessionEffort`. */
  readonly effortStore: EffortStore
  readonly llm: LLMPort
  readonly features: Awaited<ReturnType<typeof loadFeatures>>
  readonly tooling: Tooling
  readonly mcpSurface: McpSurfaceInfo | undefined
  readonly lifecyclePills: LifecyclePills
  readonly lifecycleTaskRegistry: TaskRegistry | undefined
  readonly lifecycleFollowUpQueue: FollowUpQueue | undefined
  readonly sessionId: string
  readonly history: readonly Message[]
  readonly pendingImages: readonly ImageBlock[]
  readonly idMeta: Awaited<ReturnType<typeof resolveResume>>["idMeta"]
  readonly onShellEvent: SessionDeps["onShellEvent"]
  readonly workMetricsSink: AgentConfig["workMetricsSink"] | undefined
  readonly stream: StreamPort
  readonly run: ReturnType<typeof buildStreaming>["run"]
  readonly costPanel: CostPanel | undefined
  readonly branchProgress: BranchProgressTracker | undefined
  readonly planStore: PlanStore | undefined
  readonly abort: AbortController
  readonly argPrompt: string | undefined
  readonly system: string
  readonly guardianReview: ReviewerPort["guardianReview"] | undefined
  readonly shutdownMcp: () => Promise<void>
  /** ADR-0301 — `--playbook-trigger` CLI flag echo, threaded from
   *  `SessionRuntimeConfig.playbookTriggerFlag`. The downstream loop wires
   *  this into `maybeStartPlaybookTriggerWire({ cliFlag })`; the wire helper
   *  enforces env-on-wins precedence. Default-OFF byte-identical when the
   *  flag is absent on argv (`false` ⇒ slot omitted at the loop call site).
   *  `boolean | undefined` rather than `boolean` so the consumer can spread
   *  the slot conditionally under `exactOptionalPropertyTypes`. */
  readonly playbookCliFlag: boolean | undefined
}

const buildIdleGuards = (
  config: SessionRuntimeConfig,
): { idleMonitor: IdleMonitor; rejectCounter: RejectCounter } => {
  const idleMonitor = createIdleMonitor({
    idleThresholdMs:
      config.idleSuppressOn && Number.isFinite(config.idleMs)
        ? config.idleMs
        : Number.POSITIVE_INFINITY,
    defaultSnoozeMs:
      config.idleSuppressOn && Number.isFinite(config.snoozeDefaultMs)
        ? config.snoozeDefaultMs
        : 300_000,
  })
  const rejectCounter = createRejectCounter({
    threshold:
      config.idleSuppressOn && Number.isFinite(config.rejectLimit) && config.rejectLimit > 0
        ? config.rejectLimit
        : Number.POSITIVE_INFINITY,
  })
  return { idleMonitor, rejectCounter }
}

const buildLlmStack = (
  provider: SessionRuntimeConfig["provider"],
  model: string,
  mode: PermissionMode,
  permission: PermissionContext,
  signal: AbortSignal,
  slog: StructuredLogger,
): LLMPort => {
  try {
    const llm = buildLLM(provider, model)
    const retryingLLM = new RetryingLLM({ inner: llm, signal })
    return composeLLM(retryingLLM, provider, signal, mode, permission, slog)
  } catch (e) {
    return failSessionBootstrap("llm_build_failed", errMessage(e), e)
  }
}

const loadSeedImages = (config: SessionRuntimeConfig): ImageBlock[] => {
  try {
    return config.pendingImagePaths.map(loadImageBlock)
  } catch (e) {
    return failSessionBootstrap("image_load_failed", errMessage(e), e)
  }
}

const stopMcpClients = async (
  clients: Awaited<ReturnType<typeof loadFeatures>>["mcpClients"],
): Promise<void> => {
  for (const client of clients) await client.stop().catch(() => undefined)
}

const composeShellEvent = (
  metrics: Awaited<ReturnType<typeof loadFeatures>>["metrics"],
  config: SessionRuntimeConfig,
): SessionDeps["onShellEvent"] => {
  const painterObs = config.stdinIsTTY ? buildShellStreamPainter() : undefined
  const otelObs = metrics ? buildShellOtelObserver(metrics) : undefined
  return painterObs !== undefined || otelObs !== undefined
    ? composeShellObservers(painterObs, otelObs)
    : undefined
}

const buildGuardianReview = (args: {
  llm: LLMPort
  registry: Tooling["registry"]
  permission: PermissionContext
  history: readonly Message[]
  system: string
  cwd: string
  maxTurns: number
  signal: AbortSignal
  subagentConfig: Tooling["subagentConfig"]
  stream: StreamPort
}): ReviewerPort["guardianReview"] | undefined => {
  if (args.subagentConfig === undefined) return undefined
  const reviewerAgent = materializeReviewerAgent({
    llm: args.llm,
    registry: args.registry,
    stream: args.stream,
    permission: args.permission,
    messages: [...args.history],
    system: args.system,
    cwd: args.cwd,
    maxTurns: args.maxTurns,
    signal: args.signal,
    subagent: args.subagentConfig,
  })
  return reviewerAgent !== undefined
    ? createSubagentBackedGuardianReview({
        reviewer: reviewerAgent,
        signal: args.signal,
      })
    : undefined
}

/** Resolve feature flags, tooling, resume state, and reusable session deps that
 *  do not require terminal-specific host wiring. */
export const bootstrapSession = async (
  deps: SessionBootstrapDeps,
  runtime: SessionRuntimeConfig,
): Promise<SessionBootstrapResult> => {
  const slog = new StructuredLogger()
  const { idleMonitor, rejectCounter } = buildIdleGuards(runtime)
  const permission: PermissionContext = { mode: runtime.mode }
  const abort = new AbortController()
  const effortStore = createEffortStore(parseEffort(runtime.env.QUANTA_EFFORT) ?? "default")
  const finalLLM = buildLlmStack(
    runtime.provider,
    runtime.model,
    runtime.mode,
    permission,
    abort.signal,
    slog,
  )

  const features = await loadFeatures(slog)
  try {
    const {
      pills: lifecyclePills,
      taskRegistry: lifecycleTaskRegistry,
      followUpQueue: lifecycleFollowUpQueue,
    } = deps.buildLifecycleBundle()

    const tooling = buildTooling(
      features.mcpTools,
      features.lspTools,
      features.lspNavTools,
      features.gitToolList,
      slog,
      lifecycleTaskRegistry,
    )

    const mcpSurface = buildMcpSurfaceInfo({
      configs: features.mcpConfigs,
      bridgedTools: features.mcpTools,
      configPath: runtime.mcpConfigPath,
    })

    if (features.mcpClients.length > 0) {
      lifecyclePills.update({
        mcp: { servers: [...deps.deriveMcpPillServers(features.mcpTools)] },
      })
    }

    const { stream, run } = buildStreaming(runtime.observeDir, slog)
    const pendingImages = loadSeedImages(runtime)

    let cwd = runtime.cwd
    const inIdModeAtStart =
      runtime.newSession || (features.resume !== undefined && !isPathLikeToken(features.resume))
    if (!inIdModeAtStart) {
      logger.info(
        `quanta ready (provider=${runtime.provider}, model=${runtime.model}, mode=${runtime.mode}, cwd=${cwd})`,
      )
    }
    const resolved = await resolveResume({
      resume: features.resume,
      newSession: runtime.newSession,
      title: runtime.title,
      cwd,
      initialSessionId: tooling.sessionId,
      slog,
      onSessionMinted: (id) => logger.info(`session: ${id}`),
    })
    if (resolved.conflictError !== undefined) {
      failSessionBootstrap("resume_conflict", resolved.conflictError)
    }
    if (resolved.missingIdError !== undefined) {
      failSessionBootstrap(
        "resume_missing_id",
        `--resume: session id not found: ${resolved.missingIdError}`,
      )
    }
    const { idMeta } = resolved
    const history: Message[] = resolved.history
    const sessionId = resolved.sessionId
    if (idMeta) cwd = switchToSessionCwd(cwd, idMeta.cwd, slog)
    if (inIdModeAtStart && idMeta) {
      logger.info(
        `quanta ready (provider=${runtime.provider}, model=${runtime.model}, mode=${runtime.mode}, cwd=${cwd}, session=${idMeta.id})`,
      )
    }

    const identity = pickIdentity()
    const system = buildSystemPrompt(cwd, {
      persona: pickPersona(),
      ...(identity !== undefined ? { identity } : {}),
    })
    const onShellEvent = composeShellEvent(features.metrics, runtime)
    const workMetricsSink = deps.buildWorkMetricsSink(features.metrics !== undefined)
    const costPanel = deps.buildCostPanelOrUndefined(
      runtime.env,
      runtime.stdoutIsTTY,
      runtime.model,
    )
    const branchProgress = deps.buildBranchProgressOrUndefined(runtime.env, runtime.stdoutIsTTY)
    const planStore = deps.buildPlanStoreOrUndefined(runtime.env)
    const guardianReview = buildGuardianReview({
      llm: finalLLM,
      registry: tooling.registry,
      permission,
      history,
      system,
      cwd,
      maxTurns: runtime.maxTurns,
      signal: abort.signal,
      subagentConfig: tooling.subagentConfig,
      stream,
    })
    const shutdownMcp = async (): Promise<void> => {
      await stopMcpClients(features.mcpClients)
    }

    return {
      runtime,
      provider: runtime.provider,
      model: runtime.model,
      mode: runtime.mode,
      maxTurns: runtime.maxTurns,
      cwd,
      slog,
      permission,
      idleMonitor,
      rejectCounter,
      effortStore,
      llm: finalLLM,
      features,
      tooling,
      mcpSurface,
      lifecyclePills,
      lifecycleTaskRegistry,
      lifecycleFollowUpQueue,
      sessionId,
      history,
      pendingImages,
      idMeta,
      onShellEvent,
      workMetricsSink,
      stream,
      run,
      costPanel,
      branchProgress,
      planStore,
      abort,
      argPrompt: runtime.argPrompt,
      system,
      guardianReview,
      shutdownMcp,
      // ADR-0301 — present the parsed CLI flag as `true | undefined`. Mapping
      // `false → undefined` lets the downstream consumer spread the slot
      // conditionally (`exactOptionalPropertyTypes`-friendly) and keeps the
      // default-OFF path byte-identical (no `cliFlag: false` reaching the
      // wire — env-on precedence remains the single arbiter).
      playbookCliFlag: runtime.playbookTriggerFlag === true ? true : undefined,
    }
  } catch (error) {
    await stopMcpClients(features.mcpClients)
    throw error
  }
}
