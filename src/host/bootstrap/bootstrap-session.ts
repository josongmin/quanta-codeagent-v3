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

import {
  type AgentConfig,
  type BudgetDials,
  BudgetMeter,
  buildSystemPrompt,
  createBriefStore,
  createEffortStore,
  parseBoolKnob,
  parseEffort,
} from "@/agent"
import { defaultFocusChainTracker, type FocusChainPort } from "@/agent/focus-chain"
import {
  defaultIdentityProvider,
  IDENTITY_MODES,
  type IdentityMode,
  isIdentityMode,
} from "@/agent/identity"
import {
  buildSystemPromptForMode,
  defaultModeVariantRegistry,
  type ModeVariantKey,
  promptSurfaceProfileForRunMode,
  resolveCliDefaultEnvPosture,
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
  createSystemPromptRebuilder,
  createSystemSource,
  createToolProfileSessionState,
  type IdentityModeSessionState,
  type ToolProfileSessionState,
} from "@/runner/assemble"
import { resolveNetworkProxyFromEnv } from "@/runner/knobs/knobs/network-proxy"
import { isPathLikeToken } from "@/runner/orchestrate"
import { openSessionEgressProxy } from "@/runtime/network-proxy"
import { errMessage, gateOn, type Logger, logger, runtimeConfigFromEnv } from "@/shared"
import {
  type BootstrapFeatures,
  type SessionBootstrapDeps,
  SessionBootstrapError,
  type SessionBootstrapFailureKind,
  type SessionBootstrapResult,
  type SessionFeatureConfig,
  type SessionRuntimeConfigShape,
} from "./types"

/** Operator cost-cap dials from env (`QUANTA_MAX_COST_USD` /
 *  `QUANTA_MAX_COST_PER_TURN_USD`): a positive USD amount, fractional allowed,
 *  NO default. An absent/garbage value omits that dial so the meter stays
 *  dial-less (byte-identical). Mirrors the autonomous-mode assembler's override
 *  so the CLI/interactive surface honours the same cost-cap knobs. */
