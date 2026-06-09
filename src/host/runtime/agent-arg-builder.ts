/**
 * `host/runtime/agent-arg-builder.ts` — RFC may-22-unified-agent-runtime / Phase 4.
 *
 * ADR-0303 thin-surface relocation: the env-READING "argv → AgentConfig base"
 * composition builder moved DOWN out of `apps/agent/index.ts` into the
 * `@/host/runtime` composition layer so every surface — the unified-agent
 * launcher (`apps/agent`) AND `apps/cli`'s `batch` subcommand — reaches DOWN
 * into `@/host` for it, never sideways into a sibling surface. `apps/agent/
 * index.ts` now imports + re-exports these symbols.
 *
 * This is the ENV-READING composition builder: it reads `process.env` /
 * `process.cwd()` and may `process.exit(2)` on a missing API key. That is
 * legal here (composition-root layer, mirroring `apps/agent/index.ts`'s old
 * posture) — but it is DISTINCT from the env-PURE `agent-config-assembler.ts`
 * sitting next to it, which NEVER touches the `process.env` global (each
 * surface threads a plain `EnvLike` view into it). Keep env reads HERE and
 * out of `agent-config-assembler.ts` so that file's "never touches
 * process.env" invariant stays true.
 */

import { join as joinPath } from "node:path"
import { buildSystemPrompt, HookBus, reflectConsultFromLLM, wireOptionalAgentPorts } from "@/agent"
import {
  type CommandHookBinding,
  type CommandHookConfig,
  createSandboxCommandHookExec,
  installCommandHooks,
  normalizeCommandHookGate,
} from "@/agent/command-hooks"
import { defaultDelegationRunner } from "@/agent/delegation-runner"
import { defaultFocusChainTracker, type FocusChainPort } from "@/agent/focus-chain"
import type { ForkSessionPort } from "@/agent/fork-session"
import { defaultCheckpointBaseWire } from "@/agent/fork-session-wire"
import { defaultIdentityProvider, type IdentityMode } from "@/agent/identity"
import {
  type ObservabilityHookBus,
  type ObservabilityWireHandle,
  wireObservability,
} from "@/agent/observability-wire"
import { fsBackedStickyModelStore, type StickyModelStore } from "@/agent/sticky-model"
import { createSubagentRunner } from "@/agent/subagent-runner"
import {
  AGENT_MODES,
  type AgentMode as DelegationAgentMode,
  type DelegationPort,
  lookupModeProfile,
  wrapSubagentRunner,
} from "@/agent/subagent-typed"
import {
  buildSystemPromptForMode,
  defaultModeVariantRegistry,
  type SystemPromptVariantRegistry,
} from "@/agent/system-prompt"
import {
  defaultToolProfileResolver,
  type ToolProfileName,
  type ToolProfileResolver,
} from "@/agent/tool-profile"
import { createArtifactRegistry, monotonicIdFactory } from "@/artifact"
import type { AgentArgs, IdentityModeToken, ToolProfileToken } from "@/host/runtime/agent-args"
import type { AssembleRequest } from "@/host/runtime/agent-config-assembler"
import { type LLMPort, pickProvider, tryCreateLLM } from "@/llm"
import { type CapabilityNegotiator, defaultNegotiator, fullNegotiator } from "@/mcp"
import {
  buildAutorunEligibility,
  buildDefinition,
  createTwoLayerManager,
  isNamedProfileName,
  type MergeStrategy,
  mergeProfileLayers,
  NAMED_PROFILE_NAMES,
  PatternGrantStore,
  type PermissionMode,
  type PermissionProfile,
  type ProfileDefinition,
  type ProfileDefinitionRegistry,
  type ProfileLayerSlots,
  ProfileValidationError,
  permissionModeFromProfile,
  recordProposedPattern,
  resolveProfileByName,
  resolveProfileInheritance,
  type TwoLayerManager,
} from "@/permission"
import {
  buildRetrievalStackCore,
  buildSearchPipelineFromEnv,
  parseEnvFlag,
  type RetrievalStack,
  wireInteractiveKnobs,
} from "@/runner/assemble"
import type { Surface } from "@/runner/knobs"
import { resolveNetworkProxyFromEnv } from "@/runner/knobs/knobs/network-proxy"
import {
  type LocalEnvSelection,
  loadLocalEnvConfig,
  resolveSandboxProfileFromEnv,
  selectEnvironment,
} from "@/runtime"
import { type AutomationEngineSlot, assembleAutomation } from "@/scheduler/runtime-wire"
import { errMessage, gateOn, logger, type PtyBackend, runtimeConfig } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import {
  type AppshotPort,
  buildDefaultTools,
  createFileHistorySink,
  createFileHistoryStore,
  createTmuxAdapter,
  type DefaultToolPorts,
  type FileHistorySink,
  type FileHistoryStore,
  openAiImagePort,
  pollDeferredTool,
  type TmuxExec,
  type Tool,
  ToolRegistry,
} from "@/tool"
import { DefaultDeferredResultRegistry } from "@/tool/deferred/default-registry"
import { buildMcpConnectorDiscoveryPort } from "./mcp-connector-wire"
import { buildPtyBackend } from "./pty-backend"
import { sipsImageDownsamplePort } from "./sips-image-downsample"

/** Hermetic test seams for the composition root (mirrors the H7 `seams?`
 *  precedent on {@link AssembleRequest}). Absent ⇒ every wire uses its REAL
 *  composition-layer backend, so a caller that passes no seams (production +
 *  every existing test) gets a byte-identical `AgentConfig.base`. The shape is
 *  presence-only; the builders only ever consult a field when its gate is ALSO
 *  on, so an injected seam can never WIDEN the tool menu past what the knob
 *  already enabled — it only swaps the leaf effect (e.g. the `tmux` subprocess)
 *  for a deterministic fake. */
export interface CompositionSeams {
  /** N6 — replace the real `tmux` subprocess runner ({@link bunTmuxExec}) at the
   *  LEAF of the pty backend. Consulted ONLY when `QUANTA_PTY_ATTACH=1` already
   *  registered the 6 `pty_*` tools; the SAME production `createTmuxAdapter`
   *  (allow-prefix jail + `--` flag-injection guard) wraps it, so an e2e drives
   *  the entire composition + dispatch + permission path against a fake tmux. */
  ptyExec?: TmuxExec
  /** G1 — inject a complete {@link AppshotPort} (scaffold/render/screenshot/
   *  verify) at the appshot slot. Consulted ONLY when `QUANTA_APPSHOT=1` already
   *  gated the tool. In production the real port (BrowserPort render/screenshot +
   *  LLM-judge verify) is assembled in `agent-config-assembler` (where the
   *  BrowserPort actually lives); at THIS pre-assembler layer no BrowserPort is
   *  reachable, so the slot is minted ONLY when a host/e2e injects the port here.
   *  This drives the REAL `buildGatedToolPorts` registration + dispatch path
   *  against a deterministic fake — no Chrome, no network. */
  appshotPort?: AppshotPort
}

/** ADR-0303 — thrown by {@link buildBaseFromArgs} when no API key resolves for
 *  the selected provider. The host launcher composition layer must NOT own
 *  `process.exit` (terminal-defaults invariant); it throws this typed error and
 *  the surface entry maps `exitCode` onto its own exit. `exitCode = 2` preserves
 *  the prior POSIX behavior (missing-credentials). */
export class ProviderKeyMissingError extends Error {
  readonly exitCode = 2
  constructor(message: string) {
    super(message)
    this.name = "ProviderKeyMissingError"
  }
}

const resolveIdentityFromEnv = (env: NodeJS.ProcessEnv): readonly string[] | undefined => {
  if (!gateOn(env, "QUANTA_IDENTITY")) return undefined
  const raw = env.QUANTA_IDENTITY_MODE ?? "default"
  return defaultIdentityProvider().identityFor(raw as IdentityMode)
}

/** Layered-profile merge strategy from the `policy-merge` knob. ABSENT / typo /
 *  empty ⇒ `"source-precedence"` — the pre-existing precedence (most-
 *  authoritative present source wins each field). Selecting it preserves
 *  current behavior byte-identically; `"most-restrictive"` is the only
 *  behavior-changing value. */
export const resolvePolicyMergeStrategy = (env: NodeJS.ProcessEnv): MergeStrategy =>
  env.QUANTA_POLICY_MERGE_STRATEGY === "most-restrictive" ? "most-restrictive" : "source-precedence"

/** Resolve the optional layered named-profile slots from the composition-root
 *  env view: `QUANTA_PERMISSION_PROFILE_PER_USER` / `_PER_REPO` / `_TEAM_ADMIN`.
 *  Each is an OPTIONAL named-profile token resolved through the same fail-closed
 *  registry as `QUANTA_PERMISSION_PROFILE` (a typo / `custom` THROWS). Returns
 *  `undefined` when NO layered var is set ⇒ the caller falls back to the legacy
 *  single-profile GAP2 wire (byte-identical). */
export const resolveLayeredProfileSlots = (
  env: NodeJS.ProcessEnv,
): ProfileLayerSlots | undefined => {
  const slotFor = (raw: string | undefined): PermissionProfile | undefined => {
    if (raw === undefined || raw === "") return undefined
    // FAIL-CLOSED — same posture as the single-profile resolver.
    return resolveProfileByName(raw)
  }
  const perUser = slotFor(env.QUANTA_PERMISSION_PROFILE_PER_USER)
  const perRepo = slotFor(env.QUANTA_PERMISSION_PROFILE_PER_REPO)
  const teamAdmin = slotFor(env.QUANTA_PERMISSION_PROFILE_TEAM_ADMIN)
  if (perUser === undefined && perRepo === undefined && teamAdmin === undefined) {
    return undefined
  }
  return {
    ...(perUser !== undefined ? { perUser } : {}),
    ...(perRepo !== undefined ? { perRepo } : {}),
    ...(teamAdmin !== undefined ? { teamAdmin } : {}),
  }
}

/** ADR-0438 wire — build the {@link ProfileDefinitionRegistry} of USER-authored
 *  `extends` definitions from the composition-root env view.
 *
 *  Source: a single JSON-object env knob `QUANTA_PERMISSION_PROFILES_JSON`
 *  mapping `<name> → ProfileDefinition` (every pillar partial + optional
 *  `extends`/`tag`). Chosen over a disk dir because (a) it is synchronous at the
 *  composition root (no async file IO on the startup path the A2 wire already
 *  runs sync), (b) it matches the existing `QUANTA_*` single-env idiom the
 *  sibling profile knobs use, and (c) the disk dir (`QUANTA_PROFILES_DIR`) is
 *  already owned by `selectPermissionProfile` for COMPLETE structs — definitions
 *  are a distinct, partial shape, so a distinct knob avoids overloading it.
 *
 *  Fail-closed (the env READ is the ONLY IO; the resolver stays pure):
 *   - absent / empty ⇒ `{}` (default-OFF — the A2 path is byte-identical).
 *   - not valid JSON / not an object ⇒ THROW (startup rejects loudly).
 *   - any per-definition parse error ⇒ THROW (a malformed user definition must
 *     not be silently dropped — see {@link buildDefinition}).
 *   - a definition whose KEY collides with a built-in name ⇒ THROW (a built-in
 *     name is authoritative; a user file must not shadow `trusted`/`default`/
 *     `restricted`, mirroring `profile-list-select.ts` built-in precedence).
 *
 *  The returned registry composes WITH the built-ins: `resolveProfileInheritance`
 *  falls back to `NAMED_PROFILES` for any name (base or top-level) absent here,
 *  so a definition may `extends: "trusted"` and a built-in name still resolves
 *  byte-identically. */
