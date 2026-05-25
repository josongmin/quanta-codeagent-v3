/**
 * `@/host/bootstrap/bootstrap-session` — the surface-agnostic bootstrap.
 *
 * SLICE INVARIANT (ADR-0299): this module imports ONLY from cross-cutting
 * Layer-2 cores (`@/agent`, `@/llm`, `@/observability`, `@/permission`,
 * `@/runner/*`, `@/shared`, `@/stream`, `@/subagent`, `@/tool`). It MUST NOT
 * import from `src/apps/**` — every env/argv/terminal-bound helper is
 * injected as a closure via {@link SessionBootstrapDeps}.
 *
 * The body below is the verbatim relocation of the prior
 * `src/apps/cli/repl/session-bootstrap.ts#bootstrapSession` function: same
 * orchestration order, same conditional logs, same shutdown semantics. The
 * only delta is that what used to be direct `from "../internal"` imports
 * (`buildLLM`, `buildTooling`, `loadFeatures`, …) is now `deps.*` calls.
 * Default-OFF byte-identical: the CLI surface supplies the SAME closures so
 * the produced result is identical to today's.
 */

import { buildSystemPrompt, createEffortStore, parseEffort } from "@/agent"
import { defaultFocusChainTracker, type FocusChainPort } from "@/agent/focus-chain"
import {
  buildSystemPromptForMode,
  defaultModeVariantRegistry,
  MODE_VARIANT_KEYS,
  type ModeVariantKey,
} from "@/agent/system-prompt"
import {
  ALL_TOOL_PROFILE_NAMES,
  defaultToolProfileResolver,
  isToolProfileName,
  type ToolProfileName,
} from "@/agent/tool-profile"
import type { ImageBlock, LLMPort, Message } from "@/llm"
import { StructuredLogger } from "@/observability"
import type { PermissionContext } from "@/permission"
import {
  createIdentityModeSessionState,
  createSystemSource,
  createToolProfileSessionState,
  type IdentityModeSessionState,
  type ToolProfileSessionState,
} from "@/runner/assemble"
import { isPathLikeToken } from "@/runner/orchestrate"
import { errMessage, logger } from "@/shared"
import {
  type BootstrapFeatures,
  type SessionBootstrapDeps,
  SessionBootstrapError,
  type SessionBootstrapFailureKind,
  type SessionBootstrapResult,
  type SessionFeatureConfig,
  type SessionRuntimeConfigShape,
} from "./types"

const failSessionBootstrap = (
  kind: SessionBootstrapFailureKind,
  message: string,
  cause?: unknown,
): never => {
  throw new SessionBootstrapError(kind, message, cause)
}

const loadSeedImages = (
  config: SessionRuntimeConfigShape,
  loadImageBlock: SessionBootstrapDeps["loadImageBlock"],
): ImageBlock[] => {
  try {
    return config.pendingImagePaths.map((p) => loadImageBlock(p))
  } catch (e) {
    return failSessionBootstrap("image_load_failed", errMessage(e), e)
  }
}

const stopMcpClients = async (clients: BootstrapFeatures["mcpClients"]): Promise<void> => {
  for (const client of clients) await client.stop().catch(() => undefined)
}

const DEFAULT_TOOL_PROFILE: ToolProfileName = "write"
const DEFAULT_IDENTITY_MODE: ModeVariantKey = "default"
const DEFAULT_FOCUS_CHAIN_REINJECT_EVERY = 6

const resolveToolProfileState = (env: NodeJS.ProcessEnv): ToolProfileSessionState => {
  const raw = env.QUANTA_TOOL_PROFILE
  const selected = raw === undefined || raw === "" ? DEFAULT_TOOL_PROFILE : raw
  if (!isToolProfileName(selected)) {
    logger.warn(`QUANTA_TOOL_PROFILE='${raw}' unknown; valid: ${ALL_TOOL_PROFILE_NAMES.join(", ")}`)
    return createToolProfileSessionState({
      resolver: defaultToolProfileResolver(),
      defaultName: DEFAULT_TOOL_PROFILE,
    })
  }
  return createToolProfileSessionState({
    resolver: defaultToolProfileResolver(),
    defaultName: selected,
  })
}

