import {
  type AgentConfig,
  lspDiagnosticsTool,
  lspNavToolList,
  type PersonaKind,
  resolvePersona,
} from "@/agent"
import { identityForToken } from "@/agent/identity"
import { buildAsyncDeferredTools } from "@/host/runtime/agent-arg-builder/gated-tool-ports"
import type { CredentialSource, LLMPort } from "@/llm"
import { anyLspServerOnPath } from "@/lsp"
import { Metrics, type StructuredLogger } from "@/observability"
import type { PermissionContext, PermissionMode } from "@/permission"
import {
  buildCompactionBreakerConfigCore,
  buildCredentialSource,
  buildLLMWithByokCore,
  buildMainLLMCore,
  buildMemoryForSession,
  buildSearchPipelineFromEnv,
  buildSkillsConfigCore,
  buildStreamingCore,
  buildSubagentConfigCore,
  buildSummarizerLlmCore,
  buildToolingCore,
  buildVerifyGuardConfigCore,
  composeLLMCore,
  DEFAULT_MODEL,
  type MainLlmAssembleInput,
  parseFallbackModels,
  parseRecallTiers,
  pickProviderCore,
  type ResolvedEndpoint,
  type Provider as RunnerProvider,
  selectLlmTransport,
} from "@/runner/assemble"
import type { Tooling } from "@/runner/assemble/tooling"
import { resolveSandboxProfileFromEnv } from "@/runtime"
import { gateOn, logger, type RunContext, runtimeConfig } from "@/shared"
import type { AgentEvent, AssistantTextPainter, StreamPort } from "@/stream"
import {
  astGrepTool,
  createMcpResourceCaptureHolder,
  createProjectsKbStore,
  gitTools,
  type ProjectsKbSlot,
  type Tool,
} from "@/tool"
import { resolveGitBudget } from "@/tool/git"
import { buildCliAskUserTool } from "./ask-user-wire"
import { readCliKnob } from "./cli-knobs-accessor"
import { resolveConfiguredEndpointForCli } from "./configured-endpoint-wire"
import { buildCliFetchRulesTool } from "./fetch-rules-wire"
import {
  astGrepEnabled,
  gitCoChangeEnabled,
  gitToolsEnabled,
  hasArg,
  type LspNavMode,
  lspEnabled,
  planEnabled,
  resolveLspNavMode,
  resumePath,
  statePath,
} from "./internal/argv"
import {
  buildMcpLoadOpts,
  buildMcpResourceTools,
  type Features,
  type LoadFeaturesOpts,
  loadMcpToolsOrEmpty,
  mcpAutoRestartEnabled,
  mcpHotReloadEnabled,
  mcpHotReloadFeatureFields,
  mcpHotReloadLoadOpts,
  readMcpConfig,
  resolveMcpHotReload,
  resolveMcpInboundWiring,
  resolveMcpLaunchPolicy,
  resolveMcpOAuthProvider,
} from "./internal/mcp"
import { createMarkdownPainter } from "./markdown-painter"
import { buildCliElicitationPrompterFactory } from "./mcp-elicitation-prompter"
import { createMcpHealthHolder } from "./mcp-health"
import { buildEmbedder, buildMemoryConfig, memoryEmbedProvenance } from "./memory-compose"
import { isIndicatorEnabled } from "./turn-indicator"

/**
 * ADR-0024 (export-gap closure): CLI `internal.ts` is the home of all
 * pure-ish helpers previously trapped inside `index.ts` next to a top-level
 * `main()` invocation. Splitting them out lets unit tests (e.g.
 * `tests/unit/cli-summarizer.test.ts`) import the real helpers directly
 * instead of re-implementing them locally. This module is CLI-internal:
 * other slices (`@/agent`, `@/skill`, …) MUST NOT import from
 * `src/apps/cli/**` — enforced by Biome `noRestrictedImports` overrides.
 *
 * Layer-2 split (RFC §3.1 → `@/runner/assemble`): the SURFACE-AGNOSTIC
 * builders (LLM / store / embedder / memory / subagent / skills / compaction /
 * verify / tooling / streaming / per-turn AgentConfig) now live in
 * `@/runner/assemble/*` and read NO env. This module keeps the CLI-specific
 * envelope: it parses `process.env` + `process.argv` and delegates the actual
 * build to the surface-agnostic cores. Export NAMES and SIGNATURES are
 * unchanged so 132+ existing consumers (repl.ts, index.ts, unit tests) are
 * unaffected.
 */

export const env = (k: string, fallback: string): string => process.env[k] ?? fallback

/** Map a resolved {@link LspNavMode} to the nav tools to register: `all` ⇒ the
 *  full list (read-only + mutating); `readonly` ⇒ only `isReadOnly()` members;
 *  `none` ⇒ empty. Module-scope (not inlined) so the env-driven assembler stays
 *  under the cognitive-complexity ceiling. Lazy — `lspNavToolList()` builds tool
 *  objects but spawns no server until a tool is called. */
const selectLspNavTools = (mode: LspNavMode): Tool[] => {
  if (mode === "none") return []
  const all = lspNavToolList()
  return mode === "all" ? all : all.filter((t) => t.isReadOnly())
}

/** Provider union — re-exported from the `@/runner/assemble` factory (the
 *  single source of truth via `@/llm`). Kept as a CLI-local name so existing
 *  importers (`index.ts`, tests) are unaffected. */
export type Provider = RunnerProvider

/** Provider selection. Thin wrapper that passes live `process.env` to the
 *  surface-agnostic `pickProviderCore` so the CLI honors a `QUANTA_PROVIDER` /
 *  key-presence change without a config-freeze round-trip (matches the
 *  pre-factory behavior the unit tests pin). */
export const pickProvider = (): Provider => pickProviderCore({ env: process.env })

/** ADR-0068 persona slot — resolve `QUANTA_PERSONA` once at REPL start.
 *  Absent ⇒ `"default"` (the explicit choice). Unknown value ⇒ named
 *  `PersonaInvalidError` throw (no silent fallback per ADR-0067 §C). */
export const pickPersona = (): PersonaKind => resolvePersona(process.env)

/** ADR-0198 identity slot — resolve the per-mode identity lines for the
 *  current REPL posture. Default-OFF: when `QUANTA_IDENTITY` is unset (or
 *  not the literal "1") we return `undefined` so `buildSystemPrompt`'s
 *  identity slot is empty and the rendered prompt is byte-identical to the
 *  pre-ADR base prompt. When opted in, the value of `QUANTA_IDENTITY_MODE`
 *  selects the posture (default / plan / review / audit / onboarding);
 *  absent ⇒ `"default"`. Unknown ⇒ falls through to the provider's typed
 *  unknown-mode fallback line (no throw, no silent default to "default"
 *  — the operator's typo is surfaced via the prompt itself). */
