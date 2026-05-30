/**
 * `apps/agent/index.ts` — RFC may-22-unified-agent-runtime / Phase 4 entry.
 *
 * The single argv→mode dispatcher. Owns ZERO mode wiring: each mode-preset
 * module under `./mode-presets/<mode>.ts` exports its own `runMode(req)` and
 * builds its own surface-specific AgentConfig core. The entry just routes.
 *
 * Hard rules (RFC may-22 / Phase 4):
 *  • NO scattered `process.env.X` reads here. `runtimeConfig()` owns the
 *    typed env knobs; provider/key resolution is delegated to the `@/llm`
 *    factory, which receives `process.env` ONCE at this composition root
 *    (the factory itself never touches the global env — see factory.ts).
 *  • NO silent defaults. Defaults flow from `BUDGET_PRESETS` via
 *    `assembleAgentConfig`, not from this file.
 *  • mode-presets are loaded via DYNAMIC import so this file is decoupled
 *    from Worker B's per-mode wiring contract (different presets ship at
 *    different times).
 *
 * Exit codes are owned by `./run.ts` (POSIX-style); this file only emits
 *   • exit 64 (EX_USAGE) on argv error, plus a usage dump to stderr;
 *   • exit 0 on `--help` (after a usage dump to stdout).
 */

import {
  buildRetrievalStackCore,
  buildSearchPipelineFromEnv,
  clearSearchPipelineWireForTests,
  parseEnvFlag,
  type RetrievalStack,
} from "@/runner/assemble"
import { resolveSandboxProfileFromEnv } from "@/runtime"
import { loadEnvFiles } from "@/shared/env-files"

loadEnvFiles([".env.dev", ".env.local", ".env"])

import { buildSystemPrompt, HookBus, wireOptionalAgentPorts } from "@/agent"
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
import { type LLMPort, pickProvider, tryCreateLLM } from "@/llm"
import { type CapabilityNegotiator, defaultNegotiator, fullNegotiator } from "@/mcp"
import { type AutomationEngineSlot, assembleAutomation } from "@/scheduler/runtime-wire"
import { errMessage, logger, runtimeConfig, setTerminalIo } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { buildDefaultTools, ToolRegistry } from "@/tool"
import type { AssembleRequest } from "./assemble"
import {
  type AgentArgs,
  AgentArgsError,
  formatHelp,
  type IdentityModeToken,
  parseAgentArgs,
  type ToolProfileToken,
} from "./cli-args"

export { buildSearchPipelineFromEnv, clearSearchPipelineWireForTests }

import type { RunOutcome } from "./run"

setTerminalIo({
  stdout: (chunk) => {
    void process.stdout.write(chunk)
  },
  stderr: (chunk) => {
    void process.stderr.write(chunk)
  },
  stdoutIsTTY: process.stdout.isTTY,
  stderrIsTTY: process.stderr.isTTY,
})

/** ADR-0198 identity slot — resolve the per-mode identity from the
 *  composition-root env view. Default-OFF: returns `undefined` unless
 *  `QUANTA_IDENTITY=1`. When opted in, `QUANTA_IDENTITY_MODE` selects the
 *  posture (default / plan / review / audit / onboarding); absent ⇒
 *  `"default"`. The single canonical env touchpoint for identity wiring
 *  in the unified-agent surface; mode-presets read `req.base.system` and
 *  never touch the env themselves. */