export const buildProfileDefinitionRegistry = (
  env: NodeJS.ProcessEnv,
): ProfileDefinitionRegistry => {
  const raw = env.QUANTA_PERMISSION_PROFILES_JSON
  if (raw === undefined || raw.trim() === "") return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new ProfileValidationError(
      "QUANTA_PERMISSION_PROFILES_JSON",
      `not valid JSON: ${errMessage(e)}`,
    )
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProfileValidationError(
      "QUANTA_PERMISSION_PROFILES_JSON",
      "must be a JSON object mapping <name> -> ProfileDefinition",
    )
  }
  const registry: Record<string, ProfileDefinition> = {}
  for (const [name, def] of Object.entries(parsed as Record<string, unknown>)) {
    if ((NAMED_PROFILE_NAMES as ReadonlyArray<string>).includes(name)) {
      throw new ProfileValidationError(
        `QUANTA_PERMISSION_PROFILES_JSON.${name}`,
        `name '${name}' collides with a built-in profile (built-ins are authoritative)`,
      )
    }
    // buildDefinition is fail-closed: unknown key / bad enum / malformed ⇒ throw.
    registry[name] = buildDefinition(`QUANTA_PERMISSION_PROFILES_JSON.${name}`, def)
  }
  return registry
}

/** True when the selected `name` should resolve through the inheritance graph
 *  rather than the legacy by-name built-in path. The inheritance path is taken
 *  whenever ANY user definition exists (the selected name may be a user def, or a
 *  built-in extended by a user def in its chain). With an EMPTY registry the
 *  legacy path is kept so the three built-ins stay byte-identical (reference
 *  identity) and the A2 wire is unchanged. */
const hasUserDefinitions = (registry: ProfileDefinitionRegistry): boolean =>
  Object.keys(registry).length > 0

/** GAP2 + layered-policy-merge — resolve the live `PermissionContext.mode`
 *  override from the permission profile(s) selected at the composition root.
 *
 *  Two paths, in precedence order:
 *   1. LAYERED — when ≥1 of `QUANTA_PERMISSION_PROFILE_{PER_USER,PER_REPO,
 *      TEAM_ADMIN}` is set, the slots are merged via `mergeProfileLayers` under
 *      the `policy-merge` strategy (`QUANTA_POLICY_MERGE_STRATEGY`), and the
 *      mode is derived from the MERGED profile's approval pillar. The strategy
 *      deterministically changes the winner: under `source-precedence` the
 *      most-authoritative layer's approval wins; under `most-restrictive` the
 *      SAFER approval wins regardless of source.
 *   2. SINGLE (legacy GAP2) — otherwise the single `QUANTA_PERMISSION_PROFILE`
 *      (or `--permission-profile` flag, which WINS) is resolved and its
 *      approval pillar derived.
 *
 *  FAIL-CLOSED throughout: an unknown / `custom` name THROWS (a typo'd profile
 *  must not silently fall back to a permissive mode).
 *
 *  Returns `undefined` when NO profile (single or layered) is selected ⇒ the
 *  caller leaves `base.permission` untouched ⇒ byte-identical legacy (RFC §1.2).
 *  We DERIVE the existing single permission context rather than publishing a
 *  second profile manager: the network axis is already enforced by the A1
 *  dispatch-guard and the file-system axis is not dispatch-time-enforceable, so
 *  the only non-duplicating wire is the approval→context-mode derive. */
export const resolvePermissionModeFromProfile = (
  flag: import("@/host/runtime/agent-args").PermissionProfileToken | undefined,
  env: NodeJS.ProcessEnv,
  registry: ProfileDefinitionRegistry = {},
): PermissionMode | undefined => {
  // Layered path takes precedence when any layered var is present.
  const layered = resolveLayeredProfileSlots(env)
  if (layered !== undefined) {
    const strategy = resolvePolicyMergeStrategy(env)
    const { merged } = mergeProfileLayers(layered, strategy)
    return permissionModeFromProfile(merged)
  }
  // Legacy single-profile GAP2 path. Precedence MUST match
  // resolvePermissionProfileManager: an explicit `--permission-profile` flag
  // WINS over QUANTA_PERMISSION_PROFILE, so the derived mode and the published
  // manager always describe the SAME profile.
  const name = flag ?? env.QUANTA_PERMISSION_PROFILE
  if (name === undefined || name === "") return undefined
  // FAIL-CLOSED: throws on an unknown name (incl. `custom`, an undefined base, a
  // cycle, or a managed-widen) — the surface entry surfaces it rather than
  // guessing a mode.
  return permissionModeFromProfile(resolveSelectedProfile(name, registry))
}

/** ADR-0438 — resolve the SELECTED profile name to a concrete
 *  {@link PermissionProfile}, routing through the inheritance graph when any user
 *  definition exists, else the legacy by-name built-in path (byte-identical
 *  reference identity for the 3 built-ins). The SAME resolution feeds BOTH the
 *  mode derive and the manager registration, so they always describe one profile.
 *
 *  Fail-closed: `resolveProfileInheritance` throws a typed
 *  {@link ProfileInheritanceError} for an unknown name / undefined base / cycle /
 *  self-extend / managed-widen (under `onManagedWiden:"throw"`); the legacy
 *  `resolveProfileByName` throws on an unknown / `custom` name. Neither ever
 *  returns a permissive fallback. */
const resolveSelectedProfile = (
  name: string,
  registry: ProfileDefinitionRegistry,
): PermissionProfile =>
  hasUserDefinitions(registry)
    ? resolveProfileInheritance(name, registry)
    : resolveProfileByName(name)

/** Resolve the retrieval-stack opt-in flag from the composition-root env view.
 *  Single canonical knob — `QUANTA_RETRIEVAL_HYBRID="1"` enables; any other
 *  value (incl. absent / `"0"` / `"true"` — explicit "1" only) ⇒ disabled.
 *  Strict-equals to "1" so a typo like "true" is treated as off (loud
 *  silent-default avoidance: the operator either set the canonical value or
 *  they did not).
 *
 *  ENV-touchpoint discipline: this is the ONLY retrieval-related env read in
 *  the entire codebase. `@/runner/assemble/retrieval.ts` is env-free; the
 *  surface (this file) projects ENV → typed input. */
const isRetrievalHybridEnabled = (env: NodeJS.ProcessEnv): boolean =>
  gateOn(env, "QUANTA_RETRIEVAL_HYBRID")

/** ADR-0196 — pick the MCP capability negotiator from env. `QUANTA_MCP_CAPS=full`
 *  swaps to {@link fullNegotiator} which advertises `{tools, elicitation, tasks}`.
 *  Any other value (including absent) yields the byte-identical `{}` default.
 *  Single canonical knob; no aliases.
 *
 *  B1 follow-up (jun-04, WIRED) — `sampling` is advertised IFF a real
 *  `SamplingHandlerPort` is wired, which the caller signals via
 *  `opts.sampling`. The advertisement and the handler MUST move together: the
 *  composition root computes BOTH from one gate
 *  ({@link buildSamplingWiring}) — `QUANTA_MCP_SAMPLING=1` AND an LLM AND a
 *  consent prompter must all be present. The caller passes that gate's
 *  `advertise` flag here AND the matching `handler` to the `McpClient` as
 *  `samplingHandler`, so we never advertise a capability `handleInboundRequest`
 *  would answer with `-32601`. `opts.sampling` defaults to `false` ⇒
 *  byte-identical to every existing call (`{}` or full-without-sampling). */
/** Track A2 — the composition-root session thread key the named permission
 *  profile is registered under. The unified-agent surface starts ONE logical
 *  session per process; a single stable key is the right granularity for the
 *  startup profile (the per-thread `TwoLayerManager` API still lets a future
 *  multi-thread host register additional profiles under their own keys). */
export const PERMISSION_PROFILE_SESSION_THREAD = "session" as const

/**
 * Track A2 + ADR-0438 — resolve the named permission profile from the
 * composition-root env/flag view and apply it through the EXISTING
 * `TwoLayerManager` write path.
 *
 * Precedence: an explicit `--permission-profile <name>` flag (already validated
 * by the parser) WINS over the `QUANTA_PERMISSION_PROFILE` env knob. When
 * neither is present, returns `undefined` so the slot is OMITTED and behavior
 * is byte-identical to today (no manager constructed, no allocation).
 *
 * Two resolution paths, gated by whether ANY user definition exists in
 * `registry` (built from `QUANTA_PERMISSION_PROFILES_JSON`):
 *   - NO user defs (default-OFF) — legacy A2: `name` MUST be a built-in
 *     ({@link isNamedProfileName}); registered via `setPermissionProfileByName`.
 *     Byte-identical to before this ADR.
 *   - user defs present (ADR-0438) — `name` may be a built-in OR a user-def key;
 *     registered via `setPermissionProfileFromRegistry`, which resolves the
 *     `extends` graph (`resolveProfileInheritance`) so a profile declaring
 *     `extends` actually folds base → derived (monotone-narrowing + Managed
 *     ceiling) before the merged struct reaches the per-thread slot. A built-in
 *     name with no user-def chain still resolves byte-identically.
 *
 * Fail-closed throughout: the legacy path throws on a non-built-in name; the
 * inheritance path throws a typed `ProfileInheritanceError` (unknown base /
 * cycle / self-extend / managed-widen). Neither silently falls back to a
 * permissive default. (The flag path cannot reach the legacy throw — the parser
 * already rejected an invalid flag value with exit 64 — but we re-validate
 * defensively so the single resolver owns the invariant.)
 */
export const resolvePermissionProfileManager = (
  flag: import("@/host/runtime/agent-args").PermissionProfileToken | undefined,
  env: NodeJS.ProcessEnv,
  registry: ProfileDefinitionRegistry = {},
): TwoLayerManager | undefined => {
  const name = flag ?? env.QUANTA_PERMISSION_PROFILE
  if (name === undefined || name === "") return undefined
  const manager = createTwoLayerManager()
  if (hasUserDefinitions(registry)) {
    // ADR-0438 — resolve through the `extends` graph (fail-closed throws on
    // cycle / unknown base / self-extend / managed-widen). A built-in name with
    // no chain folds to the byte-identical built-in via the `builtins` fallback.
    manager.setPermissionProfileFromRegistry(PERMISSION_PROFILE_SESSION_THREAD, name, registry)
    return manager
  }
  // Legacy A2 path — built-in names only, byte-identical.
  if (!isNamedProfileName(name)) {
    throw new Error(
      `QUANTA_PERMISSION_PROFILE='${name}' is not a resolvable named permission ` +
        `profile (one of default|restricted|trusted). Fix the value or unset it; ` +
        `a bespoke 'custom' profile is supplied as a struct, not by name.`,
    )
  }
  manager.setPermissionProfileByName(PERMISSION_PROFILE_SESSION_THREAD, name)
  return manager
}

/** Resolve BOTH composition-root permission-profile wirings from one place so
 *  `buildBaseFromArgs` carries a single call (keeps it under biome's
 *  cognitive-complexity cap). The `manager` is the per-thread slot (A2 +
 *  ADR-0438 inheritance); the `mode` is the behavior-LIVE PermissionContext
 *  override derived from the SAME resolved profile's approval pillar (GAP2). Both
 *  honor the same flag-wins precedence, the same `QUANTA_PERMISSION_PROFILES_JSON`
 *  registry, and the same fail-closed throw, so they always describe one profile.
 *  Absent profile ⇒ `{}` (both undefined ⇒ byte-identical legacy). */
const resolvePermissionProfileWiring = (
  flag: import("@/host/runtime/agent-args").PermissionProfileToken | undefined,
  env: NodeJS.ProcessEnv,
): {
  /** Spread-ready slot (`{}` when absent) so the `base` literal carries no
   *  conditional branch for it (keeps `buildBaseFromArgs` under the complexity cap). */
  managerSlot: { permissionProfileManager?: TwoLayerManager }
  mode: PermissionMode | undefined
} => {
  // Build the inheritance registry ONCE (fail-closed) so the manager + the mode
  // derive resolve against the identical definitions. Empty ⇒ byte-identical A2.
  const registry = buildProfileDefinitionRegistry(env)
  const manager = resolvePermissionProfileManager(flag, env, registry)
  return {
    managerSlot: manager !== undefined ? { permissionProfileManager: manager } : {},
    mode: resolvePermissionModeFromProfile(flag, env, registry),
  }
}

export const pickMcpNegotiator = (
  env: NodeJS.ProcessEnv,
  opts: { sampling?: boolean; roots?: boolean } = {},
): CapabilityNegotiator =>
  env.QUANTA_MCP_CAPS === "full"
    ? fullNegotiator({
        ...(opts.sampling === true ? { sampling: true } : {}),
        // H19 — advertise `roots` IFF a `RootsProviderPort` is wired (the caller
        // passes the `buildRootsWiring().advertise` flag here AND the matching
        // provider to the `McpClient`), so we never advertise a capability the
        // client cannot honestly answer. Absent ⇒ omitted (byte-identical).
        ...(opts.roots === true ? { roots: true } : {}),
      })
    : defaultNegotiator

