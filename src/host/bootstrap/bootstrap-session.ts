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

import { BudgetMeter, buildSystemPrompt, createEffortStore, parseEffort } from "@/agent"
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
import { type CapabilityDescriptor, runCapabilityProbe, type Surface } from "@/capability"
import type { ImageBlock, LLMPort, Message } from "@/llm"
import { StructuredLogger } from "@/observability"
import type { PermissionContext } from "@/permission"
import {
  createIdentityModeSessionState,
  createPermissionModeSessionState,
  createSystemSource,
  createToolProfileSessionState,
  type IdentityModeSessionState,
  type ToolProfileSessionState,
} from "@/runner/assemble"
import { isPathLikeToken } from "@/runner/orchestrate"
import { errMessage, gateOn, logger } from "@/shared"
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
    args.identity === undefined && gateOn(args.env, "QUANTA_IDENTITY")
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

/**
 * ADR-0503 P3 — armed capability consistency probe (READ-ONLY drift sweep).
 *
 * Behind the strict master gate `QUANTA_CAPABILITY_LAYER` (default-OFF). When
 * OFF: {@link runCapabilityProbe} short-circuits to `[]` BEFORE any work, so this
 * function logs nothing and adds ZERO behavior — the un-armed bootstrap path is
 * byte-identical (the #1 invariant). When ON: it sweeps every declared capability
 * × surface, comparing the unified resolver against the legacy per-surface gate,
 * and SURFACES any split-brain (`agrees === false`) as a single `warn` line. It
 * NEVER enforces or replaces a legacy gate — observe-only.
 *
 * The legacy gate is injected: for the seed registry (all `llmTool` caps) the
 * legacy gate is the tool's own env gate, `gateOn(env, cap.gate.envKey)`.
 */