const resolveIdentityFromEnv = (env: NodeJS.ProcessEnv): readonly string[] | undefined => {
  if (env.QUANTA_IDENTITY !== "1") return undefined
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
  env.QUANTA_RETRIEVAL_HYBRID === "1"

/** ADR-0196 — pick the MCP capability negotiator from env. `QUANTA_MCP_CAPS=full`
 *  swaps to {@link fullNegotiator} which advertises `{tools, sampling,
 *  elicitation, tasks}`. Any other value (including absent) yields the
 *  byte-identical `{}` default. Single canonical knob; no aliases. */
export const pickMcpNegotiator = (env: NodeJS.ProcessEnv): CapabilityNegotiator =>
  env.QUANTA_MCP_CAPS === "full" ? fullNegotiator() : defaultNegotiator

const buildBaseRegistry = (args: {
  readonly automationSlot: AutomationEngineSlot | null
  readonly sandboxProfile: ReturnType<typeof resolveSandboxProfileFromEnv>
  readonly searchWire: ReturnType<typeof buildSearchPipelineFromEnv>
}): ToolRegistry =>
  new ToolRegistry([
    ...buildDefaultTools({
      ...(args.automationSlot !== null ? { automationEngine: args.automationSlot.engine } : {}),
      ...(args.sandboxProfile !== undefined ? { sandboxProfile: args.sandboxProfile } : {}),
    }),
    ...(args.searchWire !== null ? [args.searchWire.tool] : []),
  ])

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
  try {
    return { store: fsBackedStickyModelStore() }
  } catch (e) {
    // Defense-in-depth: a corrupted home dir or read-only fs should NOT
    // crash the agent surface — fall back to in-memory and log. The store
    // becomes process-scoped (no persistence across runs) but the agent runs.
    logger.warn(`sticky-model fs store unavailable (${errMessage(e)}); falling back to in-memory.`)
    return { store: inMemoryStickyModelStore() }
  }
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
    enabled: env.QUANTA_OBSERVABILITY === "on",
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
  const bus = env.QUANTA_OBSERVABILITY === "on" ? new HookBus() : undefined
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
  return assembleAutomation(
    { get: (k) => env[k] },
    {
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
    logger.error(
      `no API key for provider '${provider}'. Set OPENAI_API_KEY or ANTHROPIC_API_KEY (or --provider <other>).`,
    )
    process.exit(2)
  }
  // Minimal stream — error events surface to stderr so a wrapper failure is
  // diagnosable even when a runner doesn't replace the stream. Per-mode
  // runners typically override with their own observability (REPL stdout,
  // structured JSONL, etc).
  const stream: StreamPort = {
    emit: (e: AgentEvent): void => {
      if (e.type === "error") {
        process.stderr.write(`[stream-error] ${JSON.stringify(e)}\n`)
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
  // ADR-0404 + ADR-0415 — composition-root observability slots. Single helper
  // call: gate ON ⇒ mints the canonical HookBus (the same bus the loop emits
  // `post_tool_use` to), wires attribution onto it, and returns the four ports
  // + `hooks`. Gate OFF ⇒ `{}` (byte-identical legacy; the knobs layer still
  // owns the `QUANTA_BENCH_HOOKS` bus). One spread keeps `buildBaseFromArgs`
  // under biome's cognitive-complexity cap.
  const observabilitySlots = resolveObservabilitySlots(env)
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
    registry: buildBaseRegistry({ automationSlot, sandboxProfile, searchWire }),
    stream,
    permission: { mode: "acceptEdits" },
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
    // ADR-0279 — spread the automation slot conditionally (default-OFF;
    // `exactOptionalPropertyTypes` — no `undefined` literal on the config).
    ...(automationSlot !== null ? { automationEngine: automationSlot } : {}),
    // ADR-0404 + ADR-0415 — composition-root observability slots (objective +
    // shadowVerify + the ADR-0413-promoted runLedger / approvalStateMachine +
    // the canonical `hooks` bus attribution subscribed to). Default-OFF: `{}`
    // when `QUANTA_OBSERVABILITY !== "on"` ⇒ AgentConfig byte-identical legacy.
    ...observabilitySlots,
  }

  attachExecutionPlaneSlots(base, p)
  return wireOptionalAgentPorts(base)
}

const applyModeSpecificRequestFields = (out: AssembleRequest, p: AssembleRequestPartial): void => {
  if (p.mode === "headless" && p.prompt !== undefined) {
    out.headless = { prompt: p.prompt }
    return
  }
  if (p.mode === "batch" && p.corpus !== undefined) {
    out.batch = {
      corpus: p.corpus,
      ...(p.instance !== undefined ? { instance: p.instance } : {}),
      ...(p.predictions !== undefined ? { predictionsPath: p.predictions } : {}),
      ...(p.report !== undefined ? { reportPath: p.report } : {}),
    }
    return
  }
  if (p.mode === "ci-bot" && p.pr !== undefined) {
    out.ciBot = { pr: p.pr, ...(p.ciBotDryRun ? { dryRun: true } : {}) }
  }
}

/** Per-mode dispatcher contract. Each `./mode-presets/<mode>.ts` exports this. */
export interface ModeDispatcher {
  runMode: (req: AssembleRequest) => Promise<RunOutcome>
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
  /** ADR-0236 composition-root mega-wire — propagated into base via
   *  `buildBaseFromArgs`. Each defaults to OFF; absent ⇒ slot omitted. */
  toolProfile?: import("./cli-args").ToolProfileToken
  stickyModel?: boolean
  identityMode?: import("./cli-args").IdentityModeToken
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
  // ADR-0236 + ADR-0301 — extracted helper keeps this function under the
  // biome cognitive-complexity cap.
  liftMegaWireFields(args, out)
  return out
}

/**
 * Test seam — `runMain` accepts injected `argv`, `loadDispatcher`, and IO
 * sinks so unit tests can route to spy dispatchers without forking a process.
 */
export interface MainDeps {
  argv?: readonly string[]
  loadDispatcher?: (mode: AssembleRequest["mode"]) => Promise<ModeDispatcher>
  stdout?: (s: string) => void
  stderr?: (s: string) => void
  exit?: (code: number) => void
  /** T01 (audit L5 H-2): test seam to inject the cancellation signal instead of
   *  letting `runMain` own a SIGINT-wired controller. Tests that don't want a
   *  real `process.on("SIGINT")` side effect pass their own signal here. */
  signal?: AbortSignal
}

/** Default loader — dynamic import keeps `index.ts` decoupled from preset shape. */
const defaultLoadDispatcher = async (mode: AssembleRequest["mode"]): Promise<ModeDispatcher> => {
  const mod = (await import(`./mode-presets/${mode}`)) as ModeDispatcher
  return mod
}

/**
 * The entry function. Pure routing — every effectful concern (IO, exit) is
 * injectable via {@link MainDeps}. Production caller at the bottom of this
 * file wires the defaults: real argv, dynamic import, stdout/stderr writers,
 * `process.exit`.
 */
export const runMain = async (deps: MainDeps = {}): Promise<void> => {
  // Touch runtimeConfig once so any startup-validation env errors surface
  // here (not deep inside a mode-preset). Result is intentionally unused —
  // we only want the validator side-effect of `loadFromEnv`. This is the
  // ONLY env touchpoint in this file, and it goes through `@/shared`.
  runtimeConfig()

  const argv = deps.argv ?? process.argv.slice(2)
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s))
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s))
  const exit = deps.exit ?? ((code) => process.exit(code))
  const loadDispatcher = deps.loadDispatcher ?? defaultLoadDispatcher

  let args: AgentArgs
  try {
    args = parseAgentArgs(argv)
  } catch (e) {
    if (e instanceof AgentArgsError) {
      stderr(`${e.message}\n${formatHelp()}\n`)
      exit(64) // POSIX EX_USAGE
      return
    }
    throw e
  }

  if (args.help) {
    stdout(formatHelp())
    return
  }

  const dispatcher = await loadDispatcher(args.mode)
  const partial = toAssembleRequest(args)

  // T01 (audit L5 H-2 / M-6): the composition root owns ONE real cancellation
  // controller and wires SIGINT to it exactly once — previously every preset
  // inherited a dead `new AbortController().signal` so Ctrl+C was silently
  // ignored in 5 of 6 modes. Tests inject `deps.signal` to avoid the real
  // `process.on` side effect; production installs the handler and detaches it
  // in `finally` so a long-lived host process never leaks listeners.
  let owned: AbortController | undefined
  let signal: AbortSignal
  let onSigint: (() => void) | undefined
  if (deps.signal !== undefined) {
    signal = deps.signal
  } else {
    owned = new AbortController()
    signal = owned.signal
    onSigint = (): void => owned?.abort()
    process.on("SIGINT", onSigint)
  }

  // Translate flat CLI shape → nested AssembleRequest the runners consume
  // (each runner reads its own mode-specific extras: req.headless / req.batch
  // / req.ciBot). The `base` is a stub — runners build the real AgentConfig
  // internally; assemble.ts only needs `base` populated for modePolicy +
  // budgetMeter, which the runners assemble themselves.
  const fullReq = liftToAssembleRequest(partial, signal)
  try {
    const outcome = await dispatcher.runMode(fullReq)
    exit(outcome.exitCode)
  } finally {
    if (onSigint !== undefined) process.off("SIGINT", onSigint)
  }
}

/** Translate the flat CLI projection to the nested AssembleRequest shape
 *  the mode runners consume. Per-mode extras are populated only for the
 *  active mode; other slots stay undefined. The `base` is populated with
 *  an LLM built from provider/model (operator flags + env API keys) so the
 *  per-mode runner can rely on `req.base.llm` being a real adapter. */
const liftToAssembleRequest = (
  p: AssembleRequestPartial,
  signal?: AbortSignal,
): AssembleRequest => {
  const base = buildBaseFromArgs(p, signal)
  const out: AssembleRequest = { mode: p.mode, base }
  if (p.dials !== undefined) out.dials = p.dials
  if (p.exhaustion !== undefined) out.exhaustion = p.exhaustion
  applyModeSpecificRequestFields(out, p)
  return out
}

// Production entry — only fires when this module is the process entry point.
// We guard so `import "./index"` in tests does NOT trigger the real loop.
// `import.meta.main` is the Bun-native check (also true under `bun run`).
if (import.meta.main) {
  runMain().catch((e) => {
    process.stderr.write(`fatal: ${errMessage(e)}\n`)
    process.exit(1)
  })
}