export const pickIdentity = (): readonly string[] | undefined => {
  if (!readCliKnob("QUANTA_IDENTITY", "bool")) return undefined
  const raw = process.env.QUANTA_IDENTITY_MODE ?? "default"
  return identityForToken(raw)
}

/** Build the main LLM adapter via the surface-agnostic core, with H7 / ADR-0139
 *  CLOUD-TRANSPORT SELECTION + ROTATION routed end-to-end.
 *
 *  DEFAULT-OFF BYTE-IDENTITY: when neither `QUANTA_LLM_TRANSPORT` nor a cloud
 *  env signal (`ANTHROPIC_{BEDROCK,VERTEX,FOUNDRY}_BASE_URL` / `*_RESOURCE` /
 *  `*_USE_*`) is set, {@link selectLlmTransport} resolves to `legacy` and this
 *  builds the four vendor providers via the UNCHANGED `buildLLMCore` path — a
 *  missing provider key still throws (the cli aborts loudly), the factory still
 *  resolves the api key + `OPENAI_BASE_URL` from `process.env`.
 *
 *  When a cloud transport IS selected, the LLM is built through
 *  `createMulticloudLLM` with the H7 rotating-credential source — making the
 *  previously-unreachable multicloud + rotation seam reachable BY CONFIG. The
 *  credential shell is gated behind the FAIL-CLOSED `QUANTA_LLM_CREDENTIAL_TRUSTED`
 *  attestation: unset ⇒ a typed `untrusted` decline, never a silent command run.
 *  The four H7 command knobs are mirrored off `runtimeConfig()` (the SSOT that
 *  owns the `process.env` read). */
/** Test-only DI seams for {@link buildLLM}. The CLI `buildLLM` seam reads
 *  `runtimeConfig()` + `process.env` (the REAL config→selection→credential→stream
 *  chain a user exercises by setting `QUANTA_LLM_TRANSPORT` etc.), but the cloud
 *  transports lazy-import an optional cloud SDK and the credential refresh runs
 *  the real `runShell`. So an end-to-end test that drives THIS entry point can
 *  only do so over FAKE leaves (a synthetic cloud client + a synthetic shell).
 *  These optional seams thread those fakes DOWN to the proven `buildMainLLMCore`
 *  seams (`multicloudOpts.{bedrock,vertex}ClientFactory` + `credential.shellExec`).
 *  PRODUCTION OMITS THIS ARGUMENT ⇒ byte-identical: the real lazy SDK import +
 *  the real `runShell`-backed `realShellExec` are used (no behavior change, no
 *  new field consulted on the legacy path). */
export interface BuildLlmTestSeams {
  /** Injected shell-exec for the H7 credential helper (mirrors
   *  `CredentialSourceInput.shellExec`). Absent ⇒ the real `runShell`. */
  readonly shellExec?: (command: string) => Promise<import("@/llm").ShellExecResult>
  /** Injected cloud-client factories (mirrors `MainLlmAssembleInput.multicloudOpts`)
   *  so a faked Bedrock/Vertex client bypasses the lazy SDK import. Absent ⇒ the
   *  real lazy SDK import is the live path. */
  readonly multicloudOpts?: MainLlmAssembleInput["multicloudOpts"]
  /** Injected clock for the credential TTL cache (no bare `Date.now()` in tests).
   *  Absent ⇒ the credential helper's `Date.now` default. */
  readonly now?: () => number
}

export const buildLLM = (
  provider: Provider,
  model: string,
  seams: BuildLlmTestSeams = {},
  endpoint?: ResolvedEndpoint,
): LLMPort => {
  const cfg = runtimeConfig()
  const selection = selectLlmTransport({ transport: cfg.llmTransport, env: process.env })
  return buildMainLLMCore({
    provider,
    model,
    env: process.env,
    selection,
    credential: {
      apiKeyHelper: cfg.apiKeyHelper,
      apiKeyHelperTtlMs: cfg.apiKeyHelperTtlMs,
      awsAuthRefresh: cfg.awsAuthRefresh,
      gcpAuthRefresh: cfg.gcpAuthRefresh,
      // FAIL-CLOSED: arbitrary command execution requires an explicit operator
      // trust attestation. Unset ⇒ the source declines (typed `untrusted`),
      // shelling ZERO times.
      isTrusted: () => cfg.llmCredentialTrusted,
      // Test-only DI seams (production omits `seams` ⇒ both undefined ⇒ the real
      // `realShellExec`/`Date.now` are used inside `buildCredentialSource`).
      ...(seams.shellExec !== undefined ? { shellExec: seams.shellExec } : {}),
      ...(seams.now !== undefined ? { now: seams.now } : {}),
    },
    // Test-only cloud-client DI (production omits ⇒ the lazy SDK import is live).
    ...(seams.multicloudOpts !== undefined ? { multicloudOpts: seams.multicloudOpts } : {}),
    // RFC05 wireE — a SELECTED configured OpenAI endpoint (resolved lazily in
    // `buildLLMWithByok` only when `QUANTA_LLM_ENDPOINT` names one). ABSENT ⇒
    // byte-identical vendor path (the four providers + ctor args untouched); the
    // legacy branch of `buildMainLLMCore` routes to the OpenAI-wire adapter with
    // the endpoint's baseUrl + guarded fetch only when present.
    ...(endpoint !== undefined ? { endpoint } : {}),
  })
}

/** The memory composition trio (ADR-0413 store / ADR-0555 embedder / ADR-0414
 *  tuning block) lives in `./memory-compose` — re-exported so consumers keep
 *  resolving the historical names from `./internal`. */
export { buildEmbedder, buildMemoryConfig, buildStore } from "./memory-compose"
/** Default model id per provider — re-exported from the runner barrel (the
 *  single source of truth the three app entry points used to each duplicate). */
/** Re-export the pure helper so existing tests
 *  (`tests/unit/env-knob-branches.test.ts`) keep resolving it from
 *  `./internal`. */
export { DEFAULT_MODEL, parseRecallTiers }

/**
 * Resolve the `subagent` config block from env (Tier 1 capability, ADR-0011).
 * Default ON: `QUANTA_SUBAGENT` unset ⇒ enabled, so the `agent`/`task_output`/
 * `task_stop` tools ARE registered and the model can fan out subagents from a
 * plain-language request. Set `QUANTA_SUBAGENT=0` (or `false`/`off`/`no`) to
 * disable (restores the byte-identical no-subagent loop for CI/bench). An
 * optional integer `QUANTA_SUBAGENT_MAX_DEPTH` caps recursion (else the
 * runner's default).
 */
