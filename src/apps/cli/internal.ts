import {
  type AgentConfig,
  loadMcpTools,
  lspDiagnosticsTool,
  lspNavToolList,
  type PersonaKind,
  resolvePersona,
} from "@/agent"
import { defaultIdentityProvider, type IdentityMode } from "@/agent/identity"
import type { LLMPort } from "@/llm"
import type { McpClient, McpServerConfig } from "@/mcp"
import { Metrics, type StructuredLogger } from "@/observability"
import type { PermissionContext, PermissionMode } from "@/permission"
import {
  buildCompactionBreakerConfigCore,
  buildEmbedderCore,
  buildLLMCore,
  buildMemoryConfigCore,
  buildMemoryForSession,
  buildSearchPipelineFromEnv,
  buildSkillsConfigCore,
  buildStoreCore,
  buildStreamingCore,
  buildSubagentConfigCore,
  buildSummarizerLlmCore,
  buildToolingCore,
  buildVerifyGuardConfigCore,
  composeLLMCore,
  DEFAULT_MODEL,
  parseEnvFlag,
  parseFallbackModels,
  parseRecallTiers,
  pickProviderCore,
  type Provider as RunnerProvider,
} from "@/runner/assemble"
import type { Tooling } from "@/runner/assemble/tooling"
import { resolveSandboxProfileFromEnv } from "@/runtime"
import {
  createBunSpawner,
  createShellSnapshotPort,
  type ShellSnapshotPort,
} from "@/runtime/shell-snapshot"
import type { ShellSnapshotMetric } from "@/runtime/shell-snapshot/metric-port"
import { logger, type RunContext } from "@/shared"
import { MCPRootSchema, PLUGIN_MCP_FILE } from "@/skill/plugin-manifest"
import type { AssistantTextPainter, StreamPort } from "@/stream"
import { gitTools, type Tool } from "@/tool"
import { createMarkdownPainter } from "./markdown-painter"
import { isPathLikeToken } from "./resume"

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
  if (process.env.QUANTA_IDENTITY !== "1") return undefined
  const raw = process.env.QUANTA_IDENTITY_MODE ?? "default"
  return defaultIdentityProvider().identityFor(raw as IdentityMode)
}

/** Build the main LLM adapter via the surface-agnostic core. Preserves the
 *  prior contract byte-for-byte: a missing provider key throws (the cli aborts
 *  loudly), the factory resolves the api key + `OPENAI_BASE_URL` from the env
 *  we pass. */
export const buildLLM = (provider: Provider, model: string): LLMPort =>
  buildLLMCore({ provider, model, env: process.env })

/** Default model id per provider — re-exported from the runner barrel (the
 *  single source of truth the three app entry points used to each duplicate). */
export { DEFAULT_MODEL }

/**
 * Build the long-term memory store from env. ADR-0413 changed the default
 * from OFF to ON: unset / truthy `QUANTA_MEMORY` ⇒ on-disk SqliteStore
 * (path from `QUANTA_MEMORY_PATH`, default `.quanta/memory.sqlite`).
 * `QUANTA_MEMORY=memory` ⇒ volatile InMemoryStore; `=off` / `0` / `false` /
 * `no` ⇒ no store (legacy default-OFF byte-identical escape hatch).
 *
 * Long-term memory env:
 *   QUANTA_MEMORY              on (default) | off | 0 | 1 | sqlite | memory | …
 *   QUANTA_MEMORY_PATH         override sqlite path (default `.quanta/memory.sqlite`)
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
    disabled: process.env.QUANTA_MEMORY_EMBED === "off",
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
 * Build the `memory` tuning block from env. ADR-0413: delegates to
 * `buildMemoryForSession`. Returns `undefined` only when `QUANTA_MEMORY=off`
 * (the single-knob escape hatch); otherwise the block is returned even when
 * empty so the loop's `config.store` check threads through identically.
 *
 * `store` parameter is preserved for back-compat (legacy callers pass the
 * result of `buildStore()` here) but is now informational only — the factory
 * resolves the store internally from the same env view, so `store` is ignored
 * unless it's `undefined` (in which case the caller already opted out and
 * the config block is collapsed to legacy-OFF for symmetry).
 */
