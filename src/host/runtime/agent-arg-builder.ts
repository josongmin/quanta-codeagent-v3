import { buildSystemPrompt, wireOptionalAgentPorts } from "@/agent"
import type { CommandHookBinding } from "@/agent/command-hooks"
import { defaultDelegationRunner } from "@/agent/delegation-runner"
import { defaultFocusChainTracker, type FocusChainPort } from "@/agent/focus-chain"
import type { ForkSessionPort } from "@/agent/fork-session"
import { defaultCheckpointBaseWire } from "@/agent/fork-session-wire"
import { defaultIdentityProvider, type IdentityMode } from "@/agent/identity"
import {
  fsBackedStickyModelStore,
  inMemoryStickyModelStore,
  type StickyModelStore,
} from "@/agent/sticky-model"
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
import type { AgentArgs, IdentityModeToken, ToolProfileToken } from "@/host/runtime/agent-args"
import type { AssembleRequest } from "@/host/runtime/agent-config-assembler"
import { type LLMPort, pickProvider, tryCreateLLM } from "@/llm"
import { type CapabilityNegotiator, defaultNegotiator, fullNegotiator } from "@/mcp"
import { buildAutorunEligibility } from "@/permission"
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
import { errMessage, gateDisabled, gateOn, logger } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { installCommandHooksIntoBase } from "./agent-arg-builder/command-hooks-wire"
import {
  buildBaseRegistry,
  type CompositionSeams,
  fileHistorySinkSlot,
  permissionPatternStoreSlot,
  resolveFileHistorySlice,
  resolvePermissionPatternSlice,
} from "./agent-arg-builder/gated-tool-ports"
import { resolveObservabilitySlots } from "./agent-arg-builder/observability-wire"
import { resolvePermissionProfileWiring } from "./agent-arg-builder/permission-profile"

export { installCommandHooksIntoBase } from "./agent-arg-builder/command-hooks-wire"
// ADR-0303 god-module split — re-export the relocated composition-root clusters'
// COMPLETE public surface so every `@/host/runtime/agent-arg-builder` importer
// (the `index.ts` barrel, `apps/agent`, and the unit/hellgate tests) resolves
// these symbols byte-compatibly. The definitions now live in the `agent-arg-builder/`
// sibling directory; this file keeps the keystone `buildBaseFromArgs` + the
// argv-projection helpers.
export {
  buildBaseRegistry,
  type CompositionSeams,
  type FileHistorySlice,
  type PermissionPatternSlice,
  resolveFileHistorySlice,
  resolvePermissionPatternSlice,
} from "./agent-arg-builder/gated-tool-ports"
export { resolveObservabilityWire } from "./agent-arg-builder/observability-wire"
export {
  buildProfileDefinitionRegistry,
  PERMISSION_PROFILE_SESSION_THREAD,
  resolveLayeredProfileSlots,
  resolvePermissionModeFromProfile,
  resolvePermissionProfileManager,
  resolvePolicyMergeStrategy,
} from "./agent-arg-builder/permission-profile"

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

// RFC jun-17 (code-intelligence warm backend) — project `QUANTA_LSP_PREWARM`
// into `AgentConfig.lspPrewarm`. DEFAULT-ON, but GATED on the nav tools actually
// being exposed (`QUANTA_LSP_TOOLS=full`, matching `resolveLspNavMode`, OR the
// bench-only `QUANTA_BENCH_LSP`) — warming a server whose tools are not
// registered is wasted work, so with nav OFF the slot is omitted (byte-identical
// legacy). With nav ON the warm fires unless explicitly killed via
// `QUANTA_LSP_PREWARM=0` (`gateDisabled` off-switch, also the bench A/B cold
// arm). The session signal is not available at config-build time, so
// `warmSignal` is left to the (bench-side) caller; the orchestrator
// self-terminates via evict / idle-TTL.
const resolveLspPrewarmSlot = (
  env: NodeJS.ProcessEnv,
): { lspPrewarm?: NonNullable<AssembleRequest["base"]["lspPrewarm"]> } => {
  const navEnabled = env.QUANTA_LSP_TOOLS === "full" || gateOn(env, "QUANTA_BENCH_LSP")
  if (!navEnabled || gateDisabled(env, "QUANTA_LSP_PREWARM")) return {}
  return { lspPrewarm: { enabled: true } }
}

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

/** ADR-0236 / jun-11 (#4) — wire the sticky-model store slot. The default is now
 *  an IN-MEMORY store so `/model` switches the model IN-SESSION out of the box
 *  (no `--sticky-model` flag required — previously this returned `undefined`, so
 *  `buildModelAdapterWire` returned `{}` and `/model` printed "not wired"). The
 *  store is INERT until set: an empty store's `get()` returns `undefined`, so the
 *  per-turn model resolver (`skill-gate#readStickyModelForMode`) falls back to the
 *  boot model — byte-identical for any surface that never calls `/model`
 *  (headless / one-shot included). `--sticky-model` upgrades to the fs-backed
 *  store (`~/.quanta/sticky-model.json`) for cross-session PERSISTENCE.
 *
 *  Exported for unit testing. Return type keeps `| undefined` so existing
 *  call-site undefined-guards stay valid (the default simply never returns it). */
export const resolveStickyModelStore = (
  stickyModel: boolean | undefined,
): { readonly store: StickyModelStore } | undefined => {
  // fs-backed construction is IO-free (it only computes its path; all fs access
  // is deferred to get/set/load), so it cannot throw here — a read-only fs or
  // corrupt home dir surfaces as a TYPED result at the call site (get/load
  // degrade to the global default; set returns a `StickyModelWriteError` that
  // `/sticky-model` renders). In-memory set/get round-trips in process and is
  // dropped on exit (no persistence) — exactly the session-scoped default.
  return { store: stickyModel === true ? fsBackedStickyModelStore() : inMemoryStickyModelStore() }
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
  // RFC jun-17 — `QUANTA_LSP_PREWARM` → `AgentConfig.lspPrewarm` slot (double-
  // gated on the nav tools being enabled; default-OFF).
  const lspPrewarmSlot = resolveLspPrewarmSlot(env)
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
    ...lspPrewarmSlot,
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