export const buildSubagentConfig = (
  /** Optional surface-provided TaskRegistry. When supplied AND the env flag
   *  enables subagent, the same instance is threaded into the loop so the
   *  surface (CLI lifecycle pills) can poll `pendingIds()` per turn.
   *  Unset ⇒ byte-identical to today (loop mints its own). */
  taskRegistry?: import("@/subagent").TaskRegistry,
  /** Env bag (DI) — defaults to `process.env`. Threaded to every `readCliKnob`
   *  so tests inject an explicit bag instead of mutating the GLOBAL process.env
   *  (which, under bun's cross-file test concurrency, races other suites that
   *  touch QUANTA_SUBAGENT* — the flake this carve-out removes). */
  env: Readonly<Record<string, string | undefined>> = process.env,
  /** jun-15 P0-b — session Activity Spine store, threaded onto the subagent
   *  config so `run_workflow` feeds `/activity`. Unset ⇒ no recording. */
  activityStore?: import("@/activity").ActivityStore,
): AgentConfig["subagent"] | undefined => {
  const enabled = readCliKnob("QUANTA_SUBAGENT", "bool", env) ?? true
  const depth = readCliKnob("QUANTA_SUBAGENT_MAX_DEPTH", "int", env)
  // ADR-0041 — parallel-worker (6-tool) router. CLI default-ON is seeded by the
  // gate block in index.ts (QUANTA_SUBAGENT_6TOOLS), so the agent can fan out
  // background `spawn_agent`/`wait_agent` workers. `QUANTA_SUBAGENT_6TOOLS=0`
  // (or QUANTA_SUBAGENT=0) disables. exec_command's model-supplied cwd is jailed
  // to the workspace by the loop assembly; dangerous commands still pass the
  // permission/HITL gate.
  const enable6Tools = enabled && (readCliKnob("QUANTA_SUBAGENT_6TOOLS", "bool", env) ?? true)
  const conc = readCliKnob("QUANTA_SUBAGENT_MAX_CONCURRENT", "int", env)
  // Companions to the parallel-worker router: `spawn_batch` (fan a prompt list
  // out in one call) + `list_agents` (see the spawned workers). Default-ON under
  // QUANTA_SUBAGENT; `QUANTA_SUBAGENT_BATCH=0` / `QUANTA_SUBAGENT_INTROSPECT=0`
  // disable individually. Zero-adapter: both ride the existing runner/registry.
  const enableBatchSpawn = enabled && (readCliKnob("QUANTA_SUBAGENT_BATCH", "bool", env) ?? true)
  const enableIntrospect =
    enabled && (readCliKnob("QUANTA_SUBAGENT_INTROSPECT", "bool", env) ?? true)
  // §25.1 — `run_workflow` (LLM-authored declarative orchestration). DEFAULT-OFF
  // (gateOn ⇒ must be explicitly QUANTA_WORKFLOW=on/1): it fans out a tree of
  // subagents, so it opts in rather than riding the default subagent-ON seed.
  const enableWorkflow = enabled && (readCliKnob("QUANTA_WORKFLOW", "bool", env) ?? false)
  // GAP7-4 — `spawn_agents_on_csv` (CSV batch fan-out). DEFAULT-OFF (opt-in: it
  // spawns one child per row, so it does not ride the default subagent-ON seed).
  const enableSpawnAgentsCsv =
    enabled && (readCliKnob("QUANTA_SPAWN_AGENTS_CSV", "bool", env) ?? false)
  return buildSubagentConfigCore({
    enabled,
    ...(depth !== undefined ? { maxDepth: depth } : {}),
    ...(taskRegistry !== undefined ? { taskRegistry } : {}),
    ...(activityStore !== undefined ? { activityStore } : {}),
    ...(enable6Tools ? { enable6Tools: true } : {}),
    ...(conc !== undefined ? { maxConcurrent: conc } : {}),
    ...(enableBatchSpawn ? { enableBatchSpawn: true } : {}),
    ...(enableIntrospect ? { enableIntrospect: true } : {}),
    ...(enableWorkflow ? { enableWorkflow: true } : {}),
    ...(enableSpawnAgentsCsv ? { enableSpawnAgentsCsv: true } : {}),
  })
}

/**
 * Resolve the verify-guard control from env (Tier 0 safety hardening, ADR-0011).
 * Default OFF: `QUANTA_VERIFY_GUARD` unset ⇒ `undefined` so the key is omitted
 * and the loop is byte-identical (no tool-history, no finish interception).
 * When set, a finish right after an unverified mutating tool is blocked,
 * forcing one more turn up to `QUANTA_VERIFY_GUARD_MAX_TRIPS` (else default 2).
 */
/**
 * §17 packet F1b — the verify-guard gate, read through the CANONICAL vocabulary.
 *
 * This was `process.env.QUANTA_VERIFY_GUARD !== undefined`, i.e. presence-only.
 * `QUANTA_VERIFY_GUARD=0`, `=off`, `=false`, `=no` and `=""` all turned the guard
 * ON — the exact opposite of what an operator typing `0` means, and a shape this
 * repo already has a standing ratchet against for the dangerous-command gate.
 *
 * `gateOn` is the one reader every `QUANTA_*` gate is interpreted against
 * (`1|on|true|yes` truthy, `0|off|false|no` falsy, an empty export deliberately
 * NOT an opt-in, unrecognized values NOT an opt-in). Default-OFF is preserved:
 * unset is still off. Exported so the truth table is testable without touching
 * the process env.
 */
export const verifyGuardEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  gateOn(env, "QUANTA_VERIFY_GUARD")

export const buildVerifyGuardConfig = (): AgentConfig["verifyGuard"] | undefined => {
  const enabled = verifyGuardEnabled()
  const trips = readCliKnob("QUANTA_VERIFY_GUARD_MAX_TRIPS", "int")
  return buildVerifyGuardConfigCore({
    enabled,
    ...(trips !== undefined ? { maxTrips: trips } : {}),
  })
}

/**
 * Resolve the `skills` config block from env (Tier 1 capability, ADR-0011 +
 * ADR-0045 system-skills follow-up). Three states:
 *   - `QUANTA_SKILLS_DIR=<path>`      → `{ dir }`  user dir + bundled system skills
 *   - default (or `QUANTA_SKILLS=1`)  → `{}`       bundled system skills, so the
 *     model sees the skill catalogue + trigger rules and can auto-invoke
 *     (localize-fault, progress-audit available without a user dir per ADR-0045)
 *   - `QUANTA_SKILLS=0` (or false/off/no) → `undefined`  no Skill/ToolSearch tools
 *     (opt-out restores the byte-identical no-skill loop for CI/bench)
 * A user dir wins over the bare flag (it's a superset — it also pulls system
 * skills in via `buildSkillFeatures`'s merge).
 */