export const parseOperatorCostDials = (env: NodeJS.ProcessEnv): BudgetDials => {
  const pos = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined
    const n = Number.parseFloat(raw.trim())
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const maxCostUsd = pos(env.QUANTA_MAX_COST_USD)
  const maxCostPerTurnUsd = pos(env.QUANTA_MAX_COST_PER_TURN_USD)
  return {
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(maxCostPerTurnUsd !== undefined ? { maxCostPerTurnUsd } : {}),
  }
}

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
  if (!isIdentityMode(mode)) {
    logger.warn(`QUANTA_IDENTITY_MODE='${mode}' unknown; valid: ${IDENTITY_MODES.join(", ")}`)
    return createIdentityModeSessionState({
      registry: defaultModeVariantRegistry(),
      defaultMode: DEFAULT_IDENTITY_MODE,
    })
  }
  return createIdentityModeSessionState({
    registry: defaultModeVariantRegistry(),
    defaultMode: DEFAULT_IDENTITY_MODE,
    initialMode: mode,
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
  // jul-9 QUANTA_ENV_DEFAULT knob (default-OFF ⇒ "frozen", byte-identical). This is THE
  // interactive-CLL prompt seam (`quanta` REPL), distinct from the agent-arg-builder path —
  // it MUST honor the knob too or a developer who sets it still gets the frozen (SWE) posture.
  const envPosture = resolveCliDefaultEnvPosture(args.env)
  const buildPromptFromIdentityMode = (mode: IdentityMode | undefined, cwd: string): string => {
    if (mode === "onboarding") {
      return buildSystemPrompt(cwd, {
        persona: args.persona,
        identity: defaultIdentityProvider().identityFor(mode),
        envPosture,
      })
    }
    return buildSystemPromptForMode({
      mode: mode ?? identityModeState.getPromptMode(),
      registry: identityModeState.registry,
      persona: args.persona,
      envPosture,
    })
  }
  const rebuilder = createSystemPromptRebuilder({
    mode: () => identityModeState.get(),
    cwd: args.cwd,
    baseBuilder: buildPromptFromIdentityMode,
  })
  // An identity mode cell is always available to the surface, but it may not
  // own the current prompt. Preserve the original system prompt unless the
  // default-OFF identity gate selected the mode-driven source at bootstrap.
  const modeDrivenSystemPrompt = args.identity === undefined && gateOn(args.env, "QUANTA_IDENTITY")
  const systemSource = createSystemSource(
    modeDrivenSystemPrompt
      ? rebuilder.rebuild()
      : buildSystemPrompt(args.cwd, {
          persona: args.persona,
          envPosture,
          ...(args.identity !== undefined ? { identity: args.identity } : {}),
        }),
  )
  const refreshSystemPrompt = (): void => {
    if (!modeDrivenSystemPrompt) return
    systemSource.set(rebuilder.rebuild())
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
  readonly promptSurfaceProfile: AgentConfig["promptSurfaceProfile"]
  readonly systemSource: ReturnType<typeof createSystemSource>
  readonly refreshSystemPrompt: () => void
  readonly toolProfileState: ToolProfileSessionState
  readonly identityModeState: IdentityModeSessionState
  readonly focusChain: { readonly tracker: FocusChainPort; readonly reinjectEveryN: number }
} => {
  const persona = deps.pickPersona()
  const identity = deps.pickIdentity()
  // Mirror the SAME envPosture seam `buildSessionStatePorts` uses for the rendered
  // system prompt (resolveCliDefaultEnvPosture over the same runtime.env), so the
  // surface-profile TELEMETRY agrees with the prompt TEXT. Previously this dropped
  // to the "frozen" default, mis-reporting posture whenever QUANTA_ENV_DEFAULT=1
  // rendered a "default" prompt (the jul-04 envPosture-drop foot-gun class).
  const envPosture = resolveCliDefaultEnvPosture(runtime.env)
  const { toolProfileState, identityModeState, focusChain, systemSource, refreshSystemPrompt } =
    buildSessionStatePorts({
      cwd,
      env: runtime.env,
      persona,
      identity,
    })
  return {
    system: systemSource.get(),
    promptSurfaceProfile: promptSurfaceProfileForRunMode("interactive", { envPosture }),
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
    // Keep the host's injected env path on the same strict parser as
    // `runtimeConfig()`.  `runCapabilityProbe` retains its own early return as
    // defense in depth for direct callers.
    if (!runtimeConfigFromEnv(env).capabilityLayer) return
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

/**
 * jun-10 — gate the legacy stderr startup lines on whether the interactive
 * welcome banner (repl.ts) will paint. The banner is the surface's first frame
 * and already shows provider/model/mode/cwd/session, so when it renders the
 * three legacy lines ("[info] quanta ready", "[info] session: <id>", and the
 * structured `session.id_mode.on` JSONL) are pure duplication noise above the
 * box. The banner renders on exactly this condition: no positional prompt +
 * stderr is a TTY. Return `undefined` (⇒ a no-op `?.info`, suppressing the
 * human lines) in that case; otherwise the live `logger` (pipe / one-shot /
 * CI — the banner never shows there, so the lines remain the ONLY ready
 * signal, byte-identical). Finishes the migration the welcome-banner docblock
 * describes ("Replaces the bare `[info] quanta ready` + JSONL config dumps").
 */
const inInteractiveBanner = (runtime: SessionRuntimeConfigShape): boolean =>
  runtime.argPrompt === undefined && runtime.stderrIsTTY === true

const startupReadyLogger = (runtime: SessionRuntimeConfigShape): Logger | undefined =>
  inInteractiveBanner(runtime) ? undefined : logger

/** Floor for the session's structured (JSONL) logger. The same feature-on
 *  startup events (`lsp.nav.on`, `lsp.diagnostics.on`, `mcp.tools.loaded`, …)
 *  that the human lines duplicate are also emitted as `slog.info` JSONL, and in
 *  the interactive surface they spray raw JSON above the welcome box (stderr is
 *  the same TTY the banner paints to). When the banner renders AND the user has
 *  not explicitly pinned `QUANTA_LOG_LEVEL`, raise the floor to `warn` so those
 *  info events fall silent while real warn/error JSONL still surfaces. An
 *  explicit level (incl. `debug` for troubleshooting) is honored verbatim, and
 *  pipe / one-shot / CI (no banner) stay byte-identical (`undefined` ⇒ live
 *  `runtimeConfig().logLevel`). */
const interactiveStructuredLogLevel = (runtime: SessionRuntimeConfigShape): "warn" | undefined =>
  inInteractiveBanner(runtime) && runtime.env.QUANTA_LOG_LEVEL === undefined ? "warn" : undefined

/** Emit a human startup line through the gated logger — a no-op when the
 *  welcome banner renders (`log` is then `undefined`). Wrapping the `?.` here
 *  keeps it out of `bootstrapSession`'s body so its cognitive complexity stays
 *  at the pre-jun-10 baseline. */
const emitStartupLine = (log: Logger | undefined, msg: string): void => {
  log?.info(msg)
}

/** The terminal-agnostic prerequisites the bootstrap assembles BEFORE the
 *  feature/tooling wiring: the structured logger, idle guards, mutable
 *  permission posture, session abort controller, effort/brief stores, the main
 *  LLM stack, the AI titler, the session egress proxy, and the loaded feature
 *  bundle. Order is load-bearing (proxy opens BEFORE `loadFeatures` spawns MCP
 *  children); the helper preserves it verbatim. */
interface PreparedSessionRuntime {
  readonly slog: StructuredLogger
  readonly idleMonitor: ReturnType<SessionBootstrapDeps["buildIdleGuards"]>["idleMonitor"]
  readonly rejectCounter: ReturnType<SessionBootstrapDeps["buildIdleGuards"]>["rejectCounter"]
  readonly permission: PermissionContext
  readonly permissionModeState: ReturnType<typeof createPermissionModeSessionState>
  readonly abort: AbortController
  readonly effortStore: ReturnType<typeof createEffortStore>
  readonly briefStore: ReturnType<typeof createBriefStore>
  readonly finalLLM: LLMPort
  readonly autoTitlePort: ReturnType<SessionBootstrapDeps["buildAutoTitlePort"]>
  readonly sessionProxy: Awaited<ReturnType<typeof openSessionEgressProxy>>
  readonly features: BootstrapFeatures
}

/** Build {@link PreparedSessionRuntime} — the verbatim pre-feature prologue of
 *  `bootstrapSession`. An LLM build failure short-circuits via
 *  {@link failSessionBootstrap} (a `never` throw); a `loadFeatures` failure
 *  closes the freshly-bound egress proxy before re-throwing so no listening
 *  port leaks. Order and conditional logs are byte-identical to the prior
 *  inline body. */
const prepareSessionRuntime = async (
  deps: SessionBootstrapDeps,
  runtime: SessionRuntimeConfigShape,
): Promise<PreparedSessionRuntime> => {
  const interactiveLevel = interactiveStructuredLogLevel(runtime)
  const slog = new StructuredLogger(
    interactiveLevel !== undefined ? { level: interactiveLevel } : {},
  )
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
  // #17 (C3) — seed the brief-mode store from `QUANTA_BRIEF` (default-OFF). The
  // `/brief` slash + a `set_brief` control-op mutate the SAME cell; the loop
  // reads it per turn via `AgentConfig.sessionBrief`.
  const briefStore = createBriefStore(parseBoolKnob(runtime.env.QUANTA_BRIEF))
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

  // H3 (jun-10 session-scoped egress) — open the SESSION-SCOPED egress proxy
  // BEFORE `loadFeatures` spawns the MCP stdio servers, so the proxy's stable
  // address is fixed into every server child's env at spawn time. This is the
  // ARCHITECTURAL fix for the bypass: the per-turn `withEgressProxy` (bound
  // INSIDE `runAgent`, fresh ephemeral port each turn, closed on turn return)
  // cannot gate a process-lifetime MCP child spawned here, before any turn. We
  // resolve the config from `runtime.env` (the SAME `resolveNetworkProxyFromEnv`
  // the per-turn `AgentConfig.networkProxy` slot uses, so the bytes match) and
  // bind ONCE. DEFAULT-OFF: `QUANTA_NETWORK_PROXY` absent ⇒ `undefined` ⇒
  // `openSessionEgressProxy` binds NO socket, returns `proxyEnv = {}` (no proxy
  // keys reach the child) + a no-op `close()` ⇒ byte-identical to today.
  const networkProxy = resolveNetworkProxyFromEnv(runtime.env)
  const sessionProxy = await openSessionEgressProxy(networkProxy)
  // B1 (jun-04) — thread the freshly-built LLM so an inbound MCP
  // `sampling/createMessage` can be fulfilled by the loaded clients (the surface
  // gates advertisement on its knobs + consent; passing the LLM here is what
  // makes the wiring possible at all).
  let features: BootstrapFeatures
  try {
    features = await deps.loadFeatures(slog, finalLLM, sessionProxy.proxyEnv)
  } catch (e) {
    // The proxy socket was bound BEFORE the MCP spawn that just failed; release
    // it so a failed load never leaks the listening port (mirrors the MCP-client
    // cleanup the catch below performs once `features` exists).
    await sessionProxy.close()
    throw e
  }
  return {
    slog,
    idleMonitor,
    rejectCounter,
    permission,
    permissionModeState,
    abort,
    effortStore,
    briefStore,
    finalLLM,
    autoTitlePort,
    sessionProxy,
    features,
  }
}

/** Wire the loaded features into the full {@link SessionBootstrapResult}:
 *  lifecycle bundle, budget meter, tooling, MCP surface/pills, streaming,
 *  seed images, startup logs, resume resolution, prompt state, session config
 *  port, and the MCP shutdown hook. This is the verbatim body of the inner
 *  `try` block; the caller wraps it in the MCP/proxy-cleanup `catch`. */
/** Emit the gated startup lines, run the resume FSM, and switch to the resumed
 *  session's cwd. Returns the resolved `{ cwd, idMeta, history, sessionId }`.
 *  Verbatim relocation of the inline resume cluster — same conditional logs,
 *  same `failSessionBootstrap` short-circuits, same cwd-switch order. */
const resolveSessionResume = async (
  deps: SessionBootstrapDeps,
  runtime: SessionRuntimeConfigShape,
  slog: StructuredLogger,
  features: BootstrapFeatures,
  initialSessionId: string,
): Promise<{
  readonly cwd: string
  readonly idMeta: Awaited<ReturnType<SessionBootstrapDeps["resolveResume"]>>["idMeta"]
  readonly history: Message[]
  readonly sessionId: string
}> => {
  let cwd = runtime.cwd
  // `startupLog` is `undefined` when the welcome banner will render (see
  // `startupReadyLogger`), so the `?.info` below no-ops the redundant
  // "quanta ready" / "session:" lines; `quietIdModeLog` likewise suppresses
  // the structured `session.id_mode.on` echo. Non-interactive ⇒ live logger.
  const startupLog = startupReadyLogger(runtime)
  const inIdModeAtStart =
    runtime.newSession || (features.resume !== undefined && !isPathLikeToken(features.resume))
  if (!inIdModeAtStart) {
    emitStartupLine(
      startupLog,
      `quanta ready (provider=${runtime.provider}, model=${runtime.model}, mode=${runtime.mode}, cwd=${cwd})`,
    )
  }
  const resolved = await deps.resolveResume({
    resume: features.resume,
    newSession: runtime.newSession,
    title: runtime.title,
    cwd,
    initialSessionId,
    slog,
    quietIdModeLog: startupLog === undefined,
    onSessionMinted: (id) => emitStartupLine(startupLog, `session: ${id}`),
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
    emitStartupLine(
      startupLog,
      `quanta ready (provider=${runtime.provider}, model=${runtime.model}, mode=${runtime.mode}, cwd=${cwd}, session=${idMeta.id})`,
    )
  }
  return { cwd, idMeta, history, sessionId }
}

/** Build the lifecycle bundle, optional budget meter, per-run tooling registry,
 *  and MCP surface descriptor; wire MCP pills when servers are present. Verbatim
 *  relocation of the inline lifecycle/tooling/MCP cluster — same construction
 *  order and the same `lifecyclePills.update` mutation. */
const buildToolingBundle = (
  deps: SessionBootstrapDeps,
  runtime: SessionRuntimeConfigShape,
  featureCfg: SessionFeatureConfig,
  slog: StructuredLogger,
  features: BootstrapFeatures,
): {
  readonly lifecyclePills: ReturnType<SessionBootstrapDeps["buildLifecycleBundle"]>["pills"]
  readonly lifecycleTaskRegistry: ReturnType<
    SessionBootstrapDeps["buildLifecycleBundle"]
  >["taskRegistry"]
  readonly lifecycleFollowUpQueue: ReturnType<
    SessionBootstrapDeps["buildLifecycleBundle"]
  >["followUpQueue"]
  readonly lifecycleActivityStore: ReturnType<
    SessionBootstrapDeps["buildLifecycleBundle"]
  >["activityStore"]
  readonly budgetMeter: BudgetMeter | undefined
  readonly tooling: ReturnType<SessionBootstrapDeps["buildTooling"]>
  readonly mcpSurface: ReturnType<SessionBootstrapDeps["buildMcpSurfaceInfo"]>
} => {
  const {
    pills: lifecyclePills,
    taskRegistry: lifecycleTaskRegistry,
    followUpQueue: lifecycleFollowUpQueue,
    activityStore: lifecycleActivityStore,
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
  // Operator cost cap on the interactive/CLI session. This surface is otherwise
  // human-paced (no preset cost dial — see the autonomous-mode assembler for
  // those); `QUANTA_MAX_COST_USD` / `QUANTA_MAX_COST_PER_TURN_USD` let a human
  // pin a dollar ceiling so a long REPL session stops itself. Positive USD, NO
  // default ⇒ absent leaves the meter dial-less (byte-identical: `maxTurns` /
  // the write-guard stay the only stops). When set, the meter carries the cost
  // dials so the loop's `checkExhausted` trips on overrun.
  const costDials = parseOperatorCostDials(runtime.env)
  const hasCostCap = Object.keys(costDials).length > 0
  const budgetMeter =
    writeGuardActive || hasCostCap ? new BudgetMeter({ dials: costDials }) : undefined

  const tooling = deps.buildTooling(
    features.mcpTools,
    features.lspTools,
    features.lspNavTools,
    features.gitToolList,
    features.astGrepTools,
    slog,
    lifecycleTaskRegistry,
    features.metrics,
    budgetMeter !== undefined ? () => budgetMeter.remainingPercent() : undefined,
    lifecycleActivityStore,
    // jul-03 B3 — the REAL provider rate-limit window closure, SEPARATE from the
    // local cost fraction above. Reads the SAME session meter, whose provider tap
    // the loop feeds from `x-ratelimit-*` response headers. Absent meter ⇒ the
    // provider arm stays unarmed (byte-identical).
    budgetMeter !== undefined ? () => budgetMeter.providerRateLimitRemainingPercent() : undefined,
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
  return {
    lifecyclePills,
    lifecycleTaskRegistry,
    lifecycleFollowUpQueue,
    lifecycleActivityStore,
    budgetMeter,
    tooling,
    mcpSurface,
  }
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
    permissionModeState,
    abort,
    effortStore,
    briefStore,
    finalLLM,
    autoTitlePort,
    sessionProxy,
    features,
  } = prepared
  {
    const {
      lifecyclePills,
      lifecycleTaskRegistry,
      lifecycleFollowUpQueue,
      lifecycleActivityStore,
      budgetMeter,
      tooling,
      mcpSurface,
    } = buildToolingBundle(deps, runtime, featureCfg, slog, features)

    const { stream, run } = deps.buildStreaming(runtime.observeDir, slog)
    const pendingImages = loadSeedImages(runtime, deps.loadImageBlock)

    const { cwd, idMeta, history, sessionId } = await resolveSessionResume(
      deps,
      runtime,
      slog,
      features,
      tooling.sessionId,
    )

    const {
      system,
      promptSurfaceProfile,
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
    // permissionModeState + identityModeState + toolProfileState), so a
    // `set_effort` via the tool and an operator `/effort` slash mutate the
    // SAME store while the authority-bearing posture cells remain visible
    // read-only. The seam is duck-typed (structural mirror of
    // `SessionConfigSeam` declared in `@/tool/types`) so this file stays
    // slice-fenced.
    const sessionConfigPort: SessionBootstrapResult["sessionConfigPort"] = {
      readEffort: () => effortStore.get(),
      writeEffort: (next) => {
        effortStore.set(next)
      },
      readPermissionMode: () => permissionModeState.get(),
      readIdentityMode: () => identityModeState.get(),
      readToolProfile: () => toolProfileState.get(),
      readModel: () => runtime.model,
      readProvider: () => runtime.provider,
    }
    const shutdownMcp = async (): Promise<void> => {
      await stopMcpClients(features.mcpClients)
      // H3 (jun-10) — close the session egress proxy on the SAME teardown hook
      // that stops the MCP clients: the proxy exists ONLY to gate those clients'
      // children, so its lifetime is exactly the MCP fleet's. No-op when the proxy
      // is OFF (byte-identical). Closing AFTER the clients stop avoids tearing the
      // socket out from under an in-flight child shutdown.
      await sessionProxy.close()
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
