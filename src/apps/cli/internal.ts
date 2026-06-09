import { spawn as spawnChild } from "node:child_process"
import { chmod, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join as joinPath } from "node:path"
import {
  canonicalizeTrustedPaths,
  filterMcpServersByPolicy,
  type McpLaunchPolicy,
  mergeDiskLayers,
  osManagedSettingsPath,
  parseSettingSources,
  readDiskLayers,
  type TrustRecord,
  TrustStore,
} from "@/config"
import type { ElicitationPrompterFactory, SamplingWiringInput } from "@/agent"
import {
  type AgentConfig,
  applyMcpClientWiring,
  loadMcpTools,
  lspDiagnosticsTool,
  lspNavToolList,
  type McpStoppable,
  type PersonaKind,
  resolvePersona,
} from "@/agent"
import { defaultIdentityProvider, type IdentityMode } from "@/agent/identity"
import {
  createCliOAuthCallback,
  deriveChallengeS256,
  generateCodeVerifier,
  generateState,
  resolveQuantaHome,
} from "@/auth/chatgpt-oauth"
import type { FetchPort, TokenRecord, TokenStorePort } from "@/connectors"
import {
  buildMcpOAuthWiring,
  buildRootsWiring,
  buildSamplingWiring,
  type McpBrowserFlowResult,
  type McpOAuthDeps,
  pickMcpNegotiator,
  resolveMcpOAuthKeyringOption,
} from "@/host/runtime"
import type { CredentialSource, LLMPort } from "@/llm"
import {
  type CapabilityNegotiator,
  DEFAULT_BACKOFF_POLICY,
  type ElicitationPrompter,
  McpClient,
  type McpClientTransport,
  type McpOAuthProviderPort,
  type McpServerConfig,
  type RootsProviderPort,
  type SamplingHandlerPort,
  type SupervisableMcpClient,
  type SupervisorDeps,
} from "@/mcp"
import { Metrics, type StructuredLogger } from "@/observability"
import type { PermissionContext, PermissionMode } from "@/permission"
import {
  buildCompactionBreakerConfigCore,
  buildCredentialSource,
  buildEmbedderCore,
  buildLLMWithByokCore,
  buildMainLLMCore,
  buildMemoryForSession,
  buildSearchPipelineFromEnv,
  buildSkillsConfigCore,
  type buildStoreCore,
  buildStreamingCore,
  buildSubagentConfigCore,
  buildSummarizerLlmCore,
  buildToolingCore,
  buildVerifyGuardConfigCore,
  composeLLMCore,
  DEFAULT_MODEL,
  type MainLlmAssembleInput,
  parseEnvFlag,
  parseFallbackModels,
  parseRecallTiers,
  pickProviderCore,
  type Provider as RunnerProvider,
  resolveMemoryConfigFromEnv,
  selectLlmTransport,
} from "@/runner/assemble"
import type { Tooling } from "@/runner/assemble/tooling"
import { type AutoTitlePort, createAutoTitlePort } from "@/runner/session-ops/auto-title"
import { resolveSandboxProfileFromEnv } from "@/runtime"
import {
  createBunSpawner,
  createShellSnapshotPort,
  type ShellSnapshotPort,
} from "@/runtime/shell-snapshot"
import type { ShellSnapshotMetric } from "@/runtime/shell-snapshot/metric-port"
import { loadSessionById, renameSession } from "@/session"
import { logger, type RunContext, runtimeConfig } from "@/shared"
import { MCPRootSchema, PLUGIN_MCP_FILE } from "@/skill/plugin-manifest"
import type { AssistantTextPainter, StreamPort } from "@/stream"
import {
  gitTools,
  mcpResourcesTools,
  pollDeferredTool,
  type ResourcesHandle,
  type Tool,
} from "@/tool"
import { DefaultDeferredResultRegistry } from "@/tool/deferred/default-registry"
import { buildCliAskUserTool } from "./ask-user-wire"
import { readCliKnob } from "./cli-knobs-accessor"
import { buildCliFetchRulesTool } from "./fetch-rules-wire"
import { createMarkdownPainter } from "./markdown-painter"
import { buildCliElicitationPrompterFactory } from "./mcp-elicitation-prompter"
import { isPathLikeToken } from "./resume"
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
  return defaultIdentityProvider().identityFor(raw as IdentityMode)
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
  })
}

/** Default model id per provider — re-exported from the runner barrel (the
 *  single source of truth the three app entry points used to each duplicate). */
export { DEFAULT_MODEL }

/**
 * Build the long-term memory store from env. ADR-0413 changed the default
 * from OFF to ON. The default-ON store is the VOLATILE `InMemoryStore` (no
 * disk side effect — TKT-003 req #4): unset / bare-truthy `QUANTA_MEMORY`
 * (`1` / `true` / `on` / `""` / unknown) ⇒ volatile InMemoryStore.
 * `QUANTA_MEMORY=sqlite` ⇒ on-disk SqliteStore (the ONLY persistent opt-in;
 * path from `QUANTA_MEMORY_PATH`, default `.quanta/memory.sqlite`).
 * `QUANTA_MEMORY=memory` ⇒ volatile InMemoryStore (explicit). `=off` / `0` /
 * `false` / `no` ⇒ no store (legacy default-OFF byte-identical escape hatch).
 *
 * Long-term memory env:
 *   QUANTA_MEMORY              on (default, volatile) | off | 0 | 1 | sqlite | memory | …
 *   QUANTA_MEMORY_PATH         override sqlite path (sqlite kind only; default `.quanta/memory.sqlite`)
 *   QUANTA_MEMORY_EMBED        openai (default when store + OPENAI_API_KEY) | off
 *   QUANTA_MEMORY_EMBED_MODEL  override embedding model (else adapter default)
 *   QUANTA_MEMORY_RECALL_LIMIT int → memory.recallLimit
 *   QUANTA_MEMORY_DISTILL      off → memory.distill=false
 *   QUANTA_MEMORY_CONSOLIDATE  off → memory.consolidate=false
 *   QUANTA_MEMORY_SELF_EDIT    off → memory.selfEditTools=false (also skips
 *                              registering the memory_* self-edit tools)
 *   QUANTA_MEMORY_RECALL_TIERS comma list of episodic,semantic →
 *                              memory.recallTiers (invalid/empty ⇒ omitted)
 *   QUANTA_MEMORY_AUTO         on (default) | off — cross-session auto-trigger
 *   QUANTA_MEMORY_THRESHOLD    float → auto-trigger promote threshold (default 0.7)
 *   QUANTA_MEMORY_MIN_USAGE    int → auto-trigger minUsageCount gate (default 1)
 *
 * Legacy shim — implementation delegates to ADR-0413
 * `buildMemoryForSession` so the default-ON contract is centralized.
 */
export const buildStore = (): ReturnType<typeof buildStoreCore> =>
  buildMemoryForSession(process.env).store

/**
 * Build the semantic embedder from env. Default OFF so lexical-only recall is
 * unchanged: enabled only when a `store` exists, `QUANTA_MEMORY_EMBED` is not
 * `off`, and `OPENAI_API_KEY` is set (reusing the OpenAI env pattern from
 * `buildLLM`). Absent ⇒ pure lexical/tag/freshness recall, zero behavior
 * change vs today.
 */