export const buildSkillsConfig = (): AgentConfig["skills"] | undefined => {
  const dir = process.env.QUANTA_SKILLS_DIR
  return buildSkillsConfigCore({
    ...(dir !== undefined ? { dir } : {}),
    enabled: (readCliKnob("QUANTA_SKILLS", "bool") ?? true) || hasArg("--skills"),
  })
}

/**
 * Resolve the compaction circuit-breaker control from env (Tier 0 safety
 * hardening, ADR-0011). The breaker is ON by default with safe caps and only
 * trips on pathological compaction thrash, so omitting the key is the
 * behavior-preserving default. `QUANTA_COMPACT_BREAKER=off` ⇒
 * `{ disabled: true }`. Optional integer caps overrides (only applied when
 * a valid integer): `QUANTA_COMPACT_BREAKER_REACTIVE_MAX` →
 * `maxConsecutiveReactive`, `QUANTA_COMPACT_BREAKER_PROACTIVE_MAX` →
 * `maxNoProgressProactive`.
 */
export const buildCompactionBreakerConfig = (): AgentConfig["compactionBreaker"] | undefined => {
  const intEnv = (k: string): number => {
    const raw = process.env[k]
    return raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN
  }
  const reactiveMax = intEnv("QUANTA_COMPACT_BREAKER_REACTIVE_MAX")
  const proactiveMax = intEnv("QUANTA_COMPACT_BREAKER_PROACTIVE_MAX")
  return buildCompactionBreakerConfigCore({
    // ADR-0503 P4: routed through the typed accessor (was gateDisabled). Knob
    // default is ON ⇒ disabled iff readBool(raw, true) is false — byte-identical
    // to gateDisabled (unset/empty/unrecognized ⇒ ON, falsy token ⇒ disabled).
    ...(!(readCliKnob("QUANTA_COMPACT_BREAKER", "bool") ?? true) ? { disabled: true } : {}),
    ...(Number.isFinite(reactiveMax) ? { reactiveMax } : {}),
    ...(Number.isFinite(proactiveMax) ? { proactiveMax } : {}),
  })
}

/**
 * ADR-0011: dedicated compaction summarizer model. `QUANTA_COMPACT_MODEL`
 * (+ optional `QUANTA_COMPACT_PROVIDER`, default = the main provider) builds a
 * cheaper/faster `LLMPort` (retry-wrapped, same as the main stack) used ONLY
 * for the compaction summary turn. Unset ⇒ `undefined` ⇒ `config.llm` is used
 * (byte-identical). Tradeoff documented on `AgentConfig.compaction.summarizerLlm`.
 */
export const buildSummarizerLlm = (
  mainProvider: Provider,
  signal: AbortSignal,
): LLMPort | undefined =>
  buildSummarizerLlmCore({
    mainProvider,
    signal,
    model: process.env.QUANTA_COMPACT_MODEL,
    ...(process.env.QUANTA_COMPACT_PROVIDER !== undefined
      ? { provider: process.env.QUANTA_COMPACT_PROVIDER as Provider }
      : {}),
    env: process.env,
  })

// jun-6 (RFC jun-6-ai-session-title) — the AI-session titler assembly
// (`buildAutoTitlePort` + its placeholder predicate) moved to `./auto-title-wire`
// (god-code split; internal.ts was over the 1000-line ceiling). Re-exported below
// verbatim so every existing `./internal` importer keeps resolving it unchanged.
export { buildAutoTitlePort } from "./auto-title-wire"

/** jun-6 (RFC jun-6-byok-apikey-helper) — async BYOK variant of {@link buildLLM}
 *  for the LEGACY vendor key path (anthropic/openai). The legacy LLM-build seam
 *  is SYNCHRONOUS while the H7 `apiKeyHelper` mint is ASYNC, so this seam `await`s
 *  the single pre-resolution step (`resolveVendorApiKey`, inside
 *  `buildLLMWithByokCore`) that may replace the vendor env key with a
 *  broker-minted short-lived key, then builds the adapter with the (possibly
 *  key-augmented) opts.
 *
 *  DEFAULT-OFF BYTE-IDENTITY: the mint is consulted ONLY when
 *  `runtimeConfig().apiKeyHelperLegacyVendor` is on AND the legacy (non-cloud)
 *  transport is selected AND an H7 `CredentialSource` was built (≥1 H7 knob set).
 *  Any precondition absent ⇒ this delegates verbatim to the sync {@link buildLLM}
 *  (preserving the H7/ADR-0139 transport selection + cloud rotation), which is
 *  byte-identical to today. When ON and the helper mints, the minted key arrives
 *  as `opts.apiKey` (which wins over env inside `createLLM`); a configured-but-
 *  broken / untrusted helper FAILS LOUDLY (the H7 fail-before-wire posture),
 *  never a silent fall-through to a stale env key.
 *
 *  `seams` mirrors {@link buildLLM}'s test DI — the H7 shell + clock are threaded
 *  into `buildCredentialSource` so a reachability test drives the mint over a
 *  fake shell. Production omits ⇒ the real `runShell`/`Date.now` are used. */
export const buildLLMWithByok = async (
  provider: Provider,
  model: string,
  seams: BuildLlmTestSeams = {},
): Promise<LLMPort> => {
  const cfg = runtimeConfig()
  const selection = selectLlmTransport({ transport: cfg.llmTransport, env: process.env })
  // RFC05 wireE — SELECT a configured OpenAI endpoint (lazy: no disk read unless
  // `QUANTA_LLM_ENDPOINT` names one). GATE-OFF ⇒ `undefined` ⇒ byte-identical
  // vendor path below. A configured endpoint OWNS its own auth (the host-resolved
  // `QUANTA_ENDPOINT_API_KEY`, not a vendor env key), so it routes DIRECTLY
  // through `buildLLM` (the legacy branch of `buildMainLLMCore` picks the
  // OpenAI-wire adapter) — the vendor `apiKeyHelper` mint below is not applicable
  // to a custom endpoint and is bypassed.
  const endpoint = await resolveConfiguredEndpointForCli()
  if (endpoint !== undefined) return buildLLM(provider, model, seams, endpoint)
  // Mint only applies to the LEGACY vendor path; the multicloud transports use
  // the sibling cloud-credential refresh (not the vendor apiKeyHelper mint), so
  // route them through the unchanged sync seam.
  if (!cfg.apiKeyHelperLegacyVendor || selection.kind !== "legacy") {
    return buildLLM(provider, model, seams)
  }
  // FAIL-CLOSED — the H7 credential source is built ONLY when a knob is set; the
  // mint shell runs only under the explicit `QUANTA_LLM_CREDENTIAL_TRUSTED`
  // attestation. No knob ⇒ `source` is `undefined`; untrusted ⇒ the source
  // declines ⇒ `resolveVendorApiKey` returns the same opts (env key untouched).
  const source: CredentialSource | undefined = buildCredentialSource({
    apiKeyHelper: cfg.apiKeyHelper,
    apiKeyHelperTtlMs: cfg.apiKeyHelperTtlMs,
    awsAuthRefresh: cfg.awsAuthRefresh,
    gcpAuthRefresh: cfg.gcpAuthRefresh,
    isTrusted: () => cfg.llmCredentialTrusted,
    ...(seams.shellExec !== undefined ? { shellExec: seams.shellExec } : {}),
    ...(seams.now !== undefined ? { now: seams.now } : {}),
  })
  return buildLLMWithByokCore({
    provider,
    model,
    env: process.env,
    ...(source !== undefined ? { source } : {}),
  })
}