/** ADR-0428 jun-02 wire — resolve the socket-level egress proxy config from the
 *  composition-root env view and return a SPREAD-READY slot (`{}` when off) so
 *  the base literal carries no conditional branch for it (keeps
 *  `buildBaseFromArgs` under biome's cognitive-complexity cap). Absent / "0" /
 *  empty / zero-token ⇒ `{}` (default-OFF byte-identical). */
const resolveNetworkProxySlot = (
  env: NodeJS.ProcessEnv,
): { networkProxy?: NonNullable<AssembleRequest["base"]["networkProxy"]> } => {
  const networkProxy = resolveNetworkProxyFromEnv(env)
  return networkProxy !== undefined ? { networkProxy } : {}
}

// ADR-0452 jun-02 wire — composition-root projection of `QUANTA_PREWARM` into
// `AgentConfig.prewarm`. Extracted (mirrors `resolveNetworkProxySlot`) so the
// branch lives here, NOT in `buildBaseFromArgs` (keeps that function under
// biome's cognitive-complexity cap). Default-OFF (`parseEnvFlag(…, false)`):
// absent ⇒ `undefined` ⇒ slot omitted ⇒ the loop reads no clock, runs no warm,
// emits no TTFM key (byte-identical legacy). `now` is the REAL clock injected
// ONLY here at the root (the slice body reads no timer); the stock LLM adapters
// implement no `prewarm` hook, so warming is a documented no-op while the
// `quanta.startup.*` TTFM observability is genuinely active.
const resolvePrewarmSlot = (
  env: NodeJS.ProcessEnv,
): { prewarm?: NonNullable<AssembleRequest["base"]["prewarm"]> } =>
  parseEnvFlag(env.QUANTA_PREWARM, /* defaultOn */ false)
    ? { prewarm: { enabled: true, now: () => Date.now() } }
    : {}