export const buildEmbedder = (
  store: ReturnType<typeof buildStoreCore>,
): ReturnType<typeof buildEmbedderCore> =>
  buildEmbedderCore({
    store,
    // ADR-0503 P4: routed through the typed accessor (was gateDisabled). The
    // knob default is ON, so disabled = NOT readBool(raw, true) — byte-identical
    // to gateDisabled (both treat unset/empty/unrecognized as ON, falsy as off).
    disabled: !(readCliKnob("QUANTA_MEMORY_EMBED", "bool") ?? true),
    ...(process.env.OPENAI_API_KEY !== undefined ? { apiKey: process.env.OPENAI_API_KEY } : {}),
    ...(process.env.OPENAI_BASE_URL !== undefined ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    ...(process.env.QUANTA_MEMORY_EMBED_MODEL !== undefined
      ? { model: process.env.QUANTA_MEMORY_EMBED_MODEL }
      : {}),
  })

/** Re-export the pure helper so existing tests
 *  (`tests/unit/env-knob-branches.test.ts`) keep resolving it from
 *  `./internal`. */
export { parseRecallTiers }

/**
 * Build the `memory` tuning block from env. ADR-0414 single-source-of-truth:
 * this is a THIN shim that delegates the env → config projection to the
 * factory's {@link resolveMemoryConfigFromEnv} — the SAME helper
 * `buildMemoryForSession` uses internally. The CLI no longer re-reads any
 * `QUANTA_MEMORY_*` tuning knob (recallLimit / distill / consolidate /
 * selfEdit / recallTiers); that truth lives in exactly one place.
 *
 * Contract (unchanged, now centralized):
 *   - `store === undefined` + no knobs ⇒ `undefined` (key omitted).
 *   - `store === undefined` + any sub-knob set ⇒ a block carrying that knob
 *     (the loop's `config.store` check is separate; the block is informational
 *     until a store is wired). This is the legacy escape-hatch symmetry: a
 *     caller that already opted out of the store can still surface a tuning
 *     block when an operator set a sub-knob.
 *   - `store` present ⇒ a truthy block (possibly empty) so the loop wires it.
 *
 * The `store` argument is forwarded verbatim to the factory helper, which
 * uses it ONLY to decide whether an empty block is still returned — never to
 * change a knob value. Byte-identical config bytes for the same env.
 */
export const buildMemoryConfig = (
  store: ReturnType<typeof buildStoreCore>,
): AgentConfig["memory"] | undefined => resolveMemoryConfigFromEnv(process.env, store)

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
): AgentConfig["subagent"] | undefined => {
  const enabled = readCliKnob("QUANTA_SUBAGENT", "bool") ?? true
  const depth = readCliKnob("QUANTA_SUBAGENT_MAX_DEPTH", "int")
  // ADR-0041 — parallel-worker (6-tool) router. CLI default-ON is seeded by the
  // gate block in index.ts (QUANTA_SUBAGENT_6TOOLS), so the agent can fan out
  // background `spawn_agent`/`wait_agent` workers. `QUANTA_SUBAGENT_6TOOLS=0`
  // (or QUANTA_SUBAGENT=0) disables. exec_command's model-supplied cwd is jailed
  // to the workspace by the loop assembly; dangerous commands still pass the
  // permission/HITL gate.
  const enable6Tools = enabled && (readCliKnob("QUANTA_SUBAGENT_6TOOLS", "bool") ?? true)
  const conc = readCliKnob("QUANTA_SUBAGENT_MAX_CONCURRENT", "int")
  // Companions to the parallel-worker router: `spawn_batch` (fan a prompt list
  // out in one call) + `list_agents` (see the spawned workers). Default-ON under
  // QUANTA_SUBAGENT; `QUANTA_SUBAGENT_BATCH=0` / `QUANTA_SUBAGENT_INTROSPECT=0`
  // disable individually. Zero-adapter: both ride the existing runner/registry.
  const enableBatchSpawn = enabled && (readCliKnob("QUANTA_SUBAGENT_BATCH", "bool") ?? true)
  const enableIntrospect = enabled && (readCliKnob("QUANTA_SUBAGENT_INTROSPECT", "bool") ?? true)
  // §25.1 — `run_workflow` (LLM-authored declarative orchestration). DEFAULT-OFF
  // (gateOn ⇒ must be explicitly QUANTA_WORKFLOW=on/1): it fans out a tree of
  // subagents, so it opts in rather than riding the default subagent-ON seed.
  const enableWorkflow = enabled && (readCliKnob("QUANTA_WORKFLOW", "bool") ?? false)
  // GAP7-4 — `spawn_agents_on_csv` (CSV batch fan-out). DEFAULT-OFF (opt-in: it
  // spawns one child per row, so it does not ride the default subagent-ON seed).
  const enableSpawnAgentsCsv = enabled && (readCliKnob("QUANTA_SPAWN_AGENTS_CSV", "bool") ?? false)
  return buildSubagentConfigCore({
    enabled,
    ...(depth !== undefined ? { maxDepth: depth } : {}),
    ...(taskRegistry !== undefined ? { taskRegistry } : {}),
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
export const buildVerifyGuardConfig = (): AgentConfig["verifyGuard"] | undefined => {
  const enabled = process.env.QUANTA_VERIFY_GUARD !== undefined
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

/** jun-6 (RFC jun-6-ai-session-title) — TRUE iff a title is still the
 *  auto/placeholder value (safe to overwrite). A fresh id-mode session is
 *  seeded with `defaultUntitled(now)` (`"Untitled YYYY-MM-DD HH:mm"`); an empty
 *  title is also a placeholder. Anything else ⇒ a human (or a prior auto-title)
 *  named it ⇒ the titler MUST yield (don't-clobber). Mirrors the leaf's
 *  injected-predicate contract so the leaf never encodes the seeded-title shape. */
const isAutoTitlePlaceholder = (title: string): boolean =>
  title === "" || title.startsWith("Untitled")

/** jun-6 (RFC jun-6-ai-session-title) — build the fire-and-forget AI session
 *  titler at the CLI composition root, MIRRORING the `QUANTA_COMPACT_MODEL`
 *  second-LLM construction (`buildSummarizerLlm`): a CHEAP `LLMPort` is built
 *  synchronously from `QUANTA_SESSION_TITLE_MODEL` and injected into
 *  `createAutoTitlePort` alongside the real `renameSession` writer +
 *  `loadSessionById` title-reader + placeholder predicate + clock.
 *
 *  DEFAULT-OFF BYTE-IDENTITY (RFC §1.2): returns `undefined` unless
 *  `runtimeConfig().sessionAutoTitle` is on AND `sessionTitleModel` resolves a
 *  cheap port. Absent ⇒ no `AgentConfig.autoTitlePort` ⇒ the loop's first-turn
 *  title branch is dead ⇒ no extra LLM call, no title write (byte-identical).
 *  The cheap port NEVER falls back to the expensive main model — an armed
 *  `sessionAutoTitle` with no `sessionTitleModel` stays inert (the cost gate).
 *
 *  `seamLlm` is a TEST seam (mirrors `buildSummarizerLlm`/`buildLLM` DI): a
 *  reachability test injects a fake cheap LLM so the titler runs without a real
 *  provider key. Production omits it ⇒ the cheap port is built from env via the
 *  proven `buildSummarizerLlmCore` (retry-wrapped, same as the main stack). */
export const buildAutoTitlePort = (
  mainProvider: Provider,
  signal: AbortSignal,
  seamLlm?: LLMPort,
): AutoTitlePort | undefined => {
  const cfg = runtimeConfig()
  if (!cfg.sessionAutoTitle) return undefined
  const llm =
    seamLlm ??
    buildSummarizerLlmCore({
      mainProvider,
      signal,
      model: cfg.sessionTitleModel,
      env: process.env,
    })
  // No cheap model ⇒ inert (NEVER the expensive main model). Both the knob AND
  // the model must be present (advertise-iff-able), exactly like the compaction
  // summarizer's `QUANTA_COMPACT_MODEL` gate.
  if (llm === undefined) return undefined
  return createAutoTitlePort({
    llm,
    rename: (id, title) => renameSession(id, title),
    currentTitle: async (id) => (await loadSessionById(id))?.meta.title,
    isPlaceholder: isAutoTitlePlaceholder,
    clock: () => Date.now(),
  })
}

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

export const hasArg = (flag: string): boolean => process.argv.slice(2).includes(flag)

/** Resolve the state-file path: `--state <p>` / `QUANTA_STATE_PATH`. Default OFF. */
export const statePath = (): string | undefined => {
  const idx = process.argv.indexOf("--state")
  if (idx >= 0) return process.argv[idx + 1]
  return process.env.QUANTA_STATE_PATH
}

/** Resolve the resume token: `--resume <token>` / `QUANTA_RESUME`. Default OFF.
 *  The token is EITHER a filesystem path (V1 path-mode) OR an opaque session
 *  id (V2 id-mode). Classification is done by {@link isPathLikeToken} at the
 *  call-site so this helper stays a pure env/argv accessor. */
export const resumePath = (): string | undefined => {
  const idx = process.argv.indexOf("--resume")
  if (idx >= 0) return process.argv[idx + 1]
  return process.env.QUANTA_RESUME
}

// `isPathLikeToken` moved to `./resume`; re-exported via the barrel block at
//  the bottom of this file so existing importers still resolve it from
//  `internal`. The local `idModeEnabled` below uses the imported binding.

/** True when the run is in id-mode: a `--resume <id>` whose token is NOT
 *  path-like, OR `--new-session` was passed (mints a fresh id). The CLI uses
 *  this to auto-save to the session store after each turn. */
export const idModeEnabled = (): boolean => {
  if (hasArg("--new-session")) return true
  const token = resumePath()
  if (token === undefined) return false
  return !isPathLikeToken(token)
}

/** Resolve the `--new-session` flag for id-mode startup. */
export const newSessionFlag = (): boolean => hasArg("--new-session")

/** ADR-0301 — Resolve the `--playbook-trigger` CLI flag echo. Boolean (no
 *  value); presence ⇒ `true`, absence ⇒ `false`. The wire helper enforces
 *  the env-on-wins precedence — this is just the surface-side argv scan.
 *  Mirrors `newSessionFlag()` for SOLID/SRP. */
export const playbookTriggerFlag = (): boolean => hasArg("--playbook-trigger")

/** Resolve the `--title <t>` flag (used by `--new-session`). */
export const titleFlag = (): string | undefined => {
  const idx = process.argv.indexOf("--title")
  if (idx >= 0) return process.argv[idx + 1]
  return undefined
}

/** Resolve the observe dir: `--observe-dir <d>` / `QUANTA_OBSERVE_DIR`.
 *  Default OFF (undefined) → current behavior byte-identical. */
export const observeDir = (): string | undefined => {
  const idx = process.argv.indexOf("--observe-dir")
  if (idx >= 0) return process.argv[idx + 1]
  return process.env.QUANTA_OBSERVE_DIR
}

/** Plan mode is on when `QUANTA_PLAN=1` or `--plan` is present. */
export const planEnabled = (): boolean =>
  (readCliKnob("QUANTA_PLAN", "bool") ?? false) || hasArg("--plan")

/** LSP diagnostics tool is on when `QUANTA_LSP=1` or `--lsp` is present.
 *  Default OFF: `defaultTools` already registers a no-op `diagnostics`; this
 *  only swaps in the real language-server-backed provider when asked. The
 *  bridge itself still degrades gracefully if a server binary is absent. */
export const lspEnabled = (): boolean =>
  (readCliKnob("QUANTA_LSP", "bool") ?? false) || hasArg("--lsp")

/** Codex `may-20-codex-lsp.md` absorption (ADR-0015). LSP NAV tools
 *  (definition / references / hover / type_definition / implementation /
 *  document_symbol / workspace_symbol / rename_preview) are NOT in
 *  `defaultTools` — they expand the tool surface, so opt-in only via
 *  `QUANTA_LSP_TOOLS=full`. With the knob unset the registry is byte-identical. */
export const lspNavEnabled = (): boolean => process.env.QUANTA_LSP_TOOLS === "full"

/** Codex `may-20-codex-signal.md` absorption (ADR-0016). First-class
 *  git tools (diff/status/log/blame) are NOT in `defaultTools` to keep the
 *  default registry byte-identical. Opt-in via `QUANTA_GIT_TOOLS=1`. */
export const gitToolsEnabled = (): boolean => readCliKnob("QUANTA_GIT_TOOLS", "bool") ?? false

/** §7.2 long-tail — co-change / related-files tool gate. Default-OFF; opt-in via
 *  `QUANTA_GIT_CO_CHANGE=1`. Rides the git-tools surface (so it ALSO requires
 *  QUANTA_GIT_TOOLS — the co-change tool is appended to the git tool set). */
export const gitCoChangeEnabled = (): boolean =>
  (readCliKnob("QUANTA_GIT_CO_CHANGE", "bool") ?? false) === true

/** MCP crash-detection + auto-restart (ADR-0435). Default-OFF: when unset,
 *  `loadMcpTools` runs the single-client path and MCP behavior is
 *  byte-identical. `QUANTA_MCP_AUTORESTART=1` wraps every server in a
 *  {@link McpReconnectSupervisor} (2-phase exponential backoff + full-jitter,
 *  stability reset, storm cap → DEGRADED). */
export const mcpAutoRestartEnabled = (): boolean =>
  parseEnvFlag(process.env.QUANTA_MCP_AUTORESTART, false)

/** Build the injected {@link SupervisorDeps} for one MCP server. The real
 *  clock/timer/RNG are injected ONLY here, at the composition root — the
 *  supervisor core itself never reaches for a global. The factory picks the
 *  legacy `McpClient`; the isolated client is selected by its own env knob
 *  inside `McpClient` construction is out of scope (the isolated path keeps its
 *  separate wire), so we use the default client here.
 *
 *  B1 + H19 — the inbound-capability wiring bundle (`{ negotiator, handler?,
 *  rootsProvider? }`) is BAKED into the restart factory via the SAME
 *  `applyMcpClientWiring` helper the single-client path uses, so the supervisor —
 *  which owns the lifecycle, not the policy — re-applies it to EVERY (re)connected
 *  client. A reconnected client therefore re-advertises `sampling`/`roots` and
 *  re-handles inbound `sampling/createMessage` + `roots/list`. Absent ⇒ a vanilla
 *  `new McpClient(c)` (byte-identical to the pre-wire supervised path).
 *
 *  `transportFor` is the optional test seam (mirrors the single-client path) so a
 *  supervised client can be driven by a scripted transport without a real spawn;
 *  production omits it (the client builds its default carrier). */
const mcpSupervisorDepsFor = (
  slog: StructuredLogger,
  wiring: SamplingWiringInput | undefined,
  transportFor: ((config: McpServerConfig) => McpClientTransport) | undefined,
  oauthProvider: McpOAuthProviderPort | undefined,
) => {
  return (_config: McpServerConfig): SupervisorDeps => ({
    factory: (c): SupervisableMcpClient => {
      const clientOpts: NonNullable<ConstructorParameters<typeof McpClient>[1]> = {}
      if (transportFor !== undefined) clientOpts.transport = transportFor(c)
      // H18 (jun-06 live-wire) — bake the OAuth provider into the restart factory
      // via the SAME helper the single-client path uses, so a reconnected client
      // RE-resolves a bearer for an `oauth:true` server. Absent ⇒ headless
      // rejecter (byte-identical to the pre-wire supervised path).
      applyMcpClientWiring(clientOpts, wiring, oauthProvider)
      return new McpClient(c, clientOpts)
    },
    policy: DEFAULT_BACKOFF_POLICY,
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms)
      return () => clearTimeout(t)
    },
    onStateChange: (s) =>
      slog.info("mcp.supervisor.state", { server: s.serverName, state: s.state }),
  })
}

// ── H18 (jun-06) — live-wire the MCP OAuth provider at the composition root ──
//
// The keyring slice + `buildMcpOAuthWiring` + `resolveMcpOAuthKeyringOption`
// were sealed but had NO LIVE CALLER (the bridge never set
// `clientOpts.oauthProvider`). The block below assembles the connectors-backed
// provider — file token store (0600) + injected fetch/clock/browser-flow/issuer
// — and threads it (with the keyring composition baked into its token store)
// into BOTH MCP-load paths. Default-OFF: `QUANTA_MCP_OAUTH` unset ⇒
// `buildMcpOAuthWiring` returns `{ provider: undefined }` ⇒ no provider wired ⇒
// byte-identical to today's no-auth load.

/** A file-backed, multi-server `TokenStorePort` (one 0600 JSON file per server
 *  under `<quanta-home>/mcp-oauth/`). This is the H18 default token store the
 *  keyring DECORATOR (`composeTokenStore`) wraps when
 *  `QUANTA_MCP_OAUTH_KEYRING=1`; OFF ⇒ it is used directly (byte-identical to
 *  the documented "0600 file by default" H18 store). Tokens are NEVER logged —
 *  they live only in the 0600 file and the in-memory record. NO-THROW reads
 *  (a corrupt/absent file ⇒ `undefined` ⇒ the provider re-auths) so a bad file
 *  never crashes the MCP load. */
const createFileMcpTokenStore = (dir: string): TokenStorePort => {
  const safe = (id: string): string => id.replace(/[^A-Za-z0-9_.-]+/g, "_")
  const fileFor = (id: string): string => joinPath(dir, `${safe(id)}.json`)
  return {
    async read(id: string): Promise<TokenRecord | undefined> {
      try {
        const raw = await readFile(fileFor(id), "utf8")
        const parsed = JSON.parse(raw) as unknown
        if (parsed === null || typeof parsed !== "object") return undefined
        const o = parsed as Record<string, unknown>
        if (typeof o.accessToken !== "string" || typeof o.tokenType !== "string") return undefined
        return o as unknown as TokenRecord
      } catch {
        // Absent / unreadable / malformed ⇒ treat as "no token" (re-auth path).
        return undefined
      }
    },
    async write(id: string, record: TokenRecord): Promise<void> {
      await mkdir(dir, { recursive: true })
      const path = fileFor(id)
      const tmp = `${path}.tmp`
      await writeFile(tmp, `${JSON.stringify(record)}\n`, "utf8")
      if (process.platform !== "win32") await chmod(tmp, 0o600)
      await rename(tmp, path)
    },
    async delete(id: string): Promise<void> {
      try {
        await unlink(fileFor(id))
      } catch {
        // Idempotent — an absent file is fine.
      }
    },
  }
}

/** The production `FetchPort` for OAuth discovery / DCR / token exchange: a thin
 *  shape adapter over `globalThis.fetch` (read at the root only). */
const realMcpFetchPort: FetchPort = async (url, init) => {
  const res = await fetch(url, {
    ...(init?.method !== undefined ? { method: init.method } : {}),
    ...(init?.headers !== undefined ? { headers: init.headers as Record<string, string> } : {}),
    ...(init?.body !== undefined ? { body: init.body } : {}),
    ...(init?.signal !== undefined ? { signal: init.signal } : {}),
  })
  return { status: res.status, ok: res.ok, text: () => res.text() }
}

/** A generic RFC 6749 §4.1 authorization-code + PKCE browser flow for an MCP
 *  server, REUSING the surface-agnostic loopback callback receiver
 *  (`createCliOAuthCallback`, the SAME seam the chatgpt-oauth `/login` flow uses)
 *  and the chatgpt-oauth PKCE helpers. It builds a STANDARD authorize URL
 *  against the DISCOVERED `authorizeEndpoint` (not the OpenAI-specific URL that
 *  `runBrowserFlow` hard-codes), so it works against any RFC-8414 issuer the H18
 *  provider discovered. Returns `{ code, verifier, redirectUri }` for the host
 *  provider to exchange (the exchange + refresh live in the connectors-backed
 *  provider; this only obtains the code). The authorization code is NEVER
 *  logged. */
const runMcpBrowserFlow = async (input: {
  readonly authorizeEndpoint: string
  readonly clientId: string
  readonly serverName: string
}): Promise<McpBrowserFlowResult> => {
  const verifier = generateCodeVerifier()
  const challenge = deriveChallengeS256(verifier)
  const state = generateState()
  const callback = createCliOAuthCallback()
  const handle = await callback.start({ expectedState: state })
  const url = new URL(input.authorizeEndpoint)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", input.clientId)
  url.searchParams.set("redirect_uri", handle.redirectUri)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  logger.info("mcp-oauth: opening browser for authorization", { server: input.serverName })
  // Open the user's browser (best-effort — a headless box can paste the URL the
  // callback receiver printed). Failure to open is non-fatal; the loopback
  // receiver still awaits the redirect.
  try {
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
    spawnChild(opener, [url.toString()], { stdio: "ignore", detached: true }).unref()
  } catch {
    // Opener unavailable ⇒ the receiver's printed URL is the fallback.
  }
  const result = await handle.received
  return { code: result.code, verifier, redirectUri: handle.redirectUri }
}

/** Resolve the per-server OAuth issuer from its config `url` origin (the
 *  standard MCP pattern: RFC 8414 discovery runs against the resource server's
 *  origin). A server without a `url` (stdio carrier) or without `oauth:true`
 *  yields `undefined` ⇒ the provider obtains no token for it (unauthenticated). */
const mcpIssuerResolver =
  (servers: ReadonlyArray<McpServerConfig>) =>
  (serverName: string): string | undefined => {
    const server = servers.find((s) => s.name === serverName)
    if (server?.oauth !== true || server.url === undefined) return undefined
    try {
      return new URL(server.url).origin
    } catch {
      return undefined
    }
  }

/** H18 (jun-06) — assemble the connectors-backed `McpOAuthProviderPort` for the
 *  CLI MCP load, or `undefined` when OFF. `buildMcpOAuthWiring` is the single
 *  gate: it returns a provider ONLY when `QUANTA_MCP_OAUTH=1` AND deps are
 *  present (the per-server `oauth:true` flag is the second gate, applied inside
 *  the `McpClient`). The keyring composition (`QUANTA_MCP_OAUTH_KEYRING`) is
 *  resolved here via `resolveMcpOAuthKeyringOption()` (the ONLY `process.platform`
 *  read for the keyring decision) and BAKED into the provider's token store, so
 *  the bridge never reaches for the keyring. When NO server opts into `oauth`,
 *  the deps are omitted ⇒ no provider (byte-identical, no file store created).
 *
 *  `opts.fetchPort` / `opts.browserFlow` / `opts.tokenStoreDir` / `opts.keyring`
 *  are test seams (inject a fake auth server + scripted browser flow + a tmp
 *  store dir + a fake-exec keyring option); production omits them. */
export const resolveMcpOAuthProvider = (
  servers: ReadonlyArray<McpServerConfig>,
  opts: {
    readonly fetchPort?: FetchPort
    readonly browserFlow?: typeof runMcpBrowserFlow
    readonly tokenStoreDir?: string
    readonly keyring?: ReturnType<typeof resolveMcpOAuthKeyringOption>
  } = {},
): McpOAuthProviderPort | undefined => {
  const enabled = runtimeConfig().mcpOAuth
  // Cheap short-circuit: no server opts into OAuth ⇒ no deps ⇒ no provider, and
  // crucially no file store directory created (byte-identical when the knob is
  // on but unused). Still routes through the gate so the OFF path is the
  // documented single decision point (returns `{ provider: undefined }`).
  const anyOAuth = servers.some((s) => s.oauth === true && s.url !== undefined)
  if (!enabled || !anyOAuth) return buildMcpOAuthWiring(enabled, undefined).provider
  const dir = opts.tokenStoreDir ?? joinPath(resolveQuantaHome(process.env), "mcp-oauth")
  const deps: McpOAuthDeps = {
    fetchPort: opts.fetchPort ?? realMcpFetchPort,
    tokenStore: createFileMcpTokenStore(dir),
    clockPort: { now: () => Date.now() },
    runBrowserFlow: opts.browserFlow ?? runMcpBrowserFlow,
    issuerFor: mcpIssuerResolver(servers),
  }
  return buildMcpOAuthWiring(enabled, deps, opts.keyring ?? resolveMcpOAuthKeyringOption()).provider
}

/**
 * ADR-0237 — per-turn shell-snapshot CLI composition.
 *
 * Default-OFF byte-identical: unless `QUANTA_SHELL_SNAPSHOT=1` (or the
 * `--shell-snapshot` flag) is set, this returns `undefined`. The assembled
 * `AgentConfig` then omits `shellSnapshot` entirely (RFC §1.2 default-OFF),
 * and every `runShell` spawn is the legacy `["bash","-lc",cmd]` argv. With
 * the knob set, a production {@link ShellSnapshotPort} is built with a
 * `Bun.spawn`-backed adapter ({@link createBunSpawner}) and the 5-knob block
 * is populated from sibling env vars:
 *
 *   QUANTA_SHELL_SNAPSHOT          1 → opt-in (also: `--shell-snapshot` arg)
 *   QUANTA_SHELL_SNAPSHOT_SHELL    auto | zsh | bash   (default "auto" =
 *                                   `$SHELL` basename detection)
 *   QUANTA_SHELL_SNAPSHOT_TURN     "0" → one-shot at session start (default
 *                                   on → capture at every turn-start)
 *   QUANTA_SHELL_SNAPSHOT_CLEANUP  int ms cutoff for the age-based prune
 *                                   (default 864e5*10 = 10 days)
 *   QUANTA_SHELL_SNAPSHOT_MAX_MB   int MB ceiling for the directory; over
 *                                   budget ⇒ oldest-first eviction at
 *                                   session-start prune (default 100MB)
 *   QUANTA_SHELL_SNAPSHOT_TIMEOUT  int ms cap on each `Bun.spawn` capture
 *                                   call (the {@link createBunSpawner}
 *                                   `defaultTimeoutMs`; default 10 000)
 *
 * The current `$SHELL` is forwarded as `shellEnv` so `resolveShell("auto")`
 * can pick the right adapter without violating the @/agent slice invariant
 * (no `process.env` reads inside the loop).
 *
 * Returns the literal `AgentConfig["shellSnapshot"]` shape so the caller
 * can spread it conditionally into `SessionDeps.shellSnapshot`.
 */
/** Optional dependencies for {@link buildShellSnapshotConfig}. */
export interface BuildShellSnapshotConfigOpts {
  /** ADR-0222 — wired shell-snapshot metric port. Caller produces this via
   *  `wireShellSnapshotMetric(metrics)` (or the bundle helper
   *  `wireNewSlices(metrics).shellSnapshot`). Absent ⇒ no metric injection
   *  (byte-identical legacy). */
  readonly metric?: ShellSnapshotMetric
}

export const buildShellSnapshotConfig = (
  opts: BuildShellSnapshotConfigOpts = {},
): AgentConfig["shellSnapshot"] | undefined => {
  const enabled =
    (readCliKnob("QUANTA_SHELL_SNAPSHOT", "bool") ?? false) || hasArg("--shell-snapshot")
  if (!enabled) return undefined
  const intEnv = (key: string): number | undefined => {
    const raw = process.env[key]
    if (raw === undefined) return undefined
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const timeoutMs = intEnv("QUANTA_SHELL_SNAPSHOT_TIMEOUT")
  // Spawner timeout: pass-through ONLY when set (the factory has its own
  // safe default that mirrors the capture adapter default).
  const spawner = createBunSpawner(timeoutMs !== undefined ? { defaultTimeoutMs: timeoutMs } : {})
  // ADR-0222 wire — optional metric port. Absent ⇒ no allocation, byte-
  // identical to legacy (the factory checks `metric === undefined`).
  const port: ShellSnapshotPort = createShellSnapshotPort(
    spawner,
    opts.metric !== undefined ? { metric: opts.metric } : undefined,
  )
  const rawShell = process.env.QUANTA_SHELL_SNAPSHOT_SHELL
  const shell: "auto" | "zsh" | "bash" =
    rawShell === "zsh" || rawShell === "bash" || rawShell === "auto" ? rawShell : "auto"
  const cleanupOlderThanMs = intEnv("QUANTA_SHELL_SNAPSHOT_CLEANUP")
  const maxMb = intEnv("QUANTA_SHELL_SNAPSHOT_MAX_MB")
  const maxSizeBytes = maxMb !== undefined ? maxMb * 1024 * 1024 : undefined
  // QUANTA_SHELL_SNAPSHOT_TURN: "0" ⇒ one-shot capture at session start, any
  // other value (including unset / "1") ⇒ per-turn capture (the helper
  // default). Explicit literal so a typo (e.g. "off", "false") falls through
  // to the safer per-turn default.
  const captureAtTurnStart = process.env.QUANTA_SHELL_SNAPSHOT_TURN !== "0"
  // shellEnv: pass through $SHELL ONCE so resolveShell can do basename
  // detection without the agent slice peeking at process.env (ADR-0144).
  const shellEnv = process.env.SHELL
  return {
    port,
    shell,
    captureAtTurnStart,
    ...(cleanupOlderThanMs !== undefined ? { cleanupOlderThanMs } : {}),
    ...(maxSizeBytes !== undefined ? { maxSizeBytes } : {}),
    ...(shellEnv !== undefined ? { shellEnv } : {}),
  }
}

/** MCP config path resolver. Supports the legacy wrapper file
 *  (`QUANTA_MCP_CONFIG`) and the thinner browser/plugin bridge:
 *    - `QUANTA_BROWSER_MCP_CONFIG` → direct path to a plugin-style `.mcp.json`
 *    - `QUANTA_BROWSER_MCP_PLUGIN_DIR` → plugin root; we append `/.mcp.json`
 *  Precedence is explicit config first so existing callers stay byte-identical. */
export const resolveMcpConfigPath = (
  envSource: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  const explicit = envSource.QUANTA_MCP_CONFIG?.trim()
  if (explicit) return explicit
  const browserConfig = envSource.QUANTA_BROWSER_MCP_CONFIG?.trim()
  if (browserConfig) return browserConfig
  const browserPluginDir = envSource.QUANTA_BROWSER_MCP_PLUGIN_DIR?.trim()
  if (browserPluginDir) return `${browserPluginDir.replace(/\/+$/, "")}/${PLUGIN_MCP_FILE}`
  return undefined
}

const pluginSpecToServerConfig = (
  name: string,
  spec: {
    command: string
    args: string[]
    env?: Record<string, string> | undefined
    url?: string | undefined
    headers?: Record<string, string> | undefined
  },
): McpServerConfig => ({
  name,
  command: spec.command.length > 0 ? [spec.command, ...spec.args] : [],
  ...(spec.env !== undefined ? { env: spec.env } : {}),
  ...(spec.url !== undefined ? { url: spec.url } : {}),
  ...(spec.headers !== undefined ? { headers: spec.headers } : {}),
})

/** Read MCP server configs from a config file. Accepts BOTH:
 *    - CLI wrapper format: `{ "servers": [{ "name": "...", "command": ["..."] }] }`
 *    - plugin/browser format: `{ "mcpServers": { "browser": { "command": "...", "args": [...] } } }`
 *  OFF when no resolver yields a path. */
export const readMcpConfig = async (
  slog: StructuredLogger,
  envSource: NodeJS.ProcessEnv = process.env,
  // §12.4 LIVE-wire — central-config MCP launch policy (E2 denylist + E1-sub
  // managed-only enforcement). `undefined` ⇒ no filtering (legacy byte-identical:
  // the gate-OFF path and the no-policy-configured path both pass undefined).
  policy?: McpLaunchPolicy,
): Promise<McpServerConfig[]> => {
  // Observable governance: every dropped server is slog'd — never a silent
  // disappearance the operator can't diagnose.
  const applyPolicy = (servers: McpServerConfig[]): McpServerConfig[] => {
    if (policy === undefined) return servers
    const { kept, dropped } = filterMcpServersByPolicy(servers, policy)
    for (const d of dropped) slog.warn("mcp.governance.dropped", { server: d.name, reason: d.reason })
    return [...kept]
  }
  const path = resolveMcpConfigPath(envSource)
  if (!path) return []
  try {
    const raw = await Bun.file(path).text()
    const parsed = JSON.parse(raw) as unknown
    const pluginStyle = MCPRootSchema.safeParse(parsed)
    if (pluginStyle.success) {
      return applyPolicy(
        Object.entries(pluginStyle.data.mcpServers).map(([name, spec]) =>
          pluginSpecToServerConfig(name, spec),
        ),
      )
    }
    const legacy = parsed as { servers?: McpServerConfig[] }
    if (Array.isArray(legacy.servers)) return applyPolicy(legacy.servers)
    slog.warn("mcp.config.error", {
      path,
      error: "expected {servers:[...]} or {mcpServers:{...}}",
    })
    return []
  } catch (e) {
    slog.warn("mcp.config.error", { path, error: (e as Error).message })
    return []
  }
}

/** §12.4 LIVE-wire — resolve the central-config MCP launch policy at the CLI
 *  composition root. NON-INTERACTIVE mirror of the hooks path in
 *  `apps/agent/index.ts#resolveCommandHookBindings` (same trust inputs:
 *  `~/.quanta/trust.json` + `QUANTA_TRUSTED_PATHS`; NO trust prompt — MCP load
 *  must never block boot on stdin; the hooks path owns interactive elevation).
 *
 *  Returns `undefined` (⇒ no filtering, legacy byte-identical) when:
 *    - `runtimeConfig().centralConfig` is OFF (strict default-OFF), or
 *    - resolution succeeded but NO layer configured `mcp.enabledServers` /
 *      `mcp.deniedServers` (avoids the behavior cliff: enabling central-config
 *      without MCP policy keeps existing `.mcp.json` servers untouched), or
 *    - resolution faulted (FAIL-SOFT availability: a corrupt local settings
 *      file must not kill every MCP server; the fault is slog'd). */
export const resolveMcpLaunchPolicy = async (
  slog: StructuredLogger,
  envSource: NodeJS.ProcessEnv = process.env,
): Promise<McpLaunchPolicy | undefined> => {
  const rc = runtimeConfig()
  if (!rc.centralConfig) return undefined
  try {
    let realCwd: string
    try {
      realCwd = await realpath(process.cwd())
    } catch {
      realCwd = process.cwd()
    }
    const userConfigDir = rc.centralConfigDir ?? joinPath(homedir(), ".quanta")
    // Read-only trust persistence: `save` is a no-op — this path NEVER grants
    // trust (no prompt), it only honors grants the hooks flow / user persisted.
    const trustFile = joinPath(userConfigDir, "trust.json")
    const store = await TrustStore.load({
      load: async () => {
        try {
          const text = await readFile(trustFile, "utf8")
          const parsed = JSON.parse(text) as unknown
          return typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, TrustRecord>)
            : undefined
        } catch {
          return undefined
        }
      },
      save: async () => {},
    })
    const trustedFromEnv = canonicalizeTrustedPaths(
      (rc.trustedPaths ?? "").split(",").map((s) => s.trim()),
    )
    const trusted = store.isTrusted(realCwd) || trustedFromEnv.has(realCwd)
    const layers = await readDiskLayers({
      cwd: realCwd,
      userConfigDir,
      managedPath: osManagedSettingsPath(
        process.platform,
        rc.managedSettingsPath,
        envSource.PROGRAMDATA,
      ),
      trusted,
      sources: parseSettingSources(rc.centralConfigSources),
      read: async (p: string) => {
        try {
          return await readFile(p, "utf8")
        } catch {
          // ENOENT/EACCES/… ⇒ layer absent (fail-soft, same posture as the
          // hooks path's fsReadText).
          return undefined
        }
      },
      warn: (m: string) => slog.warn("mcp.governance.layer", { warn: m }),
    })
    const resolved = mergeDiskLayers(layers, trusted)
    if (resolved.mcpEnabledServers.length === 0 && resolved.mcpDeniedServers.length === 0) {
      return undefined
    }
    return {
      enabledServers: resolved.mcpEnabledServers,
      deniedServers: resolved.mcpDeniedServers,
    }
  } catch (e) {
    slog.warn("mcp.governance.resolve_failed", { error: (e as Error).message })
    return undefined
  }
}

/**
 * Flags that consume the FOLLOWING argv token as their value (`--flag <value>`).
 * Their value must never become part of the prompt — e.g. `--state foo` must
 * drop both `--state` and `foo`. This list is the single source of truth shared
 * by {@link argvPrompt} (so the value is skipped, not treated as a positional)
 * and {@link argvImages} (which extracts `--image` values).
 */
const VALUED_FLAGS = ["--state", "--resume", "--observe-dir", "--title", "--image"] as const

/**
 * Build the seed prompt from positional (non-flag) argv tokens.
 *
 * ALLOWLIST semantics (inverted from the prior denylist, which leaked any
 * unknown flag into the LLM prompt — e.g. a mistyped `--worktree` was sent to
 * the model verbatim because it wasn't in the strip-list): a token becomes part
 * of the prompt ONLY when it is a positional argument — i.e. it does NOT start
 * with `-` AND it is not the value consumed by a {@link VALUED_FLAGS} flag.
 * Every `-`/`--`-prefixed token (known or not, including the `--flag=value`
 * form) is excluded by construction, so no new top-level flag can ever leak.
 *
 * Byte-identical for the common case: a plain `quanta "fix the bug"` (or any
 * mix of recognized flags + a positional prompt) yields exactly the same joined
 * positional text as before. The only behavior change is for tokens that begin
 * with `-` and were previously NOT in the denylist — those used to leak into
 * the prompt and are now correctly dropped.
 */
export const argvPrompt = (): string => {
  const argv = process.argv.slice(2)
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) continue
    if (a.startsWith("-")) {
      // A valued flag also consumes its following token, so skip the value too
      // (prevents `--state foo` from leaving `foo` as a stray positional).
      if ((VALUED_FLAGS as readonly string[]).includes(a)) i += 1
      continue
    }
    positionals.push(a)
  }
  return positionals.join(" ").trim()
}