/**
 * Resolve the fallback-provider model ids from `QUANTA_MODEL_FALLBACK`.
 * Default OFF: unset ⇒ `[]` so the llm stack is left byte-identical to
 * today (no `FallbackLLM` wrap). Comma-separated model ids; a bare flag
 * value with no usable id (e.g. `1`) yields `[]` ⇒ no wrap.
 */
export const fallbackModels = (): string[] => parseFallbackModels(process.env.QUANTA_MODEL_FALLBACK)

/** Resolve all default-OFF feature flags from env/argv and start MCP servers.
 *  Logs each enabled feature via the structured logger (minimal).
 *
 *  B1 (jun-04) — `opts.llm` threads the assembled `LLMPort` so an inbound MCP
 *  `sampling/createMessage` can be fulfilled. With the knob
 *  (`QUANTA_MCP_SAMPLING`) on, an LLM threaded, AND an interactive consent
 *  prompter available, the constructed `McpClient`s advertise `sampling` and
 *  route inbound requests through the LLM-backed handler (gated on user consent).
 *  Any precondition absent ⇒ byte-identical to the legacy load. */
export const loadFeatures = async (
  slog: StructuredLogger,
  opts: LoadFeaturesOpts = {},
): Promise<Features> => {
  const planMode = planEnabled()
  const metrics = readCliKnob("QUANTA_METRICS", "bool") ? new Metrics() : undefined
  const state = statePath()
  const resume = resumePath()
  // §12.4 LIVE-wire — the central-config MCP launch policy (E2 denylist +
  // E1-sub managed-only) now actually gates which `.mcp.json` servers launch.
  // Gate OFF / no policy configured / resolve fault ⇒ undefined ⇒ byte-identical.
  // §17 packet F1b — pass the project root so a `.mcp.json` the connector
  // installer wrote with no env override is actually read on this launch. The
  // writer's fallback is `<cwd>/.mcp.json`; the reader now resolves the same.
  const mcpConfigs = await readMcpConfig(
    slog,
    process.env,
    await resolveMcpLaunchPolicy(slog),
    process.cwd(),
  )
  // Track C — interactive MCP elicitation prompter. Built only when an
  // interactive CLI prompt seam is available (TTY stdin); headless / piped
  // runs get `undefined` so each McpClient keeps its headlessRejecter default
  // (byte-identical to the legacy load). The factory binds a per-server lease
  // (`pool.forContext({ serverId })`) inside `loadMcpTools`.
  const elicitationPrompterFor = opts.elicitationPrompterFor ?? buildCliElicitationPrompterFactory()
  // ADR-0435: opt-in auto-restart. Unset ⇒ `supervisorDepsFor` is undefined ⇒
  // `loadMcpTools` takes the original single-client branch (byte-identical).
  const autoRestart = mcpAutoRestartEnabled()
  // B1 + H19 (jun-04) — advertise-iff-able inbound-capability wiring (sampling +
  // roots, unified into ONE bundle). The surface owns this decision (the only
  // layer with the LLM, the consent prompter, AND the workspace cwd) and hands
  // the already-built `{ negotiator, handler?, rootsProvider? }` DOWN to the
  // bridge, which stays a pure consumer. Undefined ⇒ byte-identical (no
  // advertisement, headless rejecter, empty roots). The SAME bundle reaches BOTH
  // the single-client AND the supervised path (threaded into the restart
  // factory), so a reconnected client re-advertises sampling+roots.
  const inboundWiring = resolveMcpInboundWiring(opts.llm, elicitationPrompterFor)
  // H18 (jun-06 live-wire) — the connectors-backed MCP OAuth provider, resolved
  // from the loaded server configs (the issuer is each server's `url` origin).
  // Undefined unless `QUANTA_MCP_OAUTH=1` AND a server opts in (`oauth:true`);
  // the keyring composition (`QUANTA_MCP_OAUTH_KEYRING`) is baked into its token
  // store here. Test seams (`opts.mcpOAuthDeps`) inject a fake auth server /
  // browser flow / store dir; production omits them.
  const oauthProvider = resolveMcpOAuthProvider(mcpConfigs, opts.mcpOAuthDeps)
  // WS-G (UUX-6-22) — mint the live server-health registry ONLY when MCP is
  // configured; the load callbacks (exit / load-error) write into it and the
  // lifecycle pill re-reads it per flush (surface-mints→down-thread, mirrors
  // mcpResourceCapture). No servers ⇒ undefined ⇒ callbacks not wired.
  const mcpHealth = mcpConfigs.length > 0 ? createMcpHealthHolder() : undefined
  // RFC04-2/3 (hot-reload) — reload observer + source collector, present ONLY
  // under `QUANTA_MCP_HOT_RELOAD` + configured non-supervised servers (see
  // resolveMcpHotReload). Gate off ⇒ `undefined` ⇒ byte-identical.
  const hotReload = resolveMcpHotReload({ configCount: mcpConfigs.length, autoRestart })
  const mcpLoadOpts = buildMcpLoadOpts(slog, {
    autoRestart,
    inboundWiring,
    oauthProvider,
    opts,
    ...(mcpHealth !== undefined ? { mcpHealth } : {}),
    ...mcpHotReloadLoadOpts(hotReload),
  })
  const {
    tools: mcpBridgedTools,
    clients: mcpClients,
    resources: mcpResources,
  } = await loadMcpToolsOrEmpty(mcpConfigs, elicitationPrompterFor, mcpLoadOpts)
  // N3 (QUANTA_MCP_RESOURCES) — the four `mcp_*` resource/prompt tools, gated on
  // the knob AND a live aggregate handle (see {@link buildMcpResourceTools}).
  // B4 (jul-04 CLI-surfacing) — MINT one bounded capture holder ONLY when those
  // tools will actually register (knob ON + a live handle), then thread the SAME
  // instance INTO the tools (producer) AND up on `Features.mcpResourceCapture`
  // (consumer) so `/mcp-resources` reads the exact ring the tools write into —
  // the surface-mints→down-thread contract (one holder, no split-brain). Absent
  // gate / handle ⇒ `undefined` ⇒ no capture, byte-identical default-OFF.
  const mcpResourceCapture =
    runtimeConfig().mcpResources && mcpResources !== undefined
      ? createMcpResourceCaptureHolder()
      : undefined
  const mcpResourceTools = buildMcpResourceTools(mcpResources, mcpResourceCapture)
  const mcpTools: Tool[] = [...mcpBridgedTools, ...mcpResourceTools]

  // LSP-backed diagnostics: only when opted in. The tool name matches the
  // no-op one in defaultTools, so appending it lets the registry's last-write
  // -wins map swap in the real provider (same merge path as MCP tools).
  const lspTools: Tool[] = lspEnabled() ? [lspDiagnosticsTool()] : []
  // ADR-0015: LSP nav tools. NOT in defaultTools. Server-present resource gate
  // (jun-26): with QUANTA_LSP_TOOLS unset, the READ-ONLY nav tools register
  // by default IFF a language server binary is on PATH (mirrors the browser
  // tools self-gating on chrome) — surfacing the nav moat out-of-box without
  // exposing dead tools in a no-LSP environment. `=full` adds the mutating
  // members (rename_apply/format); an explicit OFF token keeps the legacy
  // byte-identical (empty) surface even with a server installed.
  const lspNavMode = resolveLspNavMode(
    process.env.QUANTA_LSP_TOOLS,
    anyLspServerOnPath((bin) => Bun.which(bin) !== null),
  )
  const lspNavTools: Tool[] = selectLspNavTools(lspNavMode)
  // ADR-0016: first-class git tools. NOT in defaultTools — opt-in only.
  // §7.2: when QUANTA_GIT_CO_CHANGE is also on, append the co-change tool
  // (opts.coChange). Default-OFF: gate off ⇒ git tool set is byte-identical.
  // ADR-0107 §wire: resolve the git capture budget from env knobs (QUANTA_GIT_BUDGET_*).
  // Absent ⇒ resolveGitBudget returns undefined ⇒ withBudget returns the SAME runner
  // reference ⇒ byte-identical to the pre-budget path.
  const gitBudget = resolveGitBudget(process.env)
  const gitToolList: Tool[] = gitToolsEnabled()
    ? gitTools(undefined, {
        ...(gitCoChangeEnabled() ? { coChange: true as const } : {}),
        ...(gitBudget !== undefined ? { budget: gitBudget } : {}),
      })
    : []
  // Structural AST search via ast-grep (QUANTA_AST_GREP=1). Default-OFF.
  const astGrepTools: Tool[] = astGrepEnabled() ? [astGrepTool as Tool] : []

  if (planMode) slog.info("plan.mode.on")
  if (metrics) slog.info("metrics.on")
  if (state) slog.info("state.persist.on", { path: state })
  if (mcpTools.length > 0) slog.info("mcp.tools.loaded", { count: mcpTools.length })
  if (mcpResourceTools.length > 0) slog.info("mcp.resources.on", { count: mcpResourceTools.length })
  if (autoRestart && mcpClients.length > 0) slog.info("mcp.autorestart.on")
  if (lspTools.length > 0) slog.info("lsp.diagnostics.on")
  if (lspNavTools.length > 0) slog.info("lsp.nav.on", { count: lspNavTools.length })
  if (gitToolList.length > 0) slog.info("git.tools.on", { count: gitToolList.length })
  if (astGrepTools.length > 0) slog.info("ast.grep.on")
  return {
    planMode,
    metrics,
    state,
    resume,
    mcpTools,
    mcpClients,
    mcpConfigs,
    lspTools,
    lspNavTools,
    gitToolList,
    astGrepTools,
    // B4 (jul-04) — forward the SAME capture holder the mcp resource tools write
    // into (undefined when the gate/handle absent ⇒ `/mcp-resources` "not wired").
    ...(mcpResourceCapture !== undefined ? { mcpResourceCapture } : {}),
    // WS-G (UUX-6-22) — forward the SAME health registry the load callbacks
    // write into so the lifecycle pill overlays live server status per flush.
    ...(mcpHealth !== undefined ? { mcpHealth } : {}),
    // RFC04-2/3 (hot-reload) — forward the collected reload sources + controller
    // late-binder so the composition root builds the controller over the SAME
    // sources the load emitted. Absent ⇒ omitted (byte-identical).
    ...mcpHotReloadFeatureFields(hotReload),
  }
}

