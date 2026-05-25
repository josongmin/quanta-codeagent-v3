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
import type { ImageBlock, LLMPort, Message } from "@/llm"
import { StructuredLogger } from "@/observability"
import type { PermissionContext } from "@/permission"
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

    const identity = deps.pickIdentity()
    const system = buildSystemPrompt(cwd, {
      persona: deps.pickPersona(),
      ...(identity !== undefined ? { identity } : {}),
    })
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