/** ADR-0083 multi-modal — extract every `--image <path>` value from argv (the
 *  flag is repeatable). Empty when no `--image` is passed (byte-identical: the
 *  CLI seed message stays text-only). */
export const argvImages = (): string[] => {
  const argv = process.argv.slice(2)
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--image" && argv[i + 1] !== undefined) {
      out.push(argv[i + 1] as string)
    }
  }
  return out
}

export interface Features {
  planMode: boolean
  metrics: Metrics | undefined
  state: string | undefined
  resume: string | undefined
  mcpTools: Tool[]
  /** Stoppable handles for every loaded server. Without auto-restart these are
   *  `McpClient` instances; with `QUANTA_MCP_AUTORESTART=1` (ADR-0435) they are
   *  `McpReconnectSupervisor` instances — both expose a compatible `stop()`. */
  mcpClients: McpStoppable[]
  /** Raw configs from `QUANTA_MCP_CONFIG` — the SSOT for the `/mcp` slash
   *  command. `loadMcpTools` drops failed entries from `mcpClients`, so
   *  this is the only place where the surface can see all configured
   *  servers (incl. those that failed to spawn). */
  mcpConfigs: McpServerConfig[]
  lspTools: Tool[]
  /** ADR-0015: LSP nav tools (8). Default-OFF; appended to registry
   *  when `QUANTA_LSP_TOOLS=full`. */
  lspNavTools: Tool[]
  /** ADR-0016: first-class git tools (4). Default-OFF; appended to
   *  registry when `QUANTA_GIT_TOOLS=1`. */
  gitToolList: Tool[]
}