export const buildMemoryConfig = (
  store: ReturnType<typeof buildStoreCore>,
): AgentConfig["memory"] | undefined => {
  // Legacy contract: when `store === undefined` (caller already saw the
  // escape hatch fire), short-circuit so the config block follows. This
  // preserves the env-knob-branches.test.ts assertion that
  // `buildMemoryConfig(undefined)` returns `undefined` when no env knobs
  // are set. Sub-knob branches (recallLimit / distill / etc.) still work
  // because `buildMemoryConfigCore` returns a block when ANY knob is set
  // even with `store=undefined`.
  if (store === undefined) {
    const rawLimit = process.env.QUANTA_MEMORY_RECALL_LIMIT
    const limit = rawLimit !== undefined ? Number.parseInt(rawLimit, 10) : Number.NaN
    const recallTiers = parseRecallTiers(process.env.QUANTA_MEMORY_RECALL_TIERS)
    return buildMemoryConfigCore({
      store,
      ...(Number.isFinite(limit) ? { recallLimit: limit } : {}),
      ...(process.env.QUANTA_MEMORY_DISTILL === "off" ? { distill: false } : {}),
      ...(process.env.QUANTA_MEMORY_CONSOLIDATE === "off" ? { consolidate: false } : {}),
      ...(process.env.QUANTA_MEMORY_SELF_EDIT === "off" ? { selfEditTools: false } : {}),
      ...(recallTiers ? { recallTiers } : {}),
    })
  }
  return buildMemoryForSession(process.env).config
}

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
  const enabled = parseEnvFlag(process.env.QUANTA_SUBAGENT, true)
  const rawDepth = process.env.QUANTA_SUBAGENT_MAX_DEPTH
  const depth = rawDepth !== undefined ? Number.parseInt(rawDepth, 10) : Number.NaN
  return buildSubagentConfigCore({
    enabled,
    ...(Number.isFinite(depth) ? { maxDepth: depth } : {}),
    ...(taskRegistry !== undefined ? { taskRegistry } : {}),
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
  const raw = process.env.QUANTA_VERIFY_GUARD_MAX_TRIPS
  const trips = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN
  return buildVerifyGuardConfigCore({
    enabled,
    ...(Number.isFinite(trips) ? { maxTrips: trips } : {}),
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
    enabled: parseEnvFlag(process.env.QUANTA_SKILLS, true) || hasArg("--skills"),
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
    ...(process.env.QUANTA_COMPACT_BREAKER === "off" ? { disabled: true } : {}),
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
export const planEnabled = (): boolean => process.env.QUANTA_PLAN === "1" || hasArg("--plan")

/** LSP diagnostics tool is on when `QUANTA_LSP=1` or `--lsp` is present.
 *  Default OFF: `defaultTools` already registers a no-op `diagnostics`; this
 *  only swaps in the real language-server-backed provider when asked. The
 *  bridge itself still degrades gracefully if a server binary is absent. */
export const lspEnabled = (): boolean => process.env.QUANTA_LSP === "1" || hasArg("--lsp")

/** Codex `may-20-codex-lsp.md` absorption (ADR-0015). LSP NAV tools
 *  (definition / references / hover / type_definition / implementation /
 *  document_symbol / workspace_symbol / rename_preview) are NOT in
 *  `defaultTools` — they expand the tool surface, so opt-in only via
 *  `QUANTA_LSP_TOOLS=full`. With the knob unset the registry is byte-identical. */
export const lspNavEnabled = (): boolean => process.env.QUANTA_LSP_TOOLS === "full"

/** Codex `may-20-codex-signal.md` absorption (ADR-0016). First-class
 *  git tools (diff/status/log/blame) are NOT in `defaultTools` to keep the
 *  default registry byte-identical. Opt-in via `QUANTA_GIT_TOOLS=1`. */
export const gitToolsEnabled = (): boolean => process.env.QUANTA_GIT_TOOLS === "1"

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
  const enabled = process.env.QUANTA_SHELL_SNAPSHOT === "1" || hasArg("--shell-snapshot")
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
): Promise<McpServerConfig[]> => {
  const path = resolveMcpConfigPath(envSource)
  if (!path) return []
  try {
    const raw = await Bun.file(path).text()
    const parsed = JSON.parse(raw) as unknown
    const pluginStyle = MCPRootSchema.safeParse(parsed)
    if (pluginStyle.success) {
      return Object.entries(pluginStyle.data.mcpServers).map(([name, spec]) =>
        pluginSpecToServerConfig(name, spec),
      )
    }
    const legacy = parsed as { servers?: McpServerConfig[] }
    if (Array.isArray(legacy.servers)) return legacy.servers
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
  mcpClients: McpClient[]
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

/** Resolve all default-OFF feature flags from env/argv and start MCP servers.
 *  Logs each enabled feature via the structured logger (minimal). */
export const loadFeatures = async (slog: StructuredLogger): Promise<Features> => {
  const planMode = planEnabled()
  const metrics = process.env.QUANTA_METRICS === "1" ? new Metrics() : undefined
  const state = statePath()
  const resume = resumePath()
  const mcpConfigs = await readMcpConfig(slog)
  const { tools: mcpTools, clients: mcpClients } =
    mcpConfigs.length > 0 ? await loadMcpTools(mcpConfigs) : { tools: [], clients: [] }
  // LSP-backed diagnostics: only when opted in. The tool name matches the
  // no-op one in defaultTools, so appending it lets the registry's last-write
  // -wins map swap in the real provider (same merge path as MCP tools).
  const lspTools: Tool[] = lspEnabled() ? [lspDiagnosticsTool()] : []
  // ADR-0015: LSP nav tools. NOT in defaultTools — opt-in only.
  const lspNavTools: Tool[] = lspNavEnabled() ? lspNavToolList() : []
  // ADR-0016: first-class git tools. NOT in defaultTools — opt-in only.
  const gitToolList: Tool[] = gitToolsEnabled() ? gitTools() : []

  if (planMode) slog.info("plan.mode.on")
  if (metrics) slog.info("metrics.on")
  if (state) slog.info("state.persist.on", { path: state })
  if (mcpTools.length > 0) slog.info("mcp.tools.loaded", { count: mcpTools.length })
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
  slog: StructuredLogger,
  /** Optional surface-provided {@link TaskRegistry} threaded into the
   *  subagent config so the surface (CLI lifecycle pills) shares the same
   *  registry instance the loop uses. Unset ⇒ byte-identical to today
   *  (loop mints internally). */
  subagentTaskRegistry?: import("@/subagent").TaskRegistry,
): Tooling => {
  const store = buildStore()
  const embedder = buildEmbedder(store)
  const sessionId = crypto.randomUUID()
  const searchWire = buildSearchPipelineFromEnv(process.env, process.cwd())
  const memoryConfig = buildMemoryConfig(store)
  const subagentConfig = buildSubagentConfig(subagentTaskRegistry)
  const skillsConfig = buildSkillsConfig()
  const compactionBreakerConfig = buildCompactionBreakerConfig()
  const verifyGuardConfig = buildVerifyGuardConfig()
  // ADR-0297 — resolve QUANTA_SANDBOX → OsSandboxProfile and forward to
  // buildToolingCore so the bash factory's HITL tier closes over it. Unset/
  // unrecognised ⇒ undefined ⇒ conservative `always-confirm` default.
  const sandboxProfile = resolveSandboxProfileFromEnv(process.env)
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
    ...(searchWire !== null
      ? { extraTools: [searchWire.tool], searchPipeline: searchWire.pipeline }
      : {}),
    slog,
    ...(process.env.QUANTA_MEMORY !== undefined
      ? { memoryKindLabel: process.env.QUANTA_MEMORY }
      : {}),
    onMemoryReady: (line) => logger.info(line),
    ...(sandboxProfile !== undefined ? { sandboxProfile } : {}),
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
