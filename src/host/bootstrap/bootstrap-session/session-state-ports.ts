/**
 * `@/host/bootstrap/bootstrap-session/session-state-ports` — the env-resolved
 * session-state cells and the system prompt they render.
 *
 * SINGLE RESPONSIBILITY: turn the session's env bag into the MUTABLE per-session
 * cells the surface and the loop share (tool profile, identity mode, focus
 * chain), then compose them into the live `SystemSource` + its rebuild hook.
 * Every knob read here (`QUANTA_TOOL_PROFILE`, `QUANTA_IDENTITY_MODE`,
 * `QUANTA_FOCUS_CHAIN_EVERY`, `QUANTA_IDENTITY`, `QUANTA_ENV_DEFAULT`) is an
 * unknown-value-tolerant resolve: a bad value warns and falls back to the
 * shipped default, never throws.
 *
 * Split out of `bootstrap-session.ts` (god-module cap) — VERBATIM relocation, no
 * behavior delta. One-way edge: `assembleBootstrapResult` imports
 * {@link buildPromptState}; this module imports no sibling stage.
 */

import { type AgentConfig, buildSystemPrompt } from "@/agent"
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
import {
  createIdentityModeSessionState,
  createSystemPromptRebuilder,
  createSystemSource,
  createToolProfileSessionState,
  type IdentityModeSessionState,
  type ToolProfileSessionState,
} from "@/runner/assemble"
import { gateOn, logger } from "@/shared"
import type { SessionBootstrapDeps, SessionRuntimeConfigShape } from "../types"

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

export const buildSessionStatePorts = (args: {
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
  // An identity mode cell is always available to the surface, but only the
  // default-OFF gate authorizes it to replace the current prompt. The CLI
  // supplies initial identity lines when enabled, so their presence is not a
  // valid proxy for whether the live mode transition is authorized.
  const modeDrivenSystemPrompt = gateOn(args.env, "QUANTA_IDENTITY")
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

export const buildPromptState = (
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