/** Observability wiring (RFC-0002 §5.4/§8). Default OFF → byte-identical to
 *  today (plain StdoutStream, no RunContext). When `observe` is set: a runId
 *  tags a RunContext and the stdout stream is fanned out to a JsonlRecorder.
 *  Thin wrapper over the surface-agnostic `buildStreamingCore`.
 *
 *  ADR (inline markdown highlighter): when the CLI surface has both a TTY
 *  stdout AND the env knobs allow colour (NO_COLOR unset, QUANTA_MD_HIGHLIGHT
 *  !== "0", QUANTA_MD_MODE !== "off"), an `AssistantTextPainter` is built and
 *  threaded into `StdoutStream` so headers / code fences / inline-code spans
 *  paint with ANSI escapes. With the painter ABSENT (any of the gates fail)
 *  the byte stream is verbatim — same as before this feature. */
export const buildStreaming = (
  observe: string | undefined,
  slog: StructuredLogger,
): { stream: StreamPort; run: RunContext | undefined } => {
  const painter = buildCliMarkdownPainter()
  return buildStreamingCore({
    ...(observe !== undefined ? { observeDir: observe } : {}),
    ...(painter !== undefined ? { painter } : {}),
    slog,
  })
}

/** Build the assistant-text markdown painter for this CLI process, or
 *  return undefined when any default-OFF gate fails. Gates (all must pass):
 *   - `process.stdout.isTTY === true` (a pipe stays plain).
 *   - `process.env.NO_COLOR` unset / empty (https://no-color.org).
 *   - `process.env.QUANTA_MD_HIGHLIGHT !== "0"` (kill-switch).
 *   - `process.env.QUANTA_MD_MODE` not `"off"`.
 *  Extracted to a named helper so `buildStreaming` stays a thin assembler
 *  and the gating logic is straightforward to unit-test. */