const probeCapabilityConsistency = (env: NodeJS.ProcessEnv): void => {
  // OBSERVE-ONLY + NON-FATAL: a consistency probe must NEVER be able to break
  // session bootstrap, so the whole body is try-caught (the warn surface is the
  // only effect). This matters especially once `legacyGateFor` is upgraded to the
  // real (throwable) registration predicate — see the SCAFFOLD note below.
  try {
    // ADR-0503 P3 — REAL composite check. `resolveExposure` now models the
    // COMPOSITE gate (workflow also requires the default-ON parent QUANTA_SUBAGENT),
    // so it is NO LONGER a re-derivation of `gateOn(env, gate.envKey)`. This
    // `legacyGateFor` is exactly that lone own-gate read — the pre-composite
    // predictor each surface used to make in isolation — so when a composite
    // require is OFF while the own gate is
    // ON (e.g. QUANTA_WORKFLOW=1 + QUANTA_SUBAGENT=0) the resolver says NOT-exposed
    // while this lone read says exposed ⇒ `agrees === false` SURFACES the real
    // split-brain (observe-only). The CI declaration↔reality lock lives in
    // tests/unit/capability/capability-exposure-matches-reality-hellgate.test.ts
    // (it drives the actual internal.ts assembly); this runtime probe is the live
    // observe-only drift sweep using the accurate composite prediction.
    const legacyGateFor = (cap: CapabilityDescriptor, _surface: Surface): boolean =>
      gateOn(env, cap.gate.envKey)
    const probes = runCapabilityProbe(env, legacyGateFor)
    const splitBrain = probes.filter((p) => !p.agrees)
    if (splitBrain.length > 0) {
      logger.warn(
        `capability layer: split-brain exposure drift detected (observe-only) on ${splitBrain.length} (capability,surface) pair(s)`,
        {
          drift: splitBrain.map((p) => ({
            capability: p.capabilityId,
            surface: p.surface,
            resolved: p.resolved,
            legacy: p.legacy,
          })),
        },
      )
    }
  } catch (e) {
    logger.warn(`capability probe skipped (non-fatal): ${errMessage(e)}`)
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
  // ADR-0503 P3 — armed, read-only capability consistency probe. Gated on the
  // strict master gate inside the runner; OFF ⇒ byte-identical no-op (no probe,
  // no log). Observe-only: it never enforces or replaces a legacy gate.
  probeCapabilityConsistency(runtime.env)
  const { idleMonitor, rejectCounter } = deps.buildIdleGuards(runtime)
  // ADR-0303 — the permission posture is engine-owned mutable state, not a
  // slash-local mirror. `permission.mode` is an ACCESSOR over
  // `permissionModeState`, so when a surface mutates the posture mid-session
  // (CLI `shift+tab` mode-cycle → `RuntimeContext.permissionModeState().set()`)
  // the change is read LIVE by the very next turn's admissibility gate — every
  // existing `permission.mode` reader (snapshot getter, per-turn base spread,
  // `describe()`) observes the new value with no hot-path change. Seeded from
  // `runtime.mode` so the default path is byte-identical.
  const permissionModeState = createPermissionModeSessionState({ defaultMode: runtime.mode })
  const permission: PermissionContext = {
    get mode() {
      return permissionModeState.get()
    },
    set mode(next) {
      permissionModeState.set(next)
    },
  }
  const abort = new AbortController()
  const effortStore = createEffortStore(parseEffort(runtime.env.QUANTA_EFFORT) ?? "default")
  let finalLLM: LLMPort
  try {
    finalLLM = await deps.buildLlm(
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

  // jun-6 (RFC jun-6-ai-session-title) — build the fire-and-forget AI titler.
  // Default-OFF: the surface factory returns `undefined` unless
  // `QUANTA_SESSION_AUTO_TITLE` is on AND `QUANTA_SESSION_TITLE_MODEL` resolves a
  // cheap port. Mirrors the `buildSummarizerLlm` second-LLM precedent (the cheap
  // LLM is pinned to the session abort signal so it is cancelled on session end).
  // Absent ⇒ `context-binding.ts` omits `AgentConfig.autoTitlePort` (byte-identical).
  const autoTitlePort = deps.buildAutoTitlePort(runtime.provider, abort.signal)

  // B1 (jun-04) — thread the freshly-built LLM so an inbound MCP
  // `sampling/createMessage` can be fulfilled by the loaded clients (the surface
  // gates advertisement on its knobs + consent; passing the LLM here is what
  // makes the wiring possible at all).
  const features = await deps.loadFeatures(slog, finalLLM)
  try {
    const {
      pills: lifecyclePills,
      taskRegistry: lifecycleTaskRegistry,
      followUpQueue: lifecycleFollowUpQueue,
    } = deps.buildLifecycleBundle(featureCfg)

    // ADR-0432 — session budget meter for the self-edit memory write-guard.
    // Constructed ONLY when the operator opted in via QUANTA_MEMORY_WRITE_GUARD_PCT
    // (the single activation gate), so the absent-env path constructs NO meter,
    // sets nothing on the config, and is byte-identical to today. The meter has
    // NO dials by itself (so the loop's `checkExhausted` never trips — the CLI's
    // own `maxTurns` remains the sole stop) and serves as the LIVE 0..100
    // `remainingPercent()` source the write-guard reads; the loop's existing
    // tick sites (`config.budgetMeter?.tick(...)`) feed it once it is set on the
    // config in `context-binding.ts`. Without this thread the guard was inert
    // because the surface never supplied a `budgetRemainingPercent` closure.
    const writeGuardActive = runtime.env.QUANTA_MEMORY_WRITE_GUARD_PCT !== undefined
    const budgetMeter = writeGuardActive ? new BudgetMeter() : undefined

    const tooling = deps.buildTooling(
      features.mcpTools,
      features.lspTools,
      features.lspNavTools,
      features.gitToolList,
      slog,
      lifecycleTaskRegistry,
      features.metrics,
      budgetMeter !== undefined ? () => budgetMeter.remainingPercent() : undefined,
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
    // `session_config` tool seam — built ONCE at bootstrap from the same
    // mutable cells the rest of the surface uses (effortStore +
    // identityModeState + toolProfileState), so a `set_effort` via the tool
    // and an operator `/effort` slash mutate the SAME store. The seam is
    // duck-typed (structural mirror of `SessionConfigSeam` declared in
    // `@/tool/types`) so this file stays slice-fenced.
    const sessionConfigPort: SessionBootstrapResult["sessionConfigPort"] = {
      readEffort: () => effortStore.get(),
      writeEffort: (next) => {
        effortStore.set(next)
      },
      readIdentityMode: () => identityModeState.get(),
      readToolProfile: () => toolProfileState.get(),
      readModel: () => runtime.model,
      readProvider: () => runtime.provider,
    }
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
      permissionModeState,
      idleMonitor,
      rejectCounter,
      effortStore,
      llm: finalLLM,
      features,
      tooling,
      budgetMeter,
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
      sessionConfigPort,
      autoTitlePort,
      shutdownMcp,
      // ADR-0301 — present the parsed CLI flag as `true | undefined`. Mapping
      // `false → undefined` lets the downstream consumer spread the slot
      // conditionally (`exactOptionalPropertyTypes`-friendly) and keeps the
      // default-OFF path byte-identical (no `cliFlag: false` reaching the
      // wire — env-on precedence remains the single arbiter).
      playbookCliFlag: runtime.playbookTriggerFlag === true ? true : undefined,
      materializeReviewerAgent: deps.materializeReviewerAgent,
      createSubagentBackedGuardianReview: deps.createSubagentBackedGuardianReview,
      createSubagentBackedGuardianAssess: deps.createSubagentBackedGuardianAssess,
    }
  } catch (error) {
    await stopMcpClients(features.mcpClients)
    throw error
  }
}
