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
 *
 * THIS module is now ONLY the ORCHESTRATOR: it owns the two-phase shape
 * (prologue → assemble, with the MCP/proxy cleanup rethrow around the second
 * phase) and the projection of the assembled parts onto
 * {@link SessionBootstrapResult}. Each phase's substance lives in a cohesive
 * sibling under `./bootstrap-session/`, each named for its single
 * responsibility (the god-module split — the dependency edge is ONE-WAY, this
 * file imports them and none imports back):
 *
 *   - `./bootstrap-session/bootstrap-fault`        — the typed abort + MCP-fleet
 *                                                    teardown pair every stage shares.
 *   - `./bootstrap-session/capability-probe`       — ADR-0503 P3 read-only exposure
 *                                                    drift sweep (gated, observe-only).
 *   - `./bootstrap-session/startup-announcement`   — banner-aware startup lines +
 *                                                    the resume FSM that emits them.
 *   - `./bootstrap-session/prepare-runtime`        — the PROLOGUE: logger, posture,
 *                                                    LLM, egress proxy, feature load.
 *   - `./bootstrap-session/session-state-ports`    — env-resolved session-state cells
 *                                                    + the system-prompt source.
 *   - `./bootstrap-session/tooling-bundle`         — lifecycle bundle, budget meter,
 *                                                    tool registry, MCP surface/reload.
 *
 * The public surface is UNCHANGED — every export this module ever had is still
 * exported here (re-exported where the declaration moved), so no importer of
 * `@/host/bootstrap/bootstrap-session` moves a line.
 */

import type { createEffortStore } from "@/agent"
import {
  bindRouteSinkToStream,
  buildRouteEventForwarder,
} from "@/host/bootstrap/route-event-forwarder"
import type { ImageBlock } from "@/llm"
import type { IdentityModeSessionState, ToolProfileSessionState } from "@/runner/assemble"
import type { PermissionModeSessionState } from "@/runner/assemble/session-authorities"
import { errMessage } from "@/shared"
import { failSessionBootstrap, stopMcpClients } from "./bootstrap-session/bootstrap-fault"
import {
  type PreparedSessionRuntime,
  prepareSessionRuntime,
} from "./bootstrap-session/prepare-runtime"
import {
  buildPromptState,
  resolveBootstrapRepoRules,
} from "./bootstrap-session/session-state-ports"
import { resolveSessionResume } from "./bootstrap-session/startup-announcement"
import { buildToolingBundle, parseOperatorCostDials } from "./bootstrap-session/tooling-bundle"
import { resolveDurableLivePosture } from "./live-posture-runtime"
import type {
  BootstrapFeatures,
  SessionBootstrapDeps,
  SessionBootstrapResult,
  SessionFeatureConfig,
  SessionRuntimeConfigShape,
} from "./types"

// Declarations that MOVED to a sibling module for the god-module split, kept on
// THIS module's public surface so no import site changes:
//   - `buildRouteEventForwarder` (RFC02-3 A8) → `./route-event-forwarder`, the
//     route-event forwarder cluster.
//   - `parseOperatorCostDials` → `./bootstrap-session/tooling-bundle`, next to
//     the budget meter that is its only consumer.
export { buildRouteEventForwarder, parseOperatorCostDials }

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

/** `session_config` tool seam — built ONCE from the same mutable cells the
 *  surface uses, so a `set_effort` tool-op and an operator `/effort` slash mutate
 *  the SAME store while authority-bearing posture cells stay read-only. Duck-typed
 *  (mirror of `SessionConfigSeam` in `@/tool/types`) to keep the file slice-fenced.
 *  Extracted from `assembleBootstrapResult` (SRP + god-fn budget); closures capture
 *  the SAME live cells ⇒ byte-identical. */
const buildSessionConfigPort = (cells: {
  readonly effortStore: ReturnType<typeof createEffortStore>
  readonly permissionModeState: PermissionModeSessionState
  readonly identityModeState: IdentityModeSessionState
  readonly toolProfileState: ToolProfileSessionState
  readonly model: string
  readonly provider: SessionRuntimeConfigShape["provider"]
}): SessionBootstrapResult["sessionConfigPort"] => ({
  readEffort: () => cells.effortStore.get(),
  writeEffort: (next) => {
    cells.effortStore.set(next)
  },
  readPermissionMode: () => cells.permissionModeState.get(),
  readIdentityMode: () => cells.identityModeState.get(),
  readToolProfile: () => cells.toolProfileState.get(),
  readModel: () => cells.model,
  readProvider: () => cells.provider,
})

/** Wire the loaded features into the full {@link SessionBootstrapResult}:
 *  lifecycle bundle, budget meter, tooling, MCP surface/pills, streaming,
 *  seed images, startup logs, resume resolution, prompt state, session config
 *  port, and the MCP shutdown hook. This is the verbatim body of the inner
 *  `try` block; the caller wraps it in the MCP/proxy-cleanup `catch`. */
/** Session teardown: stop the MCP fleet, THEN close the session egress proxy on
 *  the SAME hook (the proxy exists ONLY to gate those clients' children, so its
 *  lifetime is exactly the MCP fleet's — no-op when the proxy is OFF, byte-identical;
 *  closing AFTER the clients stop avoids tearing the socket out from under an
 *  in-flight child shutdown). Extracted so `assembleBootstrapResult` stays under the
 *  god-function line cap. */
const buildShutdownMcp = async (
  features: BootstrapFeatures,
  sessionProxy: PreparedSessionRuntime["sessionProxy"],
): Promise<void> => {
  await stopMcpClients(features.mcpClients)
  await sessionProxy.close()
}