const buildCliMarkdownPainter = (): AssistantTextPainter | undefined => {
  if ((process.stdout as { isTTY?: boolean }).isTTY !== true) return undefined
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return undefined
  if (process.env.QUANTA_MD_HIGHLIGHT === "0") return undefined
  const mode = process.env.QUANTA_MD_MODE
  if (mode === "off") return undefined
  return createMarkdownPainter({
    enabled: true,
    mode: mode === "aggressive" ? "aggressive" : "conservative",
  })
}

/** Compose the LLM stack: bounded retry (inner-most), optional same-turn
 *  provider fallback (outer), and — only in `auto` mode — attach the
 *  LLM-backed permission classifier to `permission`. Default OFF for both
 *  fallback and classifier ⇒ `finalLLM === retryingLLM` and `permission`
 *  untouched, byte-identical to today. Thin wrapper over `composeLLMCore`. */
export const composeLLM = (
  retryingLLM: LLMPort,
  provider: Provider,
  signal: AbortSignal,
  mode: PermissionMode,
  permission: PermissionContext,
  slog: StructuredLogger,
  /** RFC02-3 (A8) — PRODUCTION route sink. Threaded onto `composeLLMCore` so a
   *  real `FallbackLLM` provider swap projects a `model_route_changed` AgentEvent
   *  onto the live stream. Wired ONLY under `QUANTA_MODEL_REROUTE_EVENT` (the host
   *  passes `undefined` otherwise ⇒ byte-identical, no `onTransition`). */
  routeEventSink?: (ev: AgentEvent) => void,
): LLMPort =>
  composeLLMCore({
    retryingLLM,
    provider,
    signal,
    mode,
    permission,
    slog,
    fallbackModelIds: fallbackModels(),
    env: process.env,
    ...(routeEventSink !== undefined ? { routeEventSink } : {}),
    // Live "· N tokens" counter rides the SAME gate as the spinner indicator
    // (interactive TTY + `QUANTA_SPINNER` not disabled). Non-TTY / piped /
    // `QUANTA_SPINNER=0` ⇒ byte-identical no-progress stream.
    liveUsage: isIndicatorEnabled(process.env, process.stdout.isTTY),
  })

// ── Split: `Tooling` lives in `@/runner/assemble/*` (PURE composition, no
//    env reads). Re-exported below so CLI-local types keep their historical
//    surface without pulling runtime assembly helpers back in.
export type { Tooling } from "@/runner/assemble/tooling"

/** Build the per-run tooling: resolve every env-driven default-OFF knob, then
 *  delegate the actual registry + config aggregation to the surface-agnostic
 *  `buildToolingCore`. The shim is the CLI-specific envelope (it owns the env
 *  reads, the `crypto.randomUUID()` mint, and the `logger.info` sink — none of
 *  which are surface-agnostic). */