/** B1 (jun-04) — the stable elicitation-lease context id the inbound-sampling
 *  consent prompt binds to. Distinct from any real MCP `serverId` so a sampling
 *  consent prompt never coalesces with a server's own `elicitation/create`
 *  prompt. (The `__` prefix is not a legal MCP server name, so no collision.) */
const SAMPLING_CONSENT_CONTEXT = "__sampling_consent__"

/** B1 (jun-04) — build the OPTIONAL injectable seams for {@link loadFeatures}. */
export interface LoadFeaturesOpts {
  /** The assembled `LLMPort` an inbound `sampling/createMessage` delegates to.
   *  Threaded from the host bootstrap (`finalLLM`), which builds it just before
   *  it calls `loadFeatures`. Absent ⇒ inbound sampling is impossible regardless
   *  of the knob (no LLM to spend ⇒ `buildSamplingWiring` returns OFF). */
  readonly llm?: LLMPort
  /** Test seam — inject a per-server transport factory (mirrors `McpClient`'s
   *  `transport` option) so the e2e can drive the constructed client's inbound
   *  path without spawning a real process. Production omits it. */
  readonly mcpTransportFor?: (config: McpServerConfig) => McpClientTransport
  /** Test seam — force the elicitation prompter factory interactive (mirrors
   *  {@link buildCliElicitationPrompterFactory}'s `interactive` override) so the
   *  consent prompter + sampling wiring are exercised without a real TTY.
   *  Production omits it (the factory reads `process.stdin.isTTY`). */
  readonly elicitationPrompterFor?: ElicitationPrompterFactory
  /** H18 (jun-06 live-wire) — test seam for the MCP OAuth provider assembly: a
   *  fake auth-server `fetchPort`, a scripted `browserFlow`, a tmp
   *  `tokenStoreDir`, and a fake-exec `keyring` option. Forwarded verbatim to
   *  {@link resolveMcpOAuthProvider}. Production omits it (real `globalThis.fetch`,
   *  loopback browser flow, `<quanta-home>/mcp-oauth/`, live keyring). */
  readonly mcpOAuthDeps?: Parameters<typeof resolveMcpOAuthProvider>[1]
}