const assembleBootstrapResult = async (
  deps: SessionBootstrapDeps,
  runtime: SessionRuntimeConfigShape,
  featureCfg: SessionFeatureConfig,
  prepared: PreparedSessionRuntime,
): Promise<SessionBootstrapResult> => {
  const {
    slog,
    idleMonitor,
    rejectCounter,
    permission,
    bindLivePosture,
    abort,
    effortStore,
    briefStore,
    finalLLM,
    autoTitlePort,
    sessionProxy,
    features,
    bindRouteEventTarget,
    routeEventSink,
  } = prepared
  {
    const {
      lifecyclePills,
      lifecycleTaskRegistry,
      lifecycleFollowUpQueue,
      lifecycleActivityStore,
      lifecycleQuestionBroker,
      lifecycleAttention,
      budgetMeter,
      tooling,
      mcpSurface,
      registrySnapshotRef,
    } = buildToolingBundle(deps, runtime, featureCfg, slog, features)

    const { stream, run } = deps.buildStreaming(runtime.observeDir, slog)
    // RFC02-3 (A8) — bind the route sink forwarder to the now-live stream (no-op
    // when the gate is OFF ⇒ `bindRouteEventTarget` is undefined, byte-identical).
    bindRouteSinkToStream(bindRouteEventTarget, stream)
    const pendingImages = loadSeedImages(runtime, deps.loadImageBlock)

    const resume = await resolveSessionResume(deps, runtime, slog, features, tooling.sessionId)
    const { cwd, idMeta, history, sessionId } = resume
    // RFC-05 E3 (durable resume) — bind the ONE authority now the session id resolved.
    const { permissionModeState, postureControl, questionGuard } = await resolveDurableLivePosture({
      bind: bindLivePosture,
      loadPermissionStore: deps.loadPermissionStore,
      env: runtime.env,
      sessionId,
    })

    const {
      system,
      promptSurfaceProfile,
      systemSource,
      refreshSystemPrompt,
      toolProfileState,
      identityModeState,
      focusChain,
    } = buildPromptState(deps, runtime, cwd)
    // F1a — the ONE repo-rules authority for this session. Resolved here, at the
    // shipping CLI's own composition root, so the per-turn AgentConfig and the
    // `/rules` indicator consume the SAME snapshot instead of reading disk twice.
    const repoRules = await resolveBootstrapRepoRules(cwd)
    const onShellEvent = deps.composeShellEvent(features.metrics, runtime.stdoutIsTTY)
    const workMetricsSink = deps.buildWorkMetricsSink(features.metrics !== undefined)
    const costPanel = deps.buildCostPanelOrUndefined(featureCfg, runtime.model)
    const branchProgress = deps.buildBranchProgressOrUndefined(featureCfg)
    const planStore = deps.buildPlanStoreOrUndefined(featureCfg)
    const sessionConfigPort = buildSessionConfigPort({
      effortStore,
      permissionModeState,
      identityModeState,
      toolProfileState,
      model: runtime.model,
      provider: runtime.provider,
    })
    const shutdownMcp = (): Promise<void> => buildShutdownMcp(features, sessionProxy)

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
      postureControl, // RFC-05 E4 (→ base.postureControl)
      questionGuard, // RFC-05 E5 (→ AgentConfig.questionGuard)
      idleMonitor,
      rejectCounter,
      effortStore,
      briefStore,
      llm: finalLLM,
      features,
      tooling,
      budgetMeter,
      mcpSurface,
      lifecyclePills,
      lifecycleTaskRegistry,
      lifecycleActivityStore,
      lifecycleFollowUpQueue,
      // RFC-01 A4 — carry the pending-question authority + attention reader onto
      // the bootstrap result so the runtime overlay wires `config.questionBroker`
      // and the `/attention` slash surface reads the SAME instances. Undefined
      // when `QUANTA_ATTENTION_NAV` is off (byte-identical).
      ...(lifecycleQuestionBroker !== undefined ? { lifecycleQuestionBroker } : {}),
      ...(lifecycleAttention !== undefined ? { lifecycleAttention } : {}),
      sessionId,
      history,
      pendingImages,
      idMeta,
      // RFC-03 C2 — reopened objective snapshot (id-mode resume); absent ⇒ fresh authority.
      ...(resume.objective !== undefined ? { restoredObjective: resume.objective } : {}),
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
      ...(repoRules !== undefined ? { repoRules } : {}),
      promptSurfaceProfile,
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
      // RFC04-2/3 (hot-reload) — carry the snapshot ref (present iff the feeder
      // was built). Spread conditionally so the default-OFF path never puts a
      // literal `undefined` on the result (exactOptionalPropertyTypes).
      ...(registrySnapshotRef !== undefined ? { registrySnapshotRef } : {}),
      // RFC02-3 (A8, feeder) — expose the gated forwarder sink for the retry +
      // scheduler reroute attach sites (conditional spread ⇒ OFF byte-identical).
      ...(routeEventSink !== undefined ? { routeEventSink } : {}),
    }
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
  const prepared = await prepareSessionRuntime(deps, runtime)
  try {
    return await assembleBootstrapResult(deps, runtime, featureCfg, prepared)
  } catch (error) {
    await stopMcpClients(prepared.features.mcpClients)
    // H3 (jun-10) — a failure AFTER the MCP fleet started must also release the
    // session egress proxy bound above (no-op when OFF) so no listening port leaks.
    await prepared.sessionProxy.close()
    throw error
  }
}