const resolveIdentityModeState = (env: NodeJS.ProcessEnv): IdentityModeSessionState => {
  const raw = env.QUANTA_IDENTITY_MODE
  const mode = raw ?? DEFAULT_IDENTITY_MODE
  if (!(MODE_VARIANT_KEYS as readonly string[]).includes(mode)) {
    logger.warn(`QUANTA_IDENTITY_MODE='${mode}' unknown; valid: ${MODE_VARIANT_KEYS.join(", ")}`)
    return createIdentityModeSessionState({
      registry: defaultModeVariantRegistry(),
      defaultMode: DEFAULT_IDENTITY_MODE,
    })
  }
  return createIdentityModeSessionState({
    registry: defaultModeVariantRegistry(),
    defaultMode: mode as ModeVariantKey,
  })
}

const resolveFocusChain = (
  env: NodeJS.ProcessEnv,
): { readonly tracker: FocusChainPort; readonly reinjectEveryN: number } => {
  const raw = env.QUANTA_FOCUS_CHAIN_EVERY
  if (raw === undefined || raw === "") {
    return {
      tracker: defaultFocusChainTracker({
        reinjectEveryN: DEFAULT_FOCUS_CHAIN_REINJECT_EVERY,
      }),
      reinjectEveryN: DEFAULT_FOCUS_CHAIN_REINJECT_EVERY,
    }
  }
  const every = Number.parseInt(raw, 10)
  if (!Number.isFinite(every) || every <= 0) {
    logger.warn(`QUANTA_FOCUS_CHAIN_EVERY='${raw}' must be a positive integer`)
    return {
      tracker: defaultFocusChainTracker({
        reinjectEveryN: DEFAULT_FOCUS_CHAIN_REINJECT_EVERY,
      }),
      reinjectEveryN: DEFAULT_FOCUS_CHAIN_REINJECT_EVERY,
    }
  }
  return {
    tracker: defaultFocusChainTracker({ reinjectEveryN: every }),
    reinjectEveryN: every,
  }
}

const buildSessionStatePorts = (args: {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly persona: ReturnType<SessionBootstrapDeps["pickPersona"]>
  readonly identity: readonly string[] | undefined
}): {
  readonly toolProfileState: ToolProfileSessionState
  readonly identityModeState: IdentityModeSessionState
  readonly focusChain: { readonly tracker: FocusChainPort; readonly reinjectEveryN: number }
  readonly systemSource: ReturnType<typeof createSystemSource>
  readonly refreshSystemPrompt: () => void
} => {
  const toolProfileState = resolveToolProfileState(args.env)
  const identityModeState = resolveIdentityModeState(args.env)
  const focusChain = resolveFocusChain(args.env)
  const systemSource = createSystemSource(
    args.identity === undefined && args.env.QUANTA_IDENTITY === "1"
      ? buildSystemPromptForMode({
          mode: identityModeState.get(),
          registry: identityModeState.registry,
          persona: args.persona,
        })
      : buildSystemPrompt(args.cwd, {
          persona: args.persona,
          ...(args.identity !== undefined ? { identity: args.identity } : {}),
        }),
  )
  const refreshSystemPrompt = (): void => {
    systemSource.set(
      buildSystemPromptForMode({
        mode: identityModeState.get(),
        registry: identityModeState.registry,
        persona: args.persona,
      }),
    )
  }
  return {
    toolProfileState,
    identityModeState,
    focusChain,
    systemSource,
    refreshSystemPrompt,
  }
}

const buildPromptState = (
  deps: SessionBootstrapDeps,
  runtime: SessionRuntimeConfigShape,
  cwd: string,
): {
  readonly system: string
  readonly systemSource: ReturnType<typeof createSystemSource>
  readonly refreshSystemPrompt: () => void
  readonly toolProfileState: ToolProfileSessionState
  readonly identityModeState: IdentityModeSessionState
  readonly focusChain: { readonly tracker: FocusChainPort; readonly reinjectEveryN: number }
} => {
  const persona = deps.pickPersona()
  const identity = deps.pickIdentity()
  const { toolProfileState, identityModeState, focusChain, systemSource, refreshSystemPrompt } =
    buildSessionStatePorts({
      cwd,
      env: runtime.env,
      persona,
      identity,
    })
  return {
    system: systemSource.get(),
    systemSource,
    refreshSystemPrompt,
    toolProfileState,
    identityModeState,
    focusChain,
  }
}