/** B1 (jun-04) — compute the advertise-iff-able inbound-sampling wiring for the
 *  CLI MCP load. The DECISION lives HERE (the surface), not in `@/agent/mcp-bridge`
 *  (which stays a pure consumer and never imports `@/host`): only the surface
 *  has both the assembled `LLMPort` AND the interactive consent prompter.
 *
 *  ONE gate ({@link buildSamplingWiring}) yields BOTH the advertise flag (fed to
 *  {@link pickMcpNegotiator}) and the handler (fed to the `McpClient`), so the
 *  capability advertisement and the handler can never drift. Returns `undefined`
 *  (⇒ the load is byte-identical) whenever ANY of the three preconditions is
 *  absent: the knob is off (`runtimeConfig().mcpSampling`), no LLM was threaded,
 *  or no interactive consent prompter is available (headless / piped run — a
 *  remote server must never silently spend inference unattended).
 *
 *  The consent prompter REUSES the existing CLI elicitation prompter seam (the
 *  SAME `promptBoolean` an inbound `elicitation/create` routes through), bound to
 *  a dedicated {@link SAMPLING_CONSENT_CONTEXT} lease so it never coalesces with
 *  a real server's prompt. */
/** B1 + H19 (jun-04) — the unified MCP inbound-capability wiring bundle the
 *  surface hands DOWN to `loadMcpTools` (consumed IDENTICALLY by the
 *  single-client and the supervised path). Mirrors `@/agent`'s
 *  `SamplingWiringInput`: ONE negotiator reflecting BOTH sampling AND roots, plus
 *  the answering ports — each present IFF its capability is advertised. */