// ADR-0455 jun-02 wire — load `.quanta/environment.toml` (Codex `.codex/
// environments` fallback) from `cwd` up to the repo root and resolve the
// selected environment. Async (the loader does a directory walk + file read),
// so it runs at the ALREADY-async composition root (`runMain`) and the result
// is threaded onto the SYNC `buildBaseFromArgs` via `AssembleRequestPartial.
// localEnv` — keeping every existing `buildBaseFromArgs` caller synchronous.
//
// Default-OFF: no config file ⇒ `loadLocalEnvConfig` returns `undefined` ⇒
// `undefined` here ⇒ slot omitted ⇒ ambient env byte-identical. A DECLARED-but-
// malformed config is fail-closed (parse error ⇒ NOT applied) + surfaced via a
// warn so the operator sees the broken file instead of a silently-wrong env.
// `name` comes from the closed knob `QUANTA_LOCAL_ENV`; unset ⇒ the config's
// declared default (or nothing). NO sniffing — only the config is read.
export const resolveLocalEnvSelection = async (
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<LocalEnvSelection | undefined> => {
  const loaded = await loadLocalEnvConfig(cwd, Bun.TOML.parse)
  if (loaded === undefined) return undefined
  if (!loaded.result.ok) {
    logger.warn(
      `local-env config at ${loaded.sourcePath} is malformed (${loaded.result.reason}); ` +
        "not applied. Fix the file or remove it.",
    )
    return undefined
  }
  return selectEnvironment(loaded.result.config, env.QUANTA_LOCAL_ENV)
}

// Spread-ready projection of the partial's resolved local-env selection (`{}`
// when absent ⇒ no branch in `buildBaseFromArgs`, keeps it under biome's
// cognitive-complexity cap — same pattern as `resolvePrewarmSlot`).
const localEnvSlotOf = (p: AssembleRequestPartial): { localEnv?: LocalEnvSelection } =>
  p.localEnv !== undefined ? { localEnv: p.localEnv } : {}

// Spread-ready projection of the partial's named-agent resolver (`{}` when absent
// ⇒ no branch in `buildBaseFromArgs`, keeps it under biome's cognitive-complexity
// cap — same pattern as `localEnvSlotOf`). Absent ⇒ `AgentConfig.namedAgentResolver`
// stays unset ⇒ the subagent runner's resolve path is byte-identical (no named
// agent ever matches).
const namedAgentResolverSlotOf = (
  p: AssembleRequestPartial,
): { namedAgentResolver?: import("@/agent").NamedAgentResolver } =>
  p.namedAgentResolver !== undefined ? { namedAgentResolver: p.namedAgentResolver } : {}

// ADR-0454 jun-02 wire — install disk-configured command hooks onto the base's
// HookBus. SECURITY: command hooks run ARBITRARY shell, so the slice is
// triple-gated INSIDE (enabled + acknowledgedRisk + ≥1 binding) + injection-safe
// (payload is stdin-JSON, NEVER the command string) + env-allowlist-scrubbed +
// timeout-bounded. This root wire only SUPPLIES config + ports — it cannot
// weaken those gates.
//
// Default-OFF: `QUANTA_COMMAND_HOOKS !== "1"` ⇒ no config, no throw, no handlers
// (byte-identical). `enabled` WITHOUT `acknowledgedRisk` ⇒ normalizeCommandHookGate
// THROWS at startup (fail-fast — never mid-turn). Bindings come ONLY from
// `settings.json#hooks` (loaded async at runMain, threaded via the partial).
//
// Permission port: per the approved design the TRIPLE-GATE IS the approval — the
// operator explicitly armed (enabled), typed an audit-grade acknowledgement, and
// authored the bindings on disk — so `isAllowed` returns true; `bypass` mode is
// the recommended operating posture. The port is an INJECTED seam a host MAY
// tighten (e.g. route through an interactive approval) without touching the slice.
export const installCommandHooksIntoBase = (
  base: AssembleRequest["base"],
  env: NodeJS.ProcessEnv,
  bindings: readonly CommandHookBinding[] | undefined,
): void => {
  if (!gateOn(env, "QUANTA_COMMAND_HOOKS")) return // default-OFF
  const config: CommandHookConfig = {
    enabled: true,
    ...(env.QUANTA_COMMAND_HOOKS_ACK !== undefined
      ? { acknowledgedRisk: env.QUANTA_COMMAND_HOOKS_ACK }
      : {}),
    bindings: bindings ?? [],
  }
  const gate = normalizeCommandHookGate(config) // throws on enabled-without-ack (fail-fast)
  if (!gate.armed) return // ack present but no bindings ⇒ disarmed ⇒ no-op
  // Command hooks need a bus; reuse the observability bus if present, else mint
  // one (command hooks are independent of QUANTA_OBSERVABILITY).
  const bus = base.hooks ?? new HookBus()
  base.hooks = bus
  installCommandHooks(bus, gate, {
    exec: createSandboxCommandHookExec(),
    permission: { isAllowed: () => true },
    cwd: base.cwd,
  })
}

/** N6 — resolve the spread-ready `ptySession` slot (`{}` when the knob is OFF
 *  so the tool menu stays byte-identical). When ON, the leaf `tmux` runner is
 *  the real `bunTmuxExec` UNLESS a hermetic `seams.ptyExec` is injected, in
 *  which case the SAME production `createTmuxAdapter` (allow-prefix jail + `--`
 *  flag guard) wraps the fake — so an e2e drives the real adapter against a fake
 *  tmux. Extracted so the nested choice does NOT add to `buildGatedToolPorts`'s
 *  cognitive complexity. */
const resolvePtySessionSlot = (
  ptyAttach: boolean,
  ptyBackend: PtyBackend,
  seams: CompositionSeams | undefined,
): { ptySession: NonNullable<DefaultToolPorts["ptySession"]> } | Record<string, never> => {
  if (!ptyAttach) return {}
  const exec = seams?.ptyExec
  // A hermetic e2e seam ALWAYS drives the real tmux adapter against a fake tmux
  // (backend selection is irrelevant to that path). Otherwise route through the
  // QUANTA_PTY_BACKEND selector (tmux/bun/both — bun falls back to tmux when
  // Bun.Terminal is unavailable). The jail root is the workspace cwd.
  if (exec !== undefined) return { ptySession: createTmuxAdapter({ exec }) }
  return { ptySession: buildPtyBackend(ptyBackend, process.cwd()) }
}

/**
 * Round-3 composition-root activation — resolve the gated `DefaultToolPorts`
 * slots whose tool(s) round-2 found are deferred behind a `QUANTA_*` knob. Each
 * spread is `{}` when its gate is OFF, so the assembled tool menu is
 * byte-identical to today's default-OFF path; present ⇒ the conditional
 * registration inside `buildDefaultTools` appends exactly that gate's tool(s).
 *
 * The `env` view (already provider-overlaid by `buildBaseFromArgs`) is the ONLY
 * place an env value is read here; the boolean knobs route through the frozen
 * `runtimeConfig()` (single env touchpoint), and `imageGen`'s key comes from the
 * SAME `OPENAI_API_KEY` source the LLM factory uses (never hardcoded; absent key
 * ⇒ the port returns a typed `no_key`, never a crash). Extracted from
 * `buildBaseRegistry` so that function stays under biome's cognitive-complexity
 * cap. Construction of every adapter is IO-free — no spawn/fetch happens until a
 * tool actually dispatches.
 */
/**
 * CLUSTER D #5 — the SHARED per-session permission slice (store + propose port).
 *
 * BASELINE-SEED RESIDUAL — CLOSED. The store is the SINGLE instance threaded to
 * BOTH consumers so the model can only refine what the USER already approved:
 *
 *   1. {@link buildBaseFromArgs} sets it on `AgentConfig.permissionPatternStore`,
 *      so the admissibility-gate's user-approval path (`cascadeOnApprove` →
 *      `grantAndCascade` → `store.grant(...)`) writes USER/POLICY-approved
 *      patterns INTO THIS store's `baseline`, and the gate's `autoPassByPatterns`
 *      reads coverage FROM the same store.
 *   2. {@link buildGatedToolPorts} wires `permission_propose_pattern` over the
 *      SAME store, so `recordProposedPattern`'s `isBaseline` check is meaningful:
 *      a model proposal is recorded ONLY when every pattern is in the baseline
 *      the gate grew via user approvals. The baseline is therefore seeded LIVE,
 *      at runtime, by the user — never fabricated from a guessed allow-list.
 *
 * SECURITY (load-bearing): the propose port writes via `recordProposed` (the
 * `allowed`-only, no-widen-gated half) — it NEVER calls `store.grant`, so a model
 * proposal can never seed the baseline (no self-grant, no chain-widen: a recorded
 * `allowed` pattern is not baseline, so refining IT is still `would_widen`).
 * Dangerous gating stays CLOSED (`allowDangerous: false`) — no operator opt-in
 * knob is wired here.
 *
 * Default-OFF: returns `undefined` unless `QUANTA_REMEMBER_PATTERNS === "1"`. The
 * store is allocated ONCE per `buildBaseFromArgs` call (per session) and reused by
 * both consumers — never two divergent empty-baseline stores.
 */
interface PermissionPatternSlice {
  readonly store: PatternGrantStore
  readonly proposePort: {
    recordProposed: (input: {
      proposed: readonly string[]
      isMaybeDangerous?: boolean
    }) => ReturnType<typeof recordProposedPattern>
  }
}

const resolvePermissionPatternSlice = (): PermissionPatternSlice | undefined => {
  if (runtimeConfig().rememberPatterns !== true) return undefined
  // CLUSTER D #5 residual — operator opt-in to RECORD dangerous-flagged
  // proposals. Default false ⇒ `allowDangerous: false` (a dangerous proposal is
  // always rejected, byte-identical). ON ⇒ `allowDangerous: true` lifts ONLY the
  // dangerous-gate. SECURITY: the no-widen gate inside `recordProposedPattern` is
  // independent of `allowDangerous`, so a dangerous-AND-uncovered proposal is
  // still `would_widen` rejected — the knob can NEVER seed a new capability.
  const allowDangerous = runtimeConfig().rememberPatternsDangerous === true
  // ONE per-session store. The gate grows its baseline via user approvals
  // (`store.grant`); the propose port refines within it via `recordProposed`.
  const store = new PatternGrantStore()
  return {
    store,
    proposePort: {
      recordProposed: (input: { proposed: readonly string[]; isMaybeDangerous?: boolean }) =>
        recordProposedPattern(
          store,
          {
            proposed: input.proposed,
            ...(input.isMaybeDangerous !== undefined
              ? { isMaybeDangerous: input.isMaybeDangerous }
              : {}),
          },
          // Dangerous-gate state from the operator knob; the no-widen gate is
          // unaffected (it always rejects an uncovered proposal).
          { allowDangerous },
        ),
    },
  }
}

/** file_history_rewind — the SHARED per-file snapshot slice. The store is the
 *  read side (`DefaultToolPorts.fileHistory`, backing `file_history_rewind`); the
 *  sink is the write side (`AgentConfig.fileHistory`, surfaced onto
 *  `ctx.fileHistory` so write/edit record each new file version into the SAME
 *  store). One store per session — both sides MUST share it, so we mint once
 *  here and thread both, exactly like the permission-pattern slice. */
interface FileHistorySlice {
  readonly store: FileHistoryStore
  readonly sink: FileHistorySink
}

/** Mint the shared file-history slice when `QUANTA_FILE_HISTORY` is on (strict
 *  `=== "1"` via `runtimeConfig().fileHistory`). Absent ⇒ `undefined` ⇒ no store,
 *  no sink, no tool — byte-identical. Bounds default to the store's bounded ring
 *  (per-path version + byte cap); the injected clock is the real `Date.now`
 *  (the ONLY time source — no clock in the pure store). */
const resolveFileHistorySlice = (): FileHistorySlice | undefined => {
  if (runtimeConfig().fileHistory !== true) return undefined
  const store = createFileHistoryStore({ now: () => Date.now() })
  return { store, sink: createFileHistorySink(store) }
}

/** Spread-ready `DefaultToolPorts.fileHistory` slot (the tool read side). `{}`
 *  when the slice is absent ⇒ `buildGatedToolPorts` literal carries no branch. */
const fileHistoryPortSlot = (
  slice: FileHistorySlice | undefined,
): { fileHistory: FileHistoryStore } | Record<string, never> =>
  slice !== undefined ? { fileHistory: slice.store } : {}

/** Spread-ready `AgentConfig.fileHistory` slot (the write/edit capture side).
 *  `{}` when off ⇒ the base literal carries no branch and `ctx.fileHistory` stays
 *  absent (capture is a no-op, byte-identical). */
const fileHistorySinkSlot = (
  slice: FileHistorySlice | undefined,
): { fileHistory: FileHistorySink } | Record<string, never> =>
  slice !== undefined ? { fileHistory: slice.sink } : {}

/** Spread-ready `AgentConfig.permissionPatternStore` slot for the shared slice
 *  ({@link resolvePermissionPatternSlice}). `{}` when the slice is absent (knob
 *  OFF) ⇒ the base literal carries NO extra branch (keeps `buildBaseFromArgs`
 *  under biome's cognitive-complexity cap; mirrors `networkProxySlot` /
 *  `prewarmSlot`). Present ⇒ the gate reads/writes THE SAME store the propose
 *  tool received. */
const permissionPatternStoreSlot = (
  slice: PermissionPatternSlice | undefined,
): { permissionPatternStore: PatternGrantStore } | Record<string, never> =>
  slice !== undefined ? { permissionPatternStore: slice.store } : {}

/** Spread-ready `DefaultToolPorts.permissionPatternPropose` slot. `{}` when the
 *  shared slice is absent (knob OFF / not threaded) ⇒ the gated-ports literal in
 *  {@link buildGatedToolPorts} carries NO extra branch (keeps that function under
 *  biome's cognitive-complexity cap; mirrors the other spread-ready slots).
 *  Present ⇒ the tool refines the SAME baseline the gate grows. */
const permissionProposePortSlot = (
  slice: PermissionPatternSlice | undefined,
): { permissionPatternPropose: PermissionPatternSlice["proposePort"] } | Record<string, never> =>
  slice !== undefined ? { permissionPatternPropose: slice.proposePort } : {}

const buildGatedToolPorts = (
  env: NodeJS.ProcessEnv,
  seams?: CompositionSeams,
  /** CLUSTER D #5 — the SHARED permission slice built once by
   *  {@link buildBaseFromArgs} and threaded to BOTH the gate
   *  (`AgentConfig.permissionPatternStore`) and the propose tool here. Absent ⇒
   *  the `permission_propose_pattern` slot is omitted (byte-identical). NEVER
   *  construct a fresh store here — that would give the tool an empty baseline
   *  divergent from the gate's grown one. */
  permissionPatternSlice?: PermissionPatternSlice,
  /** file_history_rewind — the SHARED file-history slice minted by
   *  {@link buildBaseFromArgs}. The store half wires `file_history_rewind`;
   *  the SAME store's sink wires `AgentConfig.fileHistory` (write/edit capture).
   *  Absent ⇒ the tool slot is omitted (byte-identical). */
  fileHistorySlice?: FileHistorySlice,
  /** gap GAP 11 (ADR-0504) — the assembled main LLM, used to build the LLM-backed
   *  `reflect` port when `QUANTA_REFLECT` is on. `null` (no provider) ⇒ no reflect
   *  port ⇒ tool absent (byte-identical). */
  llm?: LLMPort | null,
): DefaultToolPorts => {
  const cfg = runtimeConfig()
  // C1 — ONE per-session artifact registry when the Canvas store is enabled.
  // Computed up front (not inline) so the appshot slot below can reuse the SAME
  // instance as its artifact sink (the loop registers the final scaffold into the
  // very registry the artifact_* tools read). Absent ⇒ `undefined` ⇒ both the
  // `artifactRegistry` slot AND the appshot sink stay omitted (byte-identical).
  const artifactRegistry = gateOn(process.env, "QUANTA_ARTIFACT_STORE")
    ? createArtifactRegistry({ now: () => Date.now(), idFactory: monotonicIdFactory() })
    : undefined
  return {
    // ADR-0464 — gated structured-apply tool. Default-OFF: tool menu is
    // byte-identical unless QUANTA_ENABLE_STRUCTURED_PATCH === "1".
    ...(gateOn(process.env, "QUANTA_ENABLE_STRUCTURED_PATCH") ? { structuredPatch: true } : {}),
    // ADR-0165 — gated coverage_check tool. Default-OFF: tool menu is
    // byte-identical unless QUANTA_COVERAGE_TOOL === "1".
    ...(gateOn(process.env, "QUANTA_COVERAGE_TOOL") ? { coverageCheck: true } : {}),
    // C1 — gated artifact (Canvas) tools. Default-OFF: tool menu byte-identical
    // unless QUANTA_ARTIFACT_STORE === "1". Mints ONE per-session registry
    // (real clock + monotonic id factory) shared by the artifact_* tools.
    ...(artifactRegistry !== undefined ? { artifactRegistry } : {}),
    // CLUSTER D #5 — gated permission_propose_pattern tool over the SHARED
    // per-session store built by `buildBaseFromArgs` (BASELINE-SEED RESIDUAL
    // CLOSED). The SAME store backs `AgentConfig.permissionPatternStore`, so the
    // model can only refine patterns the USER already approved via the gate's
    // `store.grant(...)` path. We NEVER construct a fresh empty-baseline store
    // here. Spread-ready slot (`{}` when off ⇒ tool not registered ⇒
    // byte-identical).
    ...permissionProposePortSlot(permissionPatternSlice),
    // file_history_rewind — gated per-file snapshot list/restore tool over the
    // SHARED session store (the SAME store whose sink wires AgentConfig.fileHistory
    // so write/edit record into exactly what this tool reads). Default-OFF: `{}`
    // when QUANTA_FILE_HISTORY is off ⇒ tool not registered ⇒ byte-identical.
    ...fileHistoryPortSlot(fileHistorySlice),
    // N2 — gated MCP connector discovery tools (mcp_connector_list/_install).
    // Default-OFF: tool menu byte-identical unless QUANTA_MCP_CONNECTORS === "1".
    // The port lists the bundled reference catalog and installs a chosen server
    // into the project `.mcp.json` (QUANTA_MCP_CONFIG override, else cwd) via the
    // atomic merge writer — the same file `readMcpConfig` ingests next launch.
    ...(cfg.mcpConnectors
      ? {
          mcpConnectors: buildMcpConnectorDiscoveryPort({
            configPath:
              process.env.QUANTA_MCP_CONFIG?.trim() || joinPath(process.cwd(), ".mcp.json"),
          }),
        }
      : {}),
    // H14a — gated image_gen tool. Default-OFF: tool menu byte-identical unless
    // QUANTA_IMAGE_GEN === "1". The provider port is KEY-BOUND from the same
    // `OPENAI_API_KEY` the LLM factory reads (NEVER hardcoded); a key-less port
    // yields a typed `no_key` outcome rather than crashing, so wiring is always
    // safe. The OpenAI base-url / model knobs the factory honors are honored too.
    ...(cfg.imageGen
      ? {
          imageGen: openAiImagePort({
            ...(env.OPENAI_API_KEY !== undefined && env.OPENAI_API_KEY !== ""
              ? { apiKey: env.OPENAI_API_KEY }
              : {}),
            ...(env.OPENAI_BASE_URL !== undefined && env.OPENAI_BASE_URL !== ""
              ? { baseUrl: env.OPENAI_BASE_URL }
              : {}),
          }),
        }
      : {}),
    // image downsample (gap GAP 1, ADR-0507) — gated macOS `sips`-backed codec so
    // read_image SHRINKS oversized images instead of rejecting. PLATFORM-BOUND
    // (darwin only) + default-OFF: absent ⇒ over-cap images rejected as before
    // (byte-identical). Non-macOS / gate-off ⇒ no port.
    ...(process.platform === "darwin" && gateOn(env, "QUANTA_IMAGE_DOWNSAMPLE")
      ? { imageDownsample: sipsImageDownsamplePort() }
      : {}),
    // reflect (gap GAP 11, ADR-0504) — gated LLM-backed self-correction tool.
    // Default-OFF: tool menu byte-identical unless QUANTA_REFLECT is on AND a real
    // LLM is present (a one-shot critique turn rides the main LLM, no tools offered).
    ...(llm != null && gateOn(env, "QUANTA_REFLECT")
      ? { reflect: reflectConsultFromLLM({ llm }) }
      : {}),
    // H14b — gated Office authoring tools (xlsx_write/docx_write/pptx_write).
    // Default-OFF: tool menu byte-identical unless QUANTA_OFFICE_AUTHORING === "1".
    // Boolean port — the tools serialize pure-TS OOXML + write through the same
    // FS-jail chokepoint the readers use; no adapter to construct.
    ...(cfg.officeAuthoring ? { officeAuthoring: true } : {}),
    // W6 (NotebookEdit P17) — gated `notebook_edit` cell editor. Default-OFF:
    // tool menu byte-identical unless QUANTA_NOTEBOOK_EDIT === "1". Pure editor
    // over the shared FS jail; boolean flag (no adapter to construct).
    ...(cfg.notebookEdit ? { notebookEdit: true } : {}),
    // W5 (DAP) — gated `debug_inspect` debugger tool. Default-OFF: tool menu
    // byte-identical unless QUANTA_DEBUG_TOOLS === "1". Boolean flag — the tool
    // owns the real spawn port; high-risk (always-confirm tier).
    ...(cfg.debugTools ? { debugTools: true } : {}),
    // Epic-2 — gated `run_tests` structured test-runner. Default-OFF: tool menu
    // byte-identical unless QUANTA_TEST_RUNNER === "1". High-risk (always-confirm).
    ...(cfg.testRunner ? { testRunner: true } : {}),
    // C2 — gated communicate_update tool. Default-OFF: tool menu byte-identical
    // unless QUANTA_PROGRESS_UPDATE === "1". Boolean port — the tool reads its
    // `ProgressSink` from `ctx.progressSink` (surfaced by the dispatch seam from
    // `AgentConfig.progressSink`); absent sink ⇒ a no-op + ok:true.
    ...(cfg.progressUpdate ? { progressUpdate: true } : {}),
    // code-mode (RFC jun-6-code-mode, Phase 1) — gated `code_cell` tool. Default-OFF:
    // tool menu byte-identical unless QUANTA_CODE_MODE === "1". The tool reads its
    // per-cell dispatch port from `ctx.codeCellDispatch` (surfaced by the dispatch
    // seam from `AgentConfig.codeCellDispatchFactory`, wired by
    // `wireOptionalAgentPorts`). The QuickJS-WASM module is lazily imported so the
    // OFF binary never instantiates it; an unwired factory ⇒ typed `not_wired`.
    // Slot extracted to a helper so this builder stays under the complexity cap.
    ...codeModePortSlot(cfg.codeMode),
    // N6 — gated pty_* tools (attach/list/write/read/resize/kill). Default-OFF:
    // tool menu byte-identical unless QUANTA_PTY_ATTACH === "1". The tmux backend
    // (`Bun.spawn(["tmux", …])`, argv-array, no shell) is constructed at the
    // composition layer (`pty-backend.ts`) and injected as the `PtySessionPort`;
    // construction is IO-free (no spawn until a pty tool dispatches). Resolved by
    // the extracted helper so the (knob × seam) choice adds no complexity here.
    ...resolvePtySessionSlot(cfg.ptyAttach, cfg.ptyBackend, seams),
    // G1 (RFC jun-6-appgen-appshot) — gated `appshot_verify` slot. Default-OFF:
    // tool menu byte-identical unless QUANTA_APPSHOT === "1". The slice's render/
    // screenshot arrows ride a real `BrowserPort`, which at THIS pre-assembler
    // layer is NOT reachable (the CDP browser is wired later in
    // `agent-config-assembler` only when a system Chrome exists). So the slot is
    // minted ONLY when a host/e2e injects a complete `seams.appshotPort` here;
    // production assembly of the BrowserPort+LLM-judge-backed port is the
    // remaining adapter-assembly step (REPORTED). When minted, the injected clock
    // is the real `Date.now` and — when the artifact store is ALSO on — the SAME
    // registry is the artifact sink (final scaffold registered as a Canvas item).
    ...resolveAppshotSlot(cfg.appshot, seams, artifactRegistry),
  }
}

/** code-mode (RFC jun-6-code-mode, Phase 1) — spread-ready `code_cell` tool slot.
 *  `{}` when `QUANTA_CODE_MODE` is off ⇒ tool not registered ⇒ byte-identical menu
 *  AND the QuickJS-WASM module never instantiated. Extracted so `buildGatedToolPorts`
 *  stays under biome's cognitive-complexity cap. */
const codeModePortSlot = (codeMode: boolean): { codeMode: true } | Record<string, never> =>
  codeMode ? { codeMode: true } : {}

/** G1 — resolve the spread-ready `appshot` slot (`{}` when the knob is OFF or no
 *  port is injectable, so the tool menu stays byte-identical). When ON AND a
 *  complete {@link AppshotPort} is injected (`seams.appshotPort`), mint the slot
 *  with the real `Date.now` clock and — when the Canvas registry is present — the
 *  SAME registry as the artifact sink. Extracted so the (knob × seam × registry)
 *  choice adds no complexity to `buildGatedToolPorts`. */
const resolveAppshotSlot = (
  appshot: boolean,
  seams: CompositionSeams | undefined,
  artifactRegistry: ReturnType<typeof createArtifactRegistry> | undefined,
): { appshot: NonNullable<DefaultToolPorts["appshot"]> } | Record<string, never> => {
  if (!appshot) return {}
  const port = seams?.appshotPort
  // No BrowserPort+judge-backed port is reachable at this layer in production; a
  // host/e2e may inject one. Absent ⇒ slot omitted (byte-identical) — the
  // remaining step is to assemble the real port where the BrowserPort lives.
  if (port === undefined) return {}
  return {
    appshot: {
      port,
      now: () => Date.now(),
      ...(artifactRegistry !== undefined ? { artifactSink: artifactRegistry } : {}),
    },
  }
}

const buildBaseRegistry = (args: {
  readonly env: NodeJS.ProcessEnv
  readonly automationSlot: AutomationEngineSlot | null
  readonly sandboxProfile: ReturnType<typeof resolveSandboxProfileFromEnv>
  readonly searchWire: ReturnType<typeof buildSearchPipelineFromEnv>
  /** Required key, value MAY be `undefined` (no conditional spread at the call
   *  site ⇒ no added branch). Absent ⇒ every gated port uses its real backend. */
  readonly seams: CompositionSeams | undefined
  /** CLUSTER D #5 — the SHARED permission slice (store + propose port) so the
   *  `permission_propose_pattern` tool refines the SAME baseline the gate grows
   *  via `AgentConfig.permissionPatternStore`. Absent ⇒ tool omitted. */
  readonly permissionPatternSlice: PermissionPatternSlice | undefined
  /** file_history_rewind — the SHARED file-history slice; its store half wires
   *  `file_history_rewind` here (the sink half wires `AgentConfig.fileHistory`).
   *  Absent ⇒ the tool is omitted (byte-identical). */
  readonly fileHistorySlice: FileHistorySlice | undefined
  /** gap GAP 11 (ADR-0504) — assembled main LLM for the gated `reflect` port.
   *  `null` ⇒ no reflect port (byte-identical). */
  readonly llm: LLMPort | null
}): ToolRegistry =>
  new ToolRegistry([
    ...buildDefaultTools({
      ...(args.automationSlot !== null ? { automationEngine: args.automationSlot.engine } : {}),
      ...(args.sandboxProfile !== undefined ? { sandboxProfile: args.sandboxProfile } : {}),
      ...buildGatedToolPorts(
        args.env,
        args.seams,
        args.permissionPatternSlice,
        args.fileHistorySlice,
        args.llm,
      ),
    }),
    ...(args.searchWire !== null ? [args.searchWire.tool] : []),
    // ADR-0287 — async-tools `poll_deferred`. Default-OFF: registered ONLY when
    // `runtimeConfig().asyncTools` is true (QUANTA_ASYNC_TOOLS). Without it the
    // registry is byte-identical and the LLM never sees the tool. The
    // `DefaultDeferredResultRegistry` is bounded by `runtimeConfig().deferredCap`
    // (QUANTA_DEFERRED_CAP) so a long session cannot grow the handle map
    // unbounded; the tool closes over THIS registry instance — the same one a
    // future `defineToolAsync` caller would register deferred work into.
    ...buildAsyncDeferredTools(),
  ])

/** ADR-0287 — build the `poll_deferred` tool over a freshly-constructed
 *  {@link DefaultDeferredResultRegistry} when async-tools are enabled. Returns
 *  `[]` (no tool, no registry allocation) when `runtimeConfig().asyncTools` is
 *  false — the default-OFF byte-identical path. The cap is the closed env knob
 *  `QUANTA_DEFERRED_CAP` (resolved once by `runtimeConfig`); absent ⇒ the
 *  registry's own `DEFAULT_DEFERRED_CAP`. */
const buildAsyncDeferredTools = (): Tool[] => {
  const cfg = runtimeConfig()
  if (!cfg.asyncTools) return []
  const registry = new DefaultDeferredResultRegistry(
    cfg.deferredCap !== undefined ? { cap: cfg.deferredCap } : {},
  )
  return [pollDeferredTool(registry) as Tool]
}

/**
 * ADR-0281 + ADR-0282 + ADR-0413 — composition-root wire for the memory
 * auto-trigger + cross-session inject slices.
 *
 * Reads three env knobs and produces a small typed config object the
 * host plugs into its session-start / session-end hooks:
 *
 *   - `QUANTA_MEMORY_AUTO`        — ADR-0413: default ON. Falsey set
 *                                   `0 / off / no / false` (case-insensitive,
 *                                   trim via `parseEnvFlag`) ⇒ disabled
 *                                   (returns `null`). Any other value
 *                                   (incl. absent / "on" / "1" / "true")
 *                                   ⇒ enabled.
 *   - `QUANTA_MEMORY_THRESHOLD`   — promote threshold (default 0.7).
 *                                   Invalid number ⇒ default.
 *   - `QUANTA_MEMORY_MIN_USAGE`   — minimum usageCount gate (default 1).
 *                                   Invalid int ⇒ default.
 *
 * Default-ON (ADR-0413): a fresh install with no env knobs gets the
 * cross-session memory slice. The legacy default-OFF behavior is
 * reachable via `QUANTA_MEMORY_AUTO=off`. The function is PURE w.r.t.
 * its input env view; no `process.env` reads. The single canonical
 * resolver lives at `src/runner/assemble/memory-factory.ts` —
 * `buildMemoryForSession`; this surface wrapper exists for HELL-MAT-22
 * legacy lock-in plus a typed-shape mirror surfaces can reach without
 * pulling the whole memory factory into their compile graph.
 */
export const assembleMemoryAuto = (
  env: NodeJS.ProcessEnv,
): {
  readonly enabled: true
  readonly policy: { readonly promoteThreshold: number; readonly minUsageCount: number }
} | null => {
  if (!parseEnvFlag(env.QUANTA_MEMORY_AUTO, /* defaultOn */ true)) return null
  const rawT = env.QUANTA_MEMORY_THRESHOLD
  const rawU = env.QUANTA_MEMORY_MIN_USAGE
  const parsedT = rawT === undefined ? 0.7 : Number(rawT)
  const parsedU = rawU === undefined ? 1 : Number(rawU)
  const promoteThreshold = Number.isFinite(parsedT) ? parsedT : 0.7
  const minUsageCount = Number.isFinite(parsedU) && parsedU >= 0 ? Math.floor(parsedU) : 1
  return {
    enabled: true,
    policy: { promoteThreshold, minUsageCount },
  }
}

/** Build the retrieval stack at the composition root. Default-OFF: when the
 *  env knob is absent or not exactly "1", returns `undefined` and every
 *  legacy caller is byte-identical (no allocation, no registry).
 *
 *  Returns `undefined` on builder failure (e.g. an unknown reranker kind
 *  surfaces as a `RetrievalError`); we LOG and continue rather than crashing
 *  the surface entry — the loop is fully functional without the stack, and
 *  blocking startup on a misconfigured optional knob is wrong. */
const buildRetrievalStackFromEnv = (env: NodeJS.ProcessEnv): RetrievalStack | undefined => {
  if (!isRetrievalHybridEnabled(env)) return undefined
  try {
    return buildRetrievalStackCore({ enabled: true })
  } catch (e) {
    logger.warn(
      `retrieval-stack disabled (build failed): ${errMessage(e)}. ` +
        `set QUANTA_RETRIEVAL_HYBRID=1 with a registered reranker to re-enable.`,
    )
    return undefined
  }
}

/** ADR-0236 — derive the identity-mode-variant registry + the system prompt
 *  it produces. Precedence:
 *    1. CLI `--identity-mode <mode>` ⇒ build prompt via
 *       `buildSystemPromptForMode({ mode })` (registry from
 *       {@link defaultModeVariantRegistry}); ALSO return the registry so the
 *       host can publish it on `AgentConfig.identityModeVariant`.
 *    2. `QUANTA_IDENTITY=1` env (legacy) ⇒ inject identity lines via
 *       `buildSystemPrompt({ identity })` (NO mode-variant registry slot).
 *    3. neither ⇒ empty system prompt; mode-preset's
 *       `req.base.system ?? buildSystemPrompt(cwd)` fallback runs.
 *
 *  Pure of process.env aside from the legacy fallback. */
const resolveIdentitySystemPrompt = (
  cliIdentityMode: IdentityModeToken | undefined,
  env: NodeJS.ProcessEnv,
): {
  readonly system: string
  readonly identityModeVariant?: { readonly registry: SystemPromptVariantRegistry }
} => {
  if (cliIdentityMode !== undefined) {
    const registry = defaultModeVariantRegistry()
    const system = buildSystemPromptForMode({ mode: cliIdentityMode, registry })
    return { system, identityModeVariant: { registry } }
  }
  const identity = resolveIdentityFromEnv(env)
  if (identity !== undefined) return { system: buildSystemPrompt(process.cwd(), { identity }) }
  return { system: "" }
}

/** ADR-0236 — wire the sticky-model store slot. When the CLI passes
 *  `--sticky-model`, the composition root constructs the fs-backed store
 *  (defaults to `~/.quanta/sticky-model.json`). Absent ⇒ undefined ⇒ slot
 *  omitted. The in-memory store is a sibling test-only impl that lives in
 *  `@/agent/sticky-model`; this surface NEVER picks it (operators get
 *  persistence by default once they opt in). */
const resolveStickyModelStore = (
  stickyModel: boolean | undefined,
): { readonly store: StickyModelStore } | undefined => {
  if (stickyModel !== true) return undefined
  // Construction is IO-free (the store only computes its path; all fs access is
  // deferred to get/set/load), so it cannot throw here — a try/catch + in-memory
  // fallback would be dead code. A read-only fs or corrupt home dir surfaces as
  // a TYPED result at the call site instead: get/load degrade to the global
  // default, and set returns a `StickyModelWriteError` that `/sticky-model`
  // renders ("write failed — …"). That is strictly more honest than a silent
  // in-memory degrade where writes would vanish on exit.
  return { store: fsBackedStickyModelStore() }
}

/** ADR-0236 — wire the tool-profile resolver slot when the CLI passes
 *  `--tool-profile <name>`. The resolver is built once per surface (closed
 *  enum profile names — defaults from {@link defaultToolProfileResolver}). */
const resolveToolProfile = (
  profile: ToolProfileToken | undefined,
):
  | { readonly resolver: ToolProfileResolver; readonly defaultName: ToolProfileName }
  | undefined => {
  if (profile === undefined) return undefined
  return { resolver: defaultToolProfileResolver(), defaultName: profile }
}

/** ADR-0236 — wire the focus-chain tracker slot when the CLI passes
 *  `--focus-chain-every <N>` (N > 0). The tracker's cadence is captured at
 *  construction time; the loop's per-turn tick + drain reads from this slot
 *  by reference. */
const resolveFocusChain = (
  every: number | undefined,
): { readonly tracker: FocusChainPort; readonly reinjectEveryN: number } | undefined => {
  if (every === undefined || every <= 0) return undefined
  return {
    tracker: defaultFocusChainTracker({ reinjectEveryN: every }),
    reinjectEveryN: every,
  }
}

/** jun-02 interactive-knob live wire — map the unified-agent run mode to the
 *  knob `Surface` the three interactive knobs (`advisor` / `task-budget` /
 *  `compose-authoring`) recognise. Only `batch` corresponds to the bulk
 *  `agent-batch` surface; every other mode (headless / ide / daemon / ci-bot)
 *  is the interactive `agent-interactive` surface. Mirrors the matrix surface
 *  vocabulary so the env→config fold matches the bench/matrix semantics. */
const knobSurfaceForMode = (mode: AssembleRequest["mode"]): Surface =>
  mode === "batch" ? "agent-batch" : "agent-interactive"

/** ADR-0236 / ADR-0218 — wire the mode-typed delegation port slot. Caller-
 *  side composition only (loop does NOT read this slot — surfaces opt in
 *  via the Agent tool / future `/delegate` slash). Default-OFF: returns
 *  `undefined` unless `--delegate <mode,...>` was passed (or QUANTA_DELEGATE
 *  env was set). The router is built with `wrapSubagentRunner`-style adapter
 *  STUBBED to a no-op when no host runner is wired — the slot's presence
 *  alone publishes the available modes to surfaces. */
const resolveDelegation = (
  base: AssembleRequest["base"],
  delegateModes: ReadonlyArray<DelegationAgentMode> | undefined,
):
  | { readonly delegator: DelegationPort; readonly modes?: ReadonlyArray<DelegationAgentMode> }
  | undefined => {
  if (delegateModes === undefined || delegateModes.length === 0) return undefined
  const runner = createSubagentRunner(base)
  const typed = wrapSubagentRunner(runner)
  const real = defaultDelegationRunner({ runner: typed })
  const delegator: DelegationPort = {
    delegate: async (req) =>
      real.delegate({
        mode: req.mode,
        prompt: req.prompt,
        ...(req.budget !== undefined ? { budget: req.budget } : {}),
        ...(req.parentSignal !== undefined ? { signal: req.parentSignal } : {}),
        ...(req.correlation !== undefined ? { correlation: req.correlation } : {}),
        depth: 0,
      }),
    listModes: () => delegateModes,
    describeMode: (mode) => lookupModeProfile(mode),
  }
  return {
    delegator,
    modes: delegateModes.length > 0 ? delegateModes : AGENT_MODES,
  }
}

/** ADR-0236 / ADR-0226 — wire the rich fork-session port slot. The base
 *  `SessionForker` requires a `ConversationCheckpointStore` which the
 *  unified-agent surface does not yet thread; when `enable` is true we
 *  construct `defaultForker()` WITHOUT a base — every `fork()` call
 *  surfaces `Err("fork-not-configured")` (typed-error, never throws).
 *  Hosts that DO thread a checkpoint store override `base` post-construction
 *  before passing into `assembleAgentConfig`. Absent ⇒ slot omitted,
 *  byte-identical legacy (RFC §1.2). */
const resolveForkSession = (
  enable: boolean | undefined,
):
  | {
      readonly conversationCheckpoint: NonNullable<
        AssembleRequest["base"]["conversationCheckpoint"]
      >
      readonly fork: NonNullable<AssembleRequest["base"]["fork"]>
      readonly forkSession: { readonly forker: ForkSessionPort }
    }
  | undefined => {
  if (enable !== true) return undefined
  const wire = defaultCheckpointBaseWire()
  return {
    conversationCheckpoint: { store: wire.store },
    fork: { forker: wire.base },
    forkSession: { forker: wire.forker },
  }
}

/**
 * ADR-0415 — adapt a live {@link HookBus} to the duck-typed
 * {@link ObservabilityHookBus} surface the wire consumes. The wire NEVER
 * imports `@/agent/hooks` (slice fence), so the composition root owns the
 * adapter.
 *
 * `HookBus.on(type, handler)` returns `this` (no public unsubscribe path —
 * handlers are registered once at startup), so `subscribe()` returns a NO-OP
 * detach closure. The wire's `handle.detach()` is idempotent + drops its own
 * refs regardless; a no-op host unsubscribe is the documented contract (see
 * `observability-wire/types.ts`). A throwing `on()` propagates so the wire's
 * own try/catch degrades the subscription to inert (ports still populate).
 */
const toObservabilityHookBus = (bus: HookBus): ObservabilityHookBus => ({
  subscribe: (event, handler) => {
    bus.on(event, handler as never)
    // hooks.ts exposes no `off()` — the registration is permanent for the
    // process lifetime. handle.detach() drops the wire's local refs.
    return () => undefined
  },
})

/**
 * ADR-0404 + ADR-0415 — composition-root observability wire. Returns the wire
 * handle (4 ports + idempotent NO-THROW detach) when `QUANTA_OBSERVABILITY ===
 * "on"`; otherwise the noop handle (no port instances; no hook subscription).
 *
 * The helper is intentionally env-projecting (single canonical knob, strict
 * "on") so the wire itself stays env-agnostic. ADR-0415 closes the deliberate
 * Wave-3 hold: the optional `hookBus` (adapted from the surface's live
 * {@link HookBus}) is forwarded so run-ledger-attribution actually subscribes
 * to `post_tool_use` in production. Absent ⇒ ports still populate but
 * attribution is silently inert (legacy Wave-3 behavior, preserved for callers
 * that do not thread a bus).
 *
 * Default-OFF byte-identical: `QUANTA_OBSERVABILITY !== "on"` ⇒ noop handle
 * ⇒ every conditional spread at the call site sees `undefined` ⇒ slots OMITTED
 * ⇒ AgentConfig is byte-identical to the legacy path (RFC §1.2).
 */
export const resolveObservabilityWire = (
  env: NodeJS.ProcessEnv,
  opts: { readonly hookBus?: HookBus } = {},
): ObservabilityWireHandle =>
  wireObservability({
    enabled: gateOn(env, "QUANTA_OBSERVABILITY"),
    repoRoot: process.cwd(),
    // ADR-0415 — forward the adapted live bus so attribution subscribes to
    // `post_tool_use`. Omitted ⇒ ports populate, attribution stays inert.
    ...(opts.hookBus !== undefined ? { hookBus: toObservabilityHookBus(opts.hookBus) } : {}),
  })

/**
 * ADR-0415 — resolve the observability wire + project it into the conditional
 * AgentConfig slot fragment in ONE call. When `QUANTA_OBSERVABILITY === "on"`,
 * mints the canonical {@link HookBus} (the same bus the loop emits
 * `post_tool_use` to), wires attribution onto it, and returns the four ports
 * + the bus as `hooks`. Gate OFF ⇒ no bus is constructed and `slots` is `{}`
 * (byte-identical default-OFF; `base.hooks` stays untouched for the knobs
 * layer). Extracted from `buildBaseFromArgs` to keep that function under
 * biome's cognitive-complexity cap. Every field is presence-only.
 */
const resolveObservabilitySlots = (
  env: NodeJS.ProcessEnv,
): Partial<
  Pick<
    AssembleRequest["base"],
    "hooks" | "objective" | "runLedger" | "approvalStateMachine" | "shadowVerify"
  >
> => {
  const bus = gateOn(env, "QUANTA_OBSERVABILITY") ? new HookBus() : undefined
  const wire = resolveObservabilityWire(env, bus !== undefined ? { hookBus: bus } : {})
  return {
    ...(wire.objective !== undefined ? { objective: wire.objective } : {}),
    ...(wire.shadowVerify !== undefined ? { shadowVerify: wire.shadowVerify } : {}),
    ...(wire.runLedger !== undefined ? { runLedger: wire.runLedger } : {}),
    ...(wire.approvalStateMachine !== undefined
      ? { approvalStateMachine: wire.approvalStateMachine }
      : {}),
    ...(bus !== undefined ? { hooks: bus } : {}),
  }
}

/** ADR-0279 — composition-root automation slot. Returns `null` when
 *  `QUANTA_AUTOMATION !== "on"` (slot OMITTED; byte-identical legacy).
 *  When the env gate is on, constructs an `AutomationEngineSlot` over an
 *  in-memory engine + a stub `AgentLoopPort` that logs a warn line
 *  (mode-preset hosts can override the slot post-construction to wire
 *  their real agent loop). The stub keeps the engine + ticker active —
 *  runs + inbox are populated — but the dispatch is a no-op until the
 *  preset replaces the handler. */
const resolveAutomation = (env: NodeJS.ProcessEnv): AutomationEngineSlot | null => {
  // ADR-0453 jun-02 wire — the scheduler-path autorun-eligibility gate, built
  // from the SAME closed knob `QUANTA_AUTORUN_POLICY` the reactor uses. The
  // automation tick has no per-turn outcome, so `getPriorOutcome` is `()=>undefined`
  // (⇒ `on-failure` is always not-failed ⇒ blocks; the meaningful scheduler
  // policies are `always` (run) vs `never`/`on-request` (block)). Knob unset ⇒
  // resolver `undefined` ⇒ slot omits eligibility ⇒ tick byte-identical.
  const eligibility = buildAutorunEligibility(env, () => undefined)
  return assembleAutomation(
    { get: (k) => env[k] },
    {
      ...(eligibility !== undefined ? { eligibility } : {}),
      agentLoop: {
        enqueueUserMessage: async (_message: string): Promise<void> => {
          // Stub — the unified-agent base does not own an agent loop;
          // mode-preset hosts (e.g. the REPL) override this slot before
          // assembly. Fires that land here are recorded by the engine
          // (run + inbox rows) but do NOT reach a live loop. The warn
          // makes the gap observable.
          logger.warn(
            "automation handler invoked with stub agent loop — fire ignored. " +
              "A mode-preset must override `automationEngine.handler` with a " +
              "real `AgentLoopPort.enqueueUserMessage`.",
          )
        },
      },
    },
  )
}

const attachExecutionPlaneSlots = (
  base: AssembleRequest["base"],
  p: AssembleRequestPartial,
): void => {
  const delegation = resolveDelegation(base, p.delegateModes)
  if (delegation !== undefined) base.delegation = delegation

  const forkWire = resolveForkSession(p.forkSession)
  if (forkWire !== undefined) {
    base.conversationCheckpoint = forkWire.conversationCheckpoint
    base.fork = forkWire.fork
    base.forkSession = forkWire.forkSession
  }
}

/** Build the `AgentConfig` base from CLI args. Per-mode runners can override
 *  individual fields (e.g. ci-bot replaces `registry` with the restricted
 *  git+gh tool set), but having a baseline avoids each runner duplicating
 *  the LLM construction logic.
 *
 *  Provider pick + key lookup + adapter construction are delegated to the
 *  shared `@/llm` factory (OCP/DIP). `process.env` is handed to the factory
 *  HERE — the single composition-root touchpoint — so the factory stays env-
 *  agnostic and the canonical {@link DEFAULT_MODEL} (no local copy) is used. */
export const buildBaseFromArgs = (
  p: AssembleRequestPartial,
  /** T01 (audit L5 H-2): the REAL composition-root cancellation signal. The
   *  composition root (`runMain`) owns ONE controller and wires SIGINT to it
   *  once, then threads `controller.signal` here so every mode-preset inherits
   *  a live cancel point. When absent (non-`runMain` callers / older SDK seams)
   *  we still fall back to a fresh controller's signal, but production always
   *  injects the live one. */
  signal?: AbortSignal,
  /** L5 M-11 — out-collector for per-process teardown. When provided, the
   *  search wire's `dispose` (delta-scan `setInterval` + indexer) is pushed
   *  so the composition root (`runMain`) tears it down in its `finally`,
   *  threaded per-process instead of via the module singleton. Absent (older
   *  SDK seams / tests) ⇒ no disposer collected (behavior unchanged). */
  disposers?: Array<() => void>,
  /** Hermetic test seams (mirrors the H7 `seams?` precedent). Absent in
   *  production ⇒ every wire uses its REAL composition-layer backend, so the
   *  returned `base` is byte-identical for every existing caller. A test passes
   *  e.g. `{ ptyExec }` to drive the real pty composition + dispatch + permission
   *  path against a fake tmux at the leaf. */
  seams?: CompositionSeams,
): AssembleRequest["base"] => {
  // QUANTA_PROVIDER drives the factory pick; an explicit `--provider` flag must
  // still win, so seed it into the env view the factory reads.
  const env =
    p.provider !== undefined ? { ...process.env, QUANTA_PROVIDER: p.provider } : process.env
  const provider = pickProvider(env)
  // model omitted ⇒ factory fills canonical DEFAULT_MODEL[provider].
  const llm: LLMPort | null = tryCreateLLM(
    provider,
    p.model !== undefined ? { model: p.model } : {},
    env,
  )
  if (llm === null) {
    // ADR-0303 — this is host-layer launcher composition, NOT a surface, so it
    // must NOT own `process.exit` (terminal-defaults invariant). Throw a typed
    // error carrying the POSIX exit code; the surface entry (apps/agent `runMain`
    // / apps/cli batch) maps `exitCode` onto its own `process.exit`.
    throw new ProviderKeyMissingError(
      `no API key for provider '${provider}'. Set OPENAI_API_KEY or ANTHROPIC_API_KEY (or --provider <other>).`,
    )
  }
  // Minimal stream — error events surface via the shared logger so a wrapper
  // failure is diagnosable even when a runner doesn't replace the stream (the
  // host layer must not write `process.stderr` directly — terminal ownership is
  // a surface concern). Per-mode runners typically override with their own
  // observability (REPL stdout, structured JSONL, etc).
  const stream: StreamPort = {
    emit: (e: AgentEvent): void => {
      if (e.type === "error") {
        logger.error(`[stream-error] ${JSON.stringify(e)}`)
      }
    },
  }
  const retrievalStack = buildRetrievalStackFromEnv(env)
  // ADR-0277/0278 — product search surface wire. Generic repo search is
  // lexical by default and upgrades to hybrid when `QUANTA_INDEX=on`; an
  // explicit `QUANTA_PIPELINE=none` is the kill-switch. The returned tool is
  // registered into the base registry below, and the helper-only pipeline slot
  // is spread into AgentConfig for any future pipeline consumers.
  const searchWire = buildSearchPipelineFromEnv(env, process.cwd())
  // L5 M-11 — thread THIS process's wire teardown (delta-scan interval +
  // indexer) up to `runMain`'s `finally` via the disposer collector, instead
  // of relying on the module singleton. Idempotent; no-op when no wire built.
  if (searchWire !== null && disposers !== undefined) {
    disposers.push(() => searchWire.dispose())
  }
  // ADR-0236 identity wire — `--identity-mode <m>` (precedence #1) ⇒ build
  // via the mode-variant registry; else fall back to the ADR-0198
  // `QUANTA_IDENTITY=1` env (precedence #2); else empty-string sentinel
  // ⇒ each mode-preset's `req.base.system ?? buildSystemPrompt(cwd)`
  // fallback runs unchanged (byte-identical).
  const { system, identityModeVariant } = resolveIdentitySystemPrompt(p.identityMode, env)
  // ADR-0236 — composition-root mega-wire slots. All default-OFF: each helper
  // returns `undefined` when the operator did NOT opt in; spread conditionally
  // so `exactOptionalPropertyTypes` does NOT see a literal `undefined`.
  const stickyModelStore = resolveStickyModelStore(p.stickyModel)
  const toolProfile = resolveToolProfile(p.toolProfile)
  const focusChain = resolveFocusChain(p.focusChainEvery)
  // ADR-0279 — automation engine composition-root wire. Returns `null`
  // when `QUANTA_AUTOMATION !== "on"` (default-OFF byte-identical legacy);
  // when on, returns a fully-wired slot the loop-helpers ticker consumes
  // (ADR-0240). The default tools also gain `automation_update` when the
  // engine is present (ADR-0280; conditional registration below).
  const automationSlot = resolveAutomation(env)
  // ADR-0297 — composition-root projection of `QUANTA_SANDBOX` into the
  // bash tool factory's HITL tier. Pure: same env → same profile (or
  // `undefined` ⇒ tier degrades to `always-confirm`). The boot path
  // `installCliSandbox` reads the SAME env separately for the shell-
  // spawn wrapper; both reads share `resolveSandboxProfileFromEnv` so
  // they agree.
  const sandboxProfile = resolveSandboxProfileFromEnv(env)
  // ADR-0428 jun-02 wire — DIRECT env read of `QUANTA_NETWORK_PROXY` at the
  // composition root (mirrors `resolveMemoryConfigFromEnv`; this surface builds
  // its base WITHOUT `applyKnobs`). The helper returns a SPREAD-READY slot
  // (`{}` when off) so the base literal carries NO extra branch (keeps
  // `buildBaseFromArgs` under biome's cognitive-complexity cap). Sets
  // `base.networkProxy` so `runAgent` constructs the live `LoopbackEgressProxy`
  // and threads `proxyEnv` into the bash-tool child spawn. Absent / "0" / empty
  // ⇒ `{}` ⇒ slot omitted ⇒ NO proxy, child env byte-identical (RFC §1.2).
  const networkProxySlot = resolveNetworkProxySlot(env)
  // ADR-0452 jun-02 wire — `QUANTA_PREWARM` → `AgentConfig.prewarm` slot
  // (resolved by the extracted `resolvePrewarmSlot` helper; default-OFF).
  const prewarmSlot = resolvePrewarmSlot(env)
  // ADR-0404 + ADR-0415 — composition-root observability slots. Single helper
  // call: gate ON ⇒ mints the canonical HookBus (the same bus the loop emits
  // `post_tool_use` to), wires attribution onto it, and returns the four ports
  // + `hooks`. Gate OFF ⇒ `{}` (byte-identical legacy; the knobs layer still
  // owns the `QUANTA_BENCH_HOOKS` bus). One spread keeps `buildBaseFromArgs`
  // under biome's cognitive-complexity cap.
  const observabilitySlots = resolveObservabilitySlots(env)
  // Track A2 + GAP2 — composition-root named-permission-profile wiring, resolved
  // in ONE call (manager = forward-compat per-thread slot; mode = behavior-LIVE
  // PermissionContext override derived from the profile's approval pillar). Both
  // honor flag-wins precedence + fail-closed throw on an unknown name. Absent ⇒
  // both undefined ⇒ byte-identical legacy.
  const { managerSlot: permissionProfileSlot, mode: profilePermissionMode } =
    resolvePermissionProfileWiring(p.permissionProfile, env)
  // CLUSTER D #5 — BASELINE-SEED RESIDUAL CLOSED. Build ONE per-session
  // PatternGrantStore + its no-widen propose port (default-OFF: `undefined`
  // unless QUANTA_REMEMBER_PATTERNS=1). The SAME store is threaded into BOTH
  // `buildBaseRegistry` (the `permission_propose_pattern` tool) AND
  // `AgentConfig.permissionPatternStore` (the admissibility-gate). The gate
  // grows the store's BASELINE via user approvals (`store.grant`); the propose
  // tool refines within it via `store.recordProposed` (no-widen). Absent ⇒ the
  // store slot is omitted (no auto-pass, no cascade) AND the tool is absent —
  // byte-identical to today's no-pattern behaviour.
  const permissionPatternSlice = resolvePermissionPatternSlice()
  // file_history_rewind — mint the SHARED per-file snapshot slice ONCE (store +
  // sink over the same store) when QUANTA_FILE_HISTORY is on. The store wires the
  // `file_history_rewind` tool (read side, via buildBaseRegistry → buildGatedToolPorts);
  // the sink wires `AgentConfig.fileHistory` (write side, the write/edit capture).
  // Absent ⇒ both omitted ⇒ no capture, no tool — byte-identical.
  const fileHistorySlice = resolveFileHistorySlice()
  // ADR-0236 — `--no-auto-background`: future hosts that wire `autoBackground`
  // by default can call `resolveAutoBackgroundOverride(p.noAutoBackground)` to
  // hard-force the slot OFF. Today no host defaults it on, so the flag has no
  // immediate effect — it lives in the parsed args so a follow-up host can
  // consume `p.noAutoBackground` to skip its own wiring. Documented for
  // forward-compat; absent on the returned base.
  const base: AssembleRequest["base"] = {
    llm,
    // DIP: route through the factory (no app-specific ports at this baseline
    // entry — modes/CLI wire their own fs/diagnostics ports). Behavior is
    // byte-identical to the `defaultTools` singleton.
    registry: buildBaseRegistry({
      env,
      automationSlot,
      sandboxProfile,
      searchWire,
      seams,
      permissionPatternSlice,
      fileHistorySlice,
      llm,
    }),
    stream,
    // GAP2 — when a named permission profile is selected the live permission
    // mode is DERIVED from its approval pillar; absent ⇒ the historical
    // `acceptEdits` default (byte-identical).
    permission: { mode: profilePermissionMode ?? "acceptEdits" },
    messages: [],
    system,
    cwd: process.cwd(),
    maxTurns: p.dials?.maxTurns ?? 30,
    // T01 (audit L5 H-2): use the composition-root's REAL cancellation signal
    // when injected (SIGINT-wired in `runMain`). The `?? new AbortController()`
    // is NOT a live-path placeholder — it is the fallback only for callers that
    // construct a base without a composition root (kept so the field stays
    // typed-required). Production always passes the live signal.
    signal: signal ?? new AbortController().signal,
    // ADR-0159 wire: when the operator opted in (QUANTA_RETRIEVAL_HYBRID=1),
    // hand the surface-built stack to every mode runner via the shared base.
    // Absent ⇒ slot is omitted entirely (`exactOptionalPropertyTypes` → no
    // `undefined` literal on the config) and the loop is byte-identical.
    // ADR-0428 jun-02 wire — default-OFF socket-level egress proxy. The slot is
    // `{}` when off (resolved above), so this spread adds no branch here.
    ...networkProxySlot,
    ...(retrievalStack !== undefined ? { retrievalStack } : {}),
    // ADR-0277/0278 — helper-only search pipeline slot. The loop does not read
    // it directly; surfaces/tooling consume the registered `search_codebase`
    // tool, and future retrieval-aware helpers may use the same pipeline.
    ...(searchWire !== null ? { searchPipeline: searchWire.pipeline } : {}),
    // ADR-0236 — composition-root mega-wire slots (default-OFF; spread
    // conditionally to preserve `exactOptionalPropertyTypes`).
    ...(identityModeVariant !== undefined ? { identityModeVariant } : {}),
    ...(stickyModelStore !== undefined ? { stickyModelStore } : {}),
    ...(toolProfile !== undefined ? { toolProfile } : {}),
    ...(focusChain !== undefined ? { focusChain } : {}),
    // ADR-0452 — spread-ready prewarm slot (`{}` when off ⇒ no branch here,
    // keeps `buildBaseFromArgs` under biome's cognitive-complexity cap).
    ...prewarmSlot,
    // ADR-0455 — spread-ready local-env slot resolved at the (async) root and
    // carried on the partial (`{}` when absent ⇒ ambient env byte-identical;
    // shell.ts applies it via the existing `applyLocalEnv` seam, allowlist-
    // governed).
    ...localEnvSlotOf(p),
    // Named-agent registry resolver loaded at the (async) root and carried on the
    // partial (`{}` when absent ⇒ spawn path byte-identical; the subagent runner
    // reads it off `AgentConfig.namedAgentResolver` and an absent resolver / empty
    // registry never matches a spawn).
    ...namedAgentResolverSlotOf(p),
    // ADR-0279 — spread the automation slot conditionally (default-OFF;
    // `exactOptionalPropertyTypes` — no `undefined` literal on the config).
    ...(automationSlot !== null ? { automationEngine: automationSlot } : {}),
    // ADR-0404 + ADR-0415 — composition-root observability slots (objective +
    // shadowVerify + the ADR-0413-promoted runLedger / approvalStateMachine +
    // the canonical `hooks` bus attribution subscribed to). Default-OFF: `{}`
    // when `QUANTA_OBSERVABILITY !== "on"` ⇒ AgentConfig byte-identical legacy.
    ...observabilitySlots,
    // Track A2 — publish the named-permission-profile manager so a future loop
    // consumer can read the per-thread layered policy. Default-OFF: absent ⇒
    // slot omitted (`exactOptionalPropertyTypes` — no `undefined` literal).
    ...permissionProfileSlot,
    // CLUSTER D #5 — share the SAME PatternGrantStore the propose tool received
    // (via `buildBaseRegistry` above) with the admissibility-gate. The gate
    // writes the user/policy baseline via `cascadeOnApprove` → `grantAndCascade`
    // → `store.grant(...)` on a user approval, and reads coverage via
    // `autoPassByPatterns`. The propose tool can therefore only refine what the
    // user already approved. Spread-ready slot (`{}` when off ⇒ no branch here ⇒
    // gate byte-identical: no auto-pass, no cascade). `permissionAllowDangerous`
    // stays unset ⇒ dangerous actions ALWAYS go through the reviewer.
    ...permissionPatternStoreSlot(permissionPatternSlice),
    // file_history_rewind — surface the capture sink so the dispatch seam threads
    // it onto `ctx.fileHistory`; write/edit then record each new file version into
    // the SAME store `file_history_rewind` reads. `{}` when off ⇒ no branch here ⇒
    // `ctx.fileHistory` absent ⇒ capture is a no-op (byte-identical).
    ...fileHistorySinkSlot(fileHistorySlice),
  }

  attachExecutionPlaneSlots(base, p)
  // ADR-0454 — install disk-configured command hooks onto base.hooks (default-OFF
  // unless QUANTA_COMMAND_HOOKS=1 + acknowledgedRisk + bindings; see helper).
  installCommandHooksIntoBase(base, env, p.commandHookBindings)
  // jun-02 — fold the three INTERACTIVE knobs (advisor / task-budget /
  // compose-authoring) directly at the composition root, reusing each knob's
  // own parse+apply so the env→config semantics match the matrix. Without this
  // the knobs were DEAD on the live agent surface (`applyKnobs` is bench-only).
  // Uses the SAME `env` view the rest of `buildBaseFromArgs` reads (so an
  // explicit `--provider` seed is honoured); absent env ⇒ `base` unchanged.
  const wired = wireInteractiveKnobs(base, env, knobSurfaceForMode(p.mode))
  return wireOptionalAgentPorts(wired, process.env)
}

/**
 * What `index.ts` hands a mode-preset: a partial AssembleRequest (no `base` —
 * the preset constructs its own surface-specific base) plus the mode-specific
 * fields lifted off {@link AgentArgs}. The preset is responsible for building
 * `AssembleRequest.base` and calling `assembleAgentConfig`.
 */
export interface AssembleRequestPartial {
  mode: AssembleRequest["mode"]
  dials: AssembleRequest["dials"]
  exhaustion?: AssembleRequest["exhaustion"]
  model?: string
  provider?: "openai" | "anthropic"
  prompt?: string
  corpus?: string
  instance?: string
  predictions?: string
  report?: string
  pr?: string
  /** ci-bot only: stub the PR comment write at the runner edge. */
  ciBotDryRun?: boolean
  /** P26 headless `--output-format <text|json|stream-json>` — lifted onto
   *  `HeadlessExtras.output` by `applyModeSpecificRequestFields`. Absent ⇒ slot
   *  omitted ⇒ legacy human-text stdout (byte-identical). */
  outputFormat?: import("@/host/runtime/agent-args").OutputFormatToken
  /** P26 headless `--include-partial` — lifted onto `HeadlessExtras.includePartial`
   *  (only valid alongside a json/stream-json output format; parser enforced).
   *  Absent ⇒ slot omitted ⇒ milestone events only. */
  includePartial?: boolean
  /** ADR-0236 composition-root mega-wire — propagated into base via
   *  `buildBaseFromArgs`. Each defaults to OFF; absent ⇒ slot omitted. */
  toolProfile?: import("@/host/runtime/agent-args").ToolProfileToken
  stickyModel?: boolean
  identityMode?: import("@/host/runtime/agent-args").IdentityModeToken
  focusChainEvery?: number
  noAutoBackground?: boolean
  /** ADR-0236 / ADR-0218 — closed list of delegation modes the surface
   *  exposes via the composition-root delegation port. Absent / empty ⇒
   *  slot omitted (default-OFF). */
  delegateModes?: ReadonlyArray<DelegationAgentMode>
  /** ADR-0236 / ADR-0226 — opt-in to wire the rich fork-session port. The
   *  default impl returns `Err("fork-not-configured")` until a host threads
   *  a `ConversationCheckpointStore`-backed base forker. Absent / false ⇒
   *  slot omitted (default-OFF). */
  forkSession?: boolean
  /** ADR-0301 — CLI `--playbook-trigger` flag echo. When `true`, the surface
   *  host's `maybeStartPlaybookTriggerWire` opts in to the inline-trigger
   *  watcher even if `QUANTA_PLAYBOOK_TRIGGER` is unset. Env `=on` still wins
   *  over flag=false (precedence enforced inside the wire helper). Absent ⇒
   *  slot omitted (default-OFF byte-identical, RFC §1.2). */
  playbookTrigger?: boolean
  /** Track A2 — named permission profile selected via the
   *  `--permission-profile` flag. The env knob `QUANTA_PERMISSION_PROFILE` is
   *  resolved separately inside `buildBaseFromArgs` (flag WINS over env).
   *  Absent (no flag, no env) ⇒ no profile manager wired (default-OFF). */
  permissionProfile?: import("@/host/runtime/agent-args").PermissionProfileToken
  /** ADR-0455 jun-02 wire — the resolved local-environment selection, loaded
   *  from `.quanta/environment.toml` at the (async) composition root
   *  (`runMain`) and threaded onto the SYNC `buildBaseFromArgs` via this field
   *  (so the loader's async directory-walk never forces the base builder
   *  async). Absent ⇒ no config found / no env selected ⇒ slot omitted ⇒
   *  ambient env byte-identical. */
  localEnv?: LocalEnvSelection
  /** ADR-0454 jun-02 wire — command-hook bindings parsed from
   *  `settings.json#hooks`, loaded async at the (async) root (`runMain`) ONLY
   *  when `QUANTA_COMMAND_HOOKS=1`, and threaded onto the SYNC
   *  `buildBaseFromArgs`. Absent ⇒ no command hooks installed (default-OFF). */
  commandHookBindings?: readonly CommandHookBinding[]
  /** Named-agent registry resolver loaded ONCE per session from `.quanta/agents`
   *  (+ native dir) at the (async) composition root (`runMain` calls
   *  `loadNamedAgents(cwd)`), threaded onto the SYNC `buildBaseFromArgs` (whose
   *  builder is sync, mirroring `localEnv`). `buildBaseFromArgs` lifts it onto
   *  `AgentConfig.namedAgentResolver`, which the subagent runner consults per
   *  spawn. Absent (no `.quanta/agents` dir ⇒ empty registry ⇒ not threaded, or
   *  an unreadable dir caught fail-open) ⇒ slot omitted ⇒ spawn path
   *  byte-identical. */
  namedAgentResolver?: import("@/agent").NamedAgentResolver
}

/** ADR-0236 + ADR-0301 — propagate the composition-root mega-wire flags
 *  (and the new playbook-trigger CLI flag echo) onto the lifted projection.
 *  Extracted out of {@link toAssembleRequest} so that function stays under
 *  biome's `noExcessiveCognitiveComplexity` cap (≤15) as more wire flags
 *  accumulate. Each spread is presence-only (absent ⇒ slot omitted; default-
 *  OFF byte-identical under `exactOptionalPropertyTypes`). */
const liftMegaWireFields = (args: AgentArgs, out: AssembleRequestPartial): void => {
  if (args.toolProfile !== undefined) out.toolProfile = args.toolProfile
  if (args.stickyModel) out.stickyModel = true
  if (args.identityMode !== undefined) out.identityMode = args.identityMode
  if (args.focusChainEvery !== undefined) out.focusChainEvery = args.focusChainEvery
  if (args.noAutoBackground) out.noAutoBackground = true
  // Track A2 — echo the parsed `--permission-profile` flag. The env-or-flag
  // resolution + fail-closed validation happens in `buildBaseFromArgs`; here
  // we only carry the (already-validated) flag token onto the projection.
  if (args.permissionProfile !== undefined) out.permissionProfile = args.permissionProfile
  // ADR-0301 — echo the parsed CLI flag onto the lifted projection so any
  // mode-preset host that consumes `AssembleRequestPartial.playbookTrigger`
  // can thread it down to `maybeStartPlaybookTriggerWire({ cliFlag })`.
  // Default-OFF: absent flag ⇒ `args.playbookTrigger === undefined`, slot
  // OMITTED on the projection (RFC §1.2 byte-identical).
  if (args.playbookTrigger === true) out.playbookTrigger = true
}

/** Lift mode + dials + per-mode fields out of `AgentArgs`. Pure projection. */
export const toAssembleRequest = (args: AgentArgs): AssembleRequestPartial => {
  const out: AssembleRequestPartial = {
    mode: args.mode,
    dials: args.dials,
  }
  if (args.exhaustion !== undefined) out.exhaustion = args.exhaustion
  if (args.model !== undefined) out.model = args.model
  if (args.provider !== undefined) out.provider = args.provider
  if (args.prompt !== undefined) out.prompt = args.prompt
  if (args.corpus !== undefined) out.corpus = args.corpus
  if (args.instance !== undefined) out.instance = args.instance
  if (args.predictions !== undefined) out.predictions = args.predictions
  if (args.report !== undefined) out.report = args.report
  if (args.pr !== undefined) out.pr = args.pr
  if (args.ciBotDryRun) out.ciBotDryRun = true
  // P26 — echo the headless structured-output flags onto the projection;
  // `applyModeSpecificRequestFields` folds them into `out.headless`. Absent ⇒
  // slot omitted (byte-identical text path).
  if (args.outputFormat !== undefined) out.outputFormat = args.outputFormat
  if (args.includePartial) out.includePartial = true
  // ADR-0236 + ADR-0301 — extracted helper keeps this function under the
  // biome cognitive-complexity cap.
  liftMegaWireFields(args, out)
  return out
}