/** Resolve feature flags, tooling, resume state, and reusable session deps that
 *  do not require terminal-specific host wiring.
 *
 *  Surface-agnostic: the supplied {@link SessionBootstrapDeps} carries every
 *  env-bound / terminal-bound factory. The CLI surface composes them by
 *  wrapping its `apps/cli/internal` helpers; a Web/Tauri surface composes the
 *  same shape from its own HTTP/IPC adapters.
 */
export const bootstrapSession = async (
  deps: SessionBootstrapDeps,
  runtime: SessionRuntimeConfigShape,
  featureCfg: SessionFeatureConfig,
): Promise<SessionBootstrapResult> => {
  const slog = new StructuredLogger()
  const { idleMonitor, rejectCounter } = deps.buildIdleGuards(runtime)
  const permission: PermissionContext = { mode: runtime.mode }
  const abort = new AbortController()
  const effortStore = createEffortStore(parseEffort(runtime.env.QUANTA_EFFORT) ?? "default")
  let finalLLM: LLMPort
  try {
    finalLLM = deps.buildLlm(
      runtime.provider,
      runtime.model,
      runtime.mode,
      permission,
      abort.signal,
      slog,
    )
  } catch (e) {
    return failSessionBootstrap("llm_build_failed", errMessage(e), e)
  }

  const features = await deps.loadFeatures(slog)
  try {
    const {
      pills: lifecyclePills,
      taskRegistry: lifecycleTaskRegistry,
      followUpQueue: lifecycleFollowUpQueue,
    } = deps.buildLifecycleBundle(featureCfg)

    const tooling = deps.buildTooling(
      features.mcpTools,
      features.lspTools,
      features.lspNavTools,
      features.gitToolList,
      slog,
      lifecycleTaskRegistry,
    )

    const mcpSurface = deps.buildMcpSurfaceInfo({
      configs: features.mcpConfigs,
      bridgedTools: features.mcpTools,
      configPath: runtime.mcpConfigPath,
    })

    if (features.mcpClients.length > 0) {
      lifecyclePills.update({
        mcp: { servers: [...deps.deriveMcpPillServers(features.mcpTools)] },
      })
    }

    const { stream, run } = deps.buildStreaming(runtime.observeDir, slog)
    const pendingImages = loadSeedImages(runtime, deps.loadImageBlock)

    let cwd = runtime.cwd
    const inIdModeAtStart =
      runtime.newSession || (features.resume !== undefined && !isPathLikeToken(features.resume))
    if (!inIdModeAtStart) {
      logger.info(
        `quanta ready (provider=${runtime.provider}, model=${runtime.model}, mode=${runtime.mode}, cwd=${cwd})`,
      )
    }
    const resolved = await deps.resolveResume({
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
    if (idMeta) cwd = deps.switchToSessionCwd(cwd, idMeta.cwd, slog)
    if (inIdModeAtStart && idMeta) {
      logger.info(
        `quanta ready (provider=${runtime.provider}, model=${runtime.model}, mode=${runtime.mode}, cwd=${cwd}, session=${idMeta.id})`,
      )
    }

    const {
      system,
      systemSource,
      refreshSystemPrompt,
      toolProfileState,
      identityModeState,
      focusChain,
    } = buildPromptState(deps, runtime, cwd)
    const onShellEvent = deps.composeShellEvent(features.metrics, runtime.stdoutIsTTY)
    const workMetricsSink = deps.buildWorkMetricsSink(features.metrics !== undefined)
    const costPanel = deps.buildCostPanelOrUndefined(featureCfg, runtime.model)
    const branchProgress = deps.buildBranchProgressOrUndefined(featureCfg)
    const planStore = deps.buildPlanStoreOrUndefined(featureCfg)
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
      systemSource,
      refreshSystemPrompt,
      toolProfileState,
      identityModeState,
      focusChain,
      shutdownMcp,
      // ADR-0301 — present the parsed CLI flag as `true | undefined`. Mapping
      // `false → undefined` lets the downstream consumer spread the slot
      // conditionally (`exactOptionalPropertyTypes`-friendly) and keeps the
      // default-OFF path byte-identical (no `cliFlag: false` reaching the
      // wire — env-on precedence remains the single arbiter).
      playbookCliFlag: runtime.playbookTriggerFlag === true ? true : undefined,
      materializeReviewerAgent: deps.materializeReviewerAgent,
      createSubagentBackedGuardianReview: deps.createSubagentBackedGuardianReview,
    }
  } catch (error) {
    await stopMcpClients(features.mcpClients)
    throw error
  }
}