type McpInboundWiring = {
  negotiator: CapabilityNegotiator
  handler?: SamplingHandlerPort
  rootsProvider?: RootsProviderPort
}

/** B1 + H19 (jun-04) — compute the advertise-iff-able inbound-capability wiring
 *  for the CLI MCP load, unifying sampling (B1) and roots (H19) into ONE bundle.
 *  The DECISION lives HERE (the surface), not in `@/agent/mcp-bridge` (which
 *  stays a pure consumer and never imports `@/host`): only the surface has the
 *  assembled `LLMPort`, the interactive consent prompter, AND the workspace cwd.
 *
 *  Two INDEPENDENT advertise-iff-able gates, each returning its `advertise` flag
 *  and the answering port from the SAME branch so they can never drift:
 *   - sampling (`buildSamplingWiring`): ON iff `QUANTA_MCP_SAMPLING=1` AND an LLM
 *     AND an interactive consent prompter (a remote server must never silently
 *     spend inference unattended);
 *   - roots (`buildRootsWiring`): ON iff `QUANTA_MCP_ROOTS=1` (the provider is the
 *     workspace cwd — always available, no extra dep).
 *
 *  The negotiator is computed ONCE from BOTH advertise flags, then VERIFIED
 *  against its compiled record so we NEVER advertise a capability we would
 *  answer with `-32601` (the base `QUANTA_MCP_CAPS=full` must be on for ANY
 *  inbound capability — `pickMcpNegotiator` returns the `{}` default otherwise,
 *  in which case both flags collapse to OFF). Returns `undefined` (⇒ the load is
 *  byte-identical) when NEITHER capability ends up advertised. */