export const buildTooling = (
  mcpTools: Tool[],
  lspTools: Tool[],
  lspNavTools: Tool[],
  gitToolList: Tool[],
  astGrepTools: Tool[],
  slog: StructuredLogger,
  /** Optional surface-provided {@link TaskRegistry} threaded into the
   *  subagent config so the surface (CLI lifecycle pills) shares the same
   *  registry instance the loop uses. Unset ⇒ byte-identical to today
   *  (loop mints internally). */
  subagentTaskRegistry?: import("@/subagent").TaskRegistry,
  metrics?: Metrics,
  /** ADR-0432 — live 0..100 remaining-budget signal for the self-edit memory
   *  write-guard. The surface passes `() => meter.remainingPercent()` once a
   *  `BudgetMeter` (ADR-0138) exists for the run; absent ⇒ the guard is inert
   *  even when `QUANTA_MEMORY_WRITE_GUARD_PCT` is set (fail-open, byte-identical
   *  for callers that do not wire a meter). */
  budgetRemainingPercent?: () => number,
  /** jun-15 P0-b — session Activity Spine store, threaded onto the subagent
   *  config so `run_workflow` streams live phases/steps into `/activity`. The
   *  surface passes the SAME instance it hands the slash surface. Unset ⇒ no
   *  recording (byte-identical). */
  activityStore?: import("@/activity").ActivityStore,
  /** jul-03 B3 — live PROVIDER rate-limit remaining % (0..100) / `undefined`,
   *  SEPARATE from `budgetRemainingPercent`. The surface passes
   *  `() => meter.providerRateLimitRemainingPercent()` so the memory write-guard's
   *  provider arm reads the REAL provider window. Unset ⇒ provider arm unarmed
   *  (byte-identical). */
  providerRateLimitRemainingPercent?: () => number | undefined,
): Tooling => {
  // ADR-0555 — ONE factory call: store + its RESOLVED kind come from the same
  // slot, so the banner / `/memory stats` describe the store the loop uses.
  const memory = buildMemoryForSession(process.env)
  const store = memory.store
  const embedder = buildEmbedder(store)
  const sessionId = crypto.randomUUID()
  const searchMetrics =
    metrics === undefined
      ? undefined
      : {
          observe(name: string, value: number) {
            metrics.timer(name).record(value)
          },
        }
  const searchWire = buildSearchPipelineFromEnv(process.env, process.cwd(), searchMetrics)
  const memoryConfig = buildMemoryConfig(store)
  const subagentConfig = buildSubagentConfig(subagentTaskRegistry, process.env, activityStore)
  const skillsConfig = buildSkillsConfig()
  const compactionBreakerConfig = buildCompactionBreakerConfig()
  const verifyGuardConfig = buildVerifyGuardConfig()
  // ADR-0297 — resolve QUANTA_SANDBOX → OsSandboxProfile and forward to
  // buildToolingCore so the bash factory's HITL tier closes over it. Unset/
  // unrecognised ⇒ undefined ⇒ conservative `always-confirm` default.
  const sandboxProfile = resolveSandboxProfileFromEnv(process.env)
  // ADR-0287 — async-tools `poll_deferred`. Default-OFF: built ONLY when
  // `runtimeConfig().asyncTools` is true (QUANTA_ASYNC_TOOLS); absent ⇒ `[]`
  // (no registry allocation, registry byte-identical, the LLM never sees the
  // tool). The `DefaultDeferredResultRegistry` is bounded by
  // `runtimeConfig().deferredCap` (QUANTA_DEFERRED_CAP); the tool closes over
  // THIS registry instance — the same one a future `defineToolAsync` caller
  // would register deferred work into. The registry is HOISTED as the named
  // `asyncDeferredRegistry` so a future producer can share it (B5: prevents
  // two independent mints that would make poll_deferred miss producer handles).
  const { tools: asyncDeferredTools, asyncDeferredRegistry } = buildAsyncDeferredTools()
  // ADR-0494 — gated `ask_user` (structured elicitation). Default-OFF: null
  // unless QUANTA_ASK_USER is on AND stdin is a TTY (headless ⇒ no prompter ⇒
  // no tool ⇒ byte-identical menu). The terminal prompter is owned here in the
  // app layer (the host layer is forbidden from touching process stdio).
  const askUserTool = buildCliAskUserTool(process.env)
  // gap-other-agent GAP 6 (ADR-0509) — gated `fetch_rules` (agent-requested
  // description-only rules). Default-OFF: null unless QUANTA_FETCH_RULES is on.
  // The port lazily loads the requestable-rules index from the workspace cwd.
  const fetchRulesTool = buildCliFetchRulesTool(process.cwd(), process.env)
  // A3 (jul-04 CLI-surfacing) — MINT the per-session Projects-KB store when
  // QUANTA_PROJECTS_KB is on so the INTERACTIVE REPL registers `projects_kb`
  // (the batch/mcp-server `buildBaseFromArgs` path already did; buildTooling did
  // NOT). The SAME store is returned on `Tooling.projectsKbStore` so the surface
  // wires `/kb` over the exact instance the tool writes into (one store, both
  // consumers). Mirrors the composition-root `resolveProjectsKbSlot`: real
  // `Date.now` clock; the KB-namespace SearchPipeline is not reachable here ⇒
  // omitted (the tool's body-FREE lexical fallback, still leak-safe). Absent gate
  // ⇒ `undefined` ⇒ no tool, no store (byte-identical default-OFF).
  const projectsKbSlot: ProjectsKbSlot | undefined = gateOn(process.env, "QUANTA_PROJECTS_KB")
    ? { store: createProjectsKbStore({ now: () => Date.now() }) }
    : undefined
  const extraTools: Tool[] = [
    ...(searchWire !== null ? [searchWire.tool] : []),
    ...asyncDeferredTools,
    ...(askUserTool !== null ? [askUserTool] : []),
    ...(fetchRulesTool !== null ? [fetchRulesTool] : []),
    ...astGrepTools,
  ]
  // Forward asyncDeferredRegistry for use when needed (currently unused by
  // producers but declared here so the variable is in scope — prevents a future
  // lint-unused warning turning into a dead-variable trap).
  void asyncDeferredRegistry
  return buildToolingCore({
    store,
    embedder,
    sessionId,
    memoryConfig,
    subagentConfig,
    skillsConfig,
    compactionBreakerConfig,
    verifyGuardConfig,
    mcpTools,
    lspTools,
    lspNavTools,
    gitToolList,
    ...(extraTools.length > 0 ? { extraTools } : {}),
    ...(searchWire !== null
      ? {
          searchPipeline: searchWire.pipeline,
          // L5 M-11 — thread THIS session's wire teardown (delta-scan interval
          // + indexer) up to the session close stack, per-session (not via the
          // module singleton). Bound so the disposer carries the wire identity.
          searchPipelineDispose: () => searchWire.dispose(),
        }
      : {}),
    slog,
    // ADR-0555 — RESOLVED kind (never the raw `QUANTA_MEMORY` token the CLI seeds
    // as "1"); the banner now also prints for the default/unset case.
    memoryKindLabel: memory.kind,
    memoryStorePath: memory.storePath,
    memoryEmbedProvenance: memoryEmbedProvenance(),
    onMemoryReady: (line) => logger.info(line),
    ...(sandboxProfile !== undefined ? { sandboxProfile } : {}),
    // ADR-0464 — CLI surface owns the env read; default-ON in the CLI is seeded
    // by the gate-default block in index.ts (so unset ⇒ "1" ⇒ tool registered).
    ...(readCliKnob("QUANTA_ENABLE_STRUCTURED_PATCH", "bool") ? { structuredPatch: true } : {}),
    // ADR-0165 — same posture as structuredPatch: CLI owns the env read,
    // default-ON via the SSOT-derived gate-default seed in index.ts.
    ...(readCliKnob("QUANTA_COVERAGE_TOOL", "bool") ? { coverageCheck: true } : {}),
    ...(budgetRemainingPercent !== undefined ? { budgetRemainingPercent } : {}),
    ...(providerRateLimitRemainingPercent !== undefined
      ? { providerRateLimitRemainingPercent }
      : {}),
    // A3 (jul-04) — thread the minted Projects-KB slot so `buildDefaultTools`
    // registers `projects_kb` over it AND `buildToolingCore` carries the SAME
    // store up on `Tooling.projectsKbStore`. Omitted when the gate is off
    // (byte-identical default-OFF menu).
    ...(projectsKbSlot !== undefined ? { projectsKb: projectsKbSlot } : {}),
    // RFC04-2/3 (hot-reload) — expose the registry-rebuild closure ONLY when
    // `QUANTA_MCP_HOT_RELOAD` is on, so the composition root can build the reload
    // controller's rebuild port (relist → this SAME assembly → snapshot). Gate
    // off ⇒ omitted ⇒ no closure captured (byte-identical).
    ...(mcpHotReloadEnabled() ? { exposeRebuild: true } : {}),
  })
}

// ── ADR-0024 god-module split: the argv / flag-gate accessors, the MCP plumbing,
//    and the per-turn shell-snapshot composition now live in `./internal/*`.
//    Re-exported here verbatim so every existing importer keeps resolving the
//    complete original public surface from `./internal`.
export {
  argvImages,
  argvPrompt,
  astGrepEnabled,
  gitCoChangeEnabled,
  gitToolsEnabled,
  hasArg,
  idModeEnabled,
  lspEnabled,
  newSessionFlag,
  observeDir,
  planEnabled,
  playbookTriggerFlag,
  resumePath,
  statePath,
  titleFlag,
} from "./internal/argv"
export type { Features, LoadFeaturesOpts } from "./internal/mcp"
export {
  mcpAutoRestartEnabled,
  readMcpConfig,
  resolveMcpConfigPath,
  resolveMcpLaunchPolicy,
  resolveMcpOAuthProvider,
} from "./internal/mcp"
export type { BuildShellSnapshotConfigOpts } from "./internal/shell-snapshot"
export { buildShellSnapshotConfig } from "./internal/shell-snapshot"
export type { ResolveResumeInput, ResumeResolution } from "./resume"
// ── Resume state machine (`isPathLikeToken`, `defaultUntitled`, `resolveResume`
//    + types) lives in `./resume` (ADR-0024 split). Re-exported here so existing
//    importers (`index.ts`, tests) continue to resolve them from `./internal`.
export {
  defaultUntitled,
  isPathLikeToken,
  resolveResume,
} from "./resume"