const resolveMcpInboundWiring = (
  llm: LLMPort | undefined,
  elicitationPrompterFor: ElicitationPrompterFactory | undefined,
): McpInboundWiring | undefined => {
  // --- sampling gate (B1) ---
  const consent: ElicitationPrompter | undefined =
    elicitationPrompterFor !== undefined
      ? elicitationPrompterFor(SAMPLING_CONSENT_CONTEXT)
      : undefined
  const samplingDeps = llm !== undefined && consent !== undefined ? { llm, consent } : undefined
  const sampling = buildSamplingWiring(runtimeConfig().mcpSampling, samplingDeps)

  // --- roots gate (H19) — provider is the session workspace cwd ---
  const roots = buildRootsWiring(runtimeConfig().mcpRoots, process.cwd())

  // The negotiator reflects BOTH capabilities, computed ONCE. `pickMcpNegotiator`
  // only advertises either under `QUANTA_MCP_CAPS=full`; absent ⇒ the `{}`
  // default ⇒ neither is advertised (both flags collapse to OFF below).
  const negotiator = pickMcpNegotiator(process.env, {
    ...(sampling.advertise ? { sampling: true } : {}),
    ...(roots.advertise ? { roots: true } : {}),
  })
  const compiled = negotiator.compile()
  // VERIFY each handler/provider against the compiled record so a handler/
  // provider is wired IFF the negotiator will actually advertise it (guards the
  // inverse drift: `QUANTA_MCP_SAMPLING=1` / `QUANTA_MCP_ROOTS=1` WITHOUT
  // `QUANTA_MCP_CAPS=full` ⇒ the capability is NOT advertised ⇒ no port wired).
  const handler =
    sampling.advertise && sampling.handler !== undefined && compiled.sampling !== undefined
      ? sampling.handler
      : undefined
  const rootsProvider =
    roots.advertise && roots.provider !== undefined && compiled.roots !== undefined
      ? roots.provider
      : undefined
  // Nothing advertised ⇒ omit the bundle entirely (byte-identical load).
  if (handler === undefined && rootsProvider === undefined) return undefined
  return {
    negotiator,
    ...(handler !== undefined ? { handler } : {}),
    ...(rootsProvider !== undefined ? { rootsProvider } : {}),
  }
}

/** Assemble the optional `loadMcpTools` opts bag from the resolved feature
 *  gates. Extracted from {@link loadFeatures} so the spread branches do not push
 *  that function over biome's cognitive-complexity cap. Every field is
 *  presence-only: an empty bag is byte-identical to passing `undefined` (every
 *  field is read via `opts?.x` in the bridge). */
const buildMcpLoadOpts = (
  slog: StructuredLogger,
  args: {
    readonly autoRestart: boolean
    readonly inboundWiring: ReturnType<typeof resolveMcpInboundWiring>
    readonly oauthProvider: McpOAuthProviderPort | undefined
    readonly opts: LoadFeaturesOpts
  },
): Parameters<typeof loadMcpTools>[2] => ({
  // B1 + H19 — the SAME unified `{ negotiator, handler?, rootsProvider? }` bundle
  // feeds BOTH paths. On the supervised path it is BAKED into the restart factory
  // (so a reconnected client re-advertises); on the single-client path it is the
  // `samplingWiring` opt the bridge applies to the one client. The transport seam
  // (test-only) is threaded into the supervisor factory too so a supervised
  // client can be driven by a scripted transport. H18 (jun-06) — the OAuth
  // provider rides BOTH paths identically: baked into the supervisor factory AND
  // passed as the single-client `oauthProvider` opt.
  ...(args.autoRestart
    ? {
        supervisorDepsFor: mcpSupervisorDepsFor(
          slog,
          args.inboundWiring,
          args.opts.mcpTransportFor,
          args.oauthProvider,
        ),
      }
    : {}),
  ...(args.inboundWiring !== undefined ? { samplingWiring: args.inboundWiring } : {}),
  ...(args.opts.mcpTransportFor !== undefined ? { transportFor: args.opts.mcpTransportFor } : {}),
  ...(args.oauthProvider !== undefined ? { oauthProvider: args.oauthProvider } : {}),
  // §19.1 (QUANTA_MCP_TOOL_ANNOTATIONS) — the global default-OFF master switch.
  // OFF (default) ⇒ slot omitted ⇒ the bridge's `annotationsHonored` stays false
  // ⇒ `honored = annotationsHonored && trusted` is false for EVERY tool, so the
  // read/concurrency predicates keep their conservative classification
  // (byte-identical). ON ⇒ a TRUSTED server's annotations may elevate them.
  ...(runtimeConfig().mcpToolAnnotations ? { annotationsHonored: true } : {}),
})

/** Start the configured MCP servers (or short-circuit to an empty bundle when
 *  none are configured), returning the same `{ tools, clients, resources? }`
 *  shape `loadMcpTools` produces. Extracted so {@link loadFeatures} carries no
 *  inline ternary branch over the load (keeps it under biome's cognitive-
 *  complexity cap). Zero configs ⇒ no client started (byte-identical). */
const loadMcpToolsOrEmpty = async (
  mcpConfigs: McpServerConfig[],
  elicitationPrompterFor: ElicitationPrompterFactory | undefined,
  mcpLoadOpts: Parameters<typeof loadMcpTools>[2],
): Promise<{ tools: Tool[]; clients: McpStoppable[]; resources?: ResourcesHandle }> => {
  if (mcpConfigs.length === 0) return { tools: [], clients: [] }
  return loadMcpTools(mcpConfigs, elicitationPrompterFor, mcpLoadOpts)
}

/** N3 (QUANTA_MCP_RESOURCES) — build the four `mcp_*` resource/prompt tools when
 *  the knob is ON AND the bridge produced an aggregate `ResourcesHandle` (i.e. at
 *  least one connected server advertised `resources`/`prompts`). They register
 *  through the mcp-origin `mcpTools` array (NOT `DefaultToolPorts`) so the
 *  registry tags them `mcp` ⇒ `deriveProvenance(name,"mcp")` ⇒ the H2/ADR-0471
 *  `<untrusted-source>` envelope wraps their output at dispatch (the documented
 *  security invariant for these tools). Knob off OR no capable server ⇒ `[]` ⇒
 *  the tools are absent + the registry is byte-identical. Extracted so
 *  {@link loadFeatures} stays under biome's cognitive-complexity cap. */
const buildMcpResourceTools = (resources: ResourcesHandle | undefined): Tool[] =>
  runtimeConfig().mcpResources && resources !== undefined ? mcpResourcesTools(resources) : []

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
  const mcpConfigs = await readMcpConfig(slog, process.env, await resolveMcpLaunchPolicy(slog))
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
  const mcpLoadOpts = buildMcpLoadOpts(slog, { autoRestart, inboundWiring, oauthProvider, opts })
  const {
    tools: mcpBridgedTools,
    clients: mcpClients,
    resources: mcpResources,
  } = await loadMcpToolsOrEmpty(mcpConfigs, elicitationPrompterFor, mcpLoadOpts)
  // N3 (QUANTA_MCP_RESOURCES) — the four `mcp_*` resource/prompt tools, gated on
  // the knob AND a live aggregate handle (see {@link buildMcpResourceTools}).
  const mcpResourceTools = buildMcpResourceTools(mcpResources)
  const mcpTools: Tool[] = [...mcpBridgedTools, ...mcpResourceTools]

  // LSP-backed diagnostics: only when opted in. The tool name matches the
  // no-op one in defaultTools, so appending it lets the registry's last-write
  // -wins map swap in the real provider (same merge path as MCP tools).
  const lspTools: Tool[] = lspEnabled() ? [lspDiagnosticsTool()] : []
  // ADR-0015: LSP nav tools. NOT in defaultTools — opt-in only.
  const lspNavTools: Tool[] = lspNavEnabled() ? lspNavToolList() : []
  // ADR-0016: first-class git tools. NOT in defaultTools — opt-in only.
  // §7.2: when QUANTA_GIT_CO_CHANGE is also on, append the co-change tool
  // (opts.coChange). Default-OFF: gate off ⇒ git tool set is byte-identical.
  const gitToolList: Tool[] = gitToolsEnabled()
    ? gitTools(undefined, gitCoChangeEnabled() ? { coChange: true } : {})
    : []

  if (planMode) slog.info("plan.mode.on")
  if (metrics) slog.info("metrics.on")
  if (state) slog.info("state.persist.on", { path: state })
  if (mcpTools.length > 0) slog.info("mcp.tools.loaded", { count: mcpTools.length })
  if (mcpResourceTools.length > 0) slog.info("mcp.resources.on", { count: mcpResourceTools.length })
  if (autoRestart && mcpClients.length > 0) slog.info("mcp.autorestart.on")
  if (lspTools.length > 0) slog.info("lsp.diagnostics.on")
  if (lspNavTools.length > 0) slog.info("lsp.nav.on", { count: lspNavTools.length })
  if (gitToolList.length > 0) slog.info("git.tools.on", { count: gitToolList.length })
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
    // Live "· N tokens" counter rides the SAME gate as the spinner indicator
    // (interactive TTY + `QUANTA_SPINNER` not disabled). Non-TTY / piped /
    // `QUANTA_SPINNER=0` ⇒ byte-identical no-progress stream.
    liveUsage: isIndicatorEnabled(process.env, process.stdout.isTTY),
  })

// ── Split: `Tooling` lives in `@/runner/assemble/*` (PURE composition, no
//    env reads). Re-exported below so CLI-local types keep their historical
//    surface without pulling runtime assembly helpers back in.
export type { Tooling } from "@/runner/assemble/tooling"

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
): Tooling => {
  const store = buildStore()
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
  const subagentConfig = buildSubagentConfig(subagentTaskRegistry)
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
  // would register deferred work into. Merged into `extraTools` alongside the
  // search wire so the registration is independent of the search pipeline.
  const asyncDeferredTools = buildAsyncDeferredTools()
  // ADR-0494 — gated `ask_user` (structured elicitation). Default-OFF: null
  // unless QUANTA_ASK_USER is on AND stdin is a TTY (headless ⇒ no prompter ⇒
  // no tool ⇒ byte-identical menu). The terminal prompter is owned here in the
  // app layer (the host layer is forbidden from touching process stdio).
  const askUserTool = buildCliAskUserTool(process.env)
  // gap-other-agent GAP 6 (ADR-0509) — gated `fetch_rules` (agent-requested
  // description-only rules). Default-OFF: null unless QUANTA_FETCH_RULES is on.
  // The port lazily loads the requestable-rules index from the workspace cwd.
  const fetchRulesTool = buildCliFetchRulesTool(process.cwd(), process.env)
  const extraTools: Tool[] = [
    ...(searchWire !== null ? [searchWire.tool] : []),
    ...asyncDeferredTools,
    ...(askUserTool !== null ? [askUserTool] : []),
    ...(fetchRulesTool !== null ? [fetchRulesTool] : []),
  ]
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
    ...(process.env.QUANTA_MEMORY !== undefined
      ? { memoryKindLabel: process.env.QUANTA_MEMORY }
      : {}),
    onMemoryReady: (line) => logger.info(line),
    ...(sandboxProfile !== undefined ? { sandboxProfile } : {}),
    // ADR-0464 — CLI surface owns the env read; default-ON in the CLI is seeded
    // by the gate-default block in index.ts (so unset ⇒ "1" ⇒ tool registered).
    ...(readCliKnob("QUANTA_ENABLE_STRUCTURED_PATCH", "bool") ? { structuredPatch: true } : {}),
    // ADR-0165 — same posture as structuredPatch: CLI owns the env read,
    // default-ON via the SSOT-derived gate-default seed in index.ts.
    ...(readCliKnob("QUANTA_COVERAGE_TOOL", "bool") ? { coverageCheck: true } : {}),
    ...(budgetRemainingPercent !== undefined ? { budgetRemainingPercent } : {}),
  })
}

export type { ResolveResumeInput, ResumeResolution } from "./resume"
// ── Resume state machine (`isPathLikeToken`, `defaultUntitled`, `resolveResume`
//    + types) lives in `./resume` (ADR-0024 split). Re-exported here so existing
//    importers (`index.ts`, tests) continue to resolve them from `./internal`.
export {
  defaultUntitled,
  isPathLikeToken,
  resolveResume,
} from "./resume"
