import { join } from "node:path"
import {
  type AgentConfig,
  buildSystemPrompt,
  CachingEmbedder,
  createAutoClassifierPort,
  loadMcpTools,
  loadSession,
  memoryTools,
  OpenAIEmbedder,
  RetryingLLM,
} from "@/agent"
import { lspDiagnosticsTool, lspNavToolList } from "@/agent/lsp-bridge"
import { type PersonaKind, resolvePersona } from "@/agent/persona"
import {
  createLLM,
  DEFAULT_MODEL,
  FallbackLLM,
  type LLMPort,
  type Message,
  pickProvider as pickProviderFactory,
  type Provider as LLMFactoryProvider,
} from "@/llm"
import type { McpClient, McpServerConfig } from "@/mcp"
import { type EmbedderPort, InMemoryStore, type PersistentStorePort, SqliteStore } from "@/memory"
import { Metrics, type StructuredLogger } from "@/observability"
import type { PermissionContext, PermissionMode, ToolAction } from "@/permission"
import { loadSessionById, type SessionMeta, saveSessionById } from "@/session"
import { logger, type RunContext } from "@/shared"
import { JsonlRecorder, StdoutStream, type StreamPort, TeeStream } from "@/stream"
import { defaultTools, gitTools, type Tool, ToolRegistry } from "@/tool"

/**
 * ADR-0024 (export-gap closure): CLI `internal.ts` is the home of all
 * pure-ish helpers previously trapped inside `index.ts` next to a top-level
 * `main()` invocation. Splitting them out lets unit tests (e.g.
 * `tests/unit/cli-summarizer.test.ts`) import the real helpers directly
 * instead of re-implementing them locally. This module is CLI-internal:
 * other slices (`@/agent`, `@/skill`, …) MUST NOT import from
 * `src/apps/cli/**` — enforced by Biome `noRestrictedImports` overrides.
 */

export const env = (k: string, fallback: string): string => process.env[k] ?? fallback

/** Provider union — re-exported from the `@/llm` factory (the single source of
 *  truth). Kept as a CLI-local name so existing importers (`index.ts`, tests)
 *  are unaffected. */
export type Provider = LLMFactoryProvider

/** Provider selection. Thin wrapper over the `@/llm` factory's `pickProvider`,
 *  passing live `process.env` so the CLI honors a `QUANTA_PROVIDER` /
 *  key-presence change without a config-freeze round-trip (matches the
 *  pre-factory behavior the unit tests pin). */
export const pickProvider = (): Provider => pickProviderFactory(process.env)

/** ADR-0068 persona slot — resolve `QUANTA_PERSONA` once at REPL start.
 *  Absent ⇒ `"default"` (the explicit choice). Unknown value ⇒ named
 *  `PersonaInvalidError` throw (no silent fallback per ADR-0067 §C). */
export const pickPersona = (): PersonaKind => resolvePersona(process.env)

/** Build the main LLM adapter via the `@/llm` factory. Preserves the prior
 *  contract: a missing provider key throws (the cli aborts loudly). The factory
 *  resolves the api key + `OPENAI_BASE_URL` from the env we pass. */
export const buildLLM = (provider: Provider, model: string): LLMPort =>
  createLLM(provider, { model }, process.env)

/** Default model id per provider — re-exported from the `@/llm` factory (the
 *  single source of truth the three app entry points used to each duplicate).
 *  Kept exported from `internal.ts` so `index.ts` / tests importing it from
 *  here are unaffected. */
export { DEFAULT_MODEL }

/**
 * Build the long-term memory store from env. Default OFF so plain runs are
 * unchanged: `QUANTA_MEMORY=sqlite` → on-disk SqliteStore (path from
 * `QUANTA_MEMORY_PATH`, default `.quanta/memory.sqlite`); `=memory` →
 * volatile InMemoryStore; unset / `off` → no store.
 *
 * Long-term memory env (all default OFF / behavior-preserving when no store):
 *   QUANTA_MEMORY_EMBED        openai (default when store + OPENAI_API_KEY) | off
 *   QUANTA_MEMORY_EMBED_MODEL  override embedding model (else adapter default)
 *   QUANTA_MEMORY_RECALL_LIMIT int → memory.recallLimit
 *   QUANTA_MEMORY_DISTILL      off → memory.distill=false
 *   QUANTA_MEMORY_CONSOLIDATE  off → memory.consolidate=false
 *   QUANTA_MEMORY_SELF_EDIT    off → memory.selfEditTools=false (also skips
 *                              registering the memory_* self-edit tools)
 *   QUANTA_MEMORY_RECALL_TIERS comma list of episodic,semantic →
 *                              memory.recallTiers (invalid/empty ⇒ omitted)
 */
export const buildStore = (): PersistentStorePort | undefined => {
  const kind = process.env.QUANTA_MEMORY
  if (kind === "sqlite") {
    return new SqliteStore(process.env.QUANTA_MEMORY_PATH ?? ".quanta/memory.sqlite")
  }
  if (kind === "memory") return new InMemoryStore()
  return undefined
}

/**
 * Build the semantic embedder from env. Default OFF so lexical-only recall is
 * unchanged: enabled only when a `store` exists, `QUANTA_MEMORY_EMBED` is not
 * `off`, and `OPENAI_API_KEY` is set (reusing the OpenAI env pattern from
 * `buildLLM`). Absent ⇒ pure lexical/tag/freshness recall, zero behavior
 * change vs today.
 */
export const buildEmbedder = (store: PersistentStorePort | undefined): EmbedderPort | undefined => {
  if (!store) return undefined
  if (process.env.QUANTA_MEMORY_EMBED === "off") return undefined
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return undefined
  return new CachingEmbedder(
    new OpenAIEmbedder({
      apiKey,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
      ...(process.env.QUANTA_MEMORY_EMBED_MODEL
        ? { model: process.env.QUANTA_MEMORY_EMBED_MODEL }
        : {}),
    }),
  )
}

/**
 * Build the `memory` tuning block from env. Returns `undefined` when there is
 * no store AND no flag set, so the config key is omitted entirely and current
 * behavior is preserved exactly (respecting `exactOptionalPropertyTypes`).
 */
/** Parse `QUANTA_MEMORY_RECALL_TIERS` → dedup'd valid tiers, or undefined. */
export const parseRecallTiers = (
  raw: string | undefined,
): ("episodic" | "semantic")[] | undefined => {
  if (raw === undefined) return undefined
  const seen = new Set<"episodic" | "semantic">()
  for (const part of raw.split(",")) {
    const t = part.trim().toLowerCase()
    if (t === "episodic" || t === "semantic") seen.add(t)
  }
  return seen.size > 0 ? [...seen] : undefined
}

export const buildMemoryConfig = (
  store: PersistentStorePort | undefined,
): AgentConfig["memory"] | undefined => {
  const rawLimit = process.env.QUANTA_MEMORY_RECALL_LIMIT
  const limit = rawLimit !== undefined ? Number.parseInt(rawLimit, 10) : Number.NaN
  const recallTiers = parseRecallTiers(process.env.QUANTA_MEMORY_RECALL_TIERS)
  const block = {
    ...(Number.isFinite(limit) ? { recallLimit: limit } : {}),
    ...(process.env.QUANTA_MEMORY_DISTILL === "off" ? { distill: false } : {}),
    ...(process.env.QUANTA_MEMORY_CONSOLIDATE === "off" ? { consolidate: false } : {}),
    ...(process.env.QUANTA_MEMORY_SELF_EDIT === "off" ? { selfEditTools: false } : {}),
    ...(recallTiers ? { recallTiers } : {}),
  }
  if (!store && Object.keys(block).length === 0) return undefined
  return block
}

/**
 * Resolve the `subagent` config block from env (Tier 1 capability, ADR-0011).
 * Default OFF: `QUANTA_SUBAGENT` unset ⇒ `undefined` so the key is omitted
 * entirely and the `Agent`/`Task`/`TaskOutput`/`TaskStop` tools are NOT
 * registered (loop byte-identical). When set, an optional integer
 * `QUANTA_SUBAGENT_MAX_DEPTH` caps recursion (else the runner's default).
 */
export const buildSubagentConfig = (): AgentConfig["subagent"] | undefined => {
  if (process.env.QUANTA_SUBAGENT === undefined) return undefined
  const rawDepth = process.env.QUANTA_SUBAGENT_MAX_DEPTH
  const depth = rawDepth !== undefined ? Number.parseInt(rawDepth, 10) : Number.NaN
  return Number.isFinite(depth) ? { maxDepth: depth } : {}
}

/**
 * Resolve the verify-guard control from env (Tier 0 safety hardening, ADR-0011).
 * Default OFF: `QUANTA_VERIFY_GUARD` unset ⇒ `undefined` so the key is omitted
 * and the loop is byte-identical (no tool-history, no finish interception).
 * When set, a finish right after an unverified mutating tool is blocked,
 * forcing one more turn up to `QUANTA_VERIFY_GUARD_MAX_TRIPS` (else default 2).
 */
export const buildVerifyGuardConfig = (): AgentConfig["verifyGuard"] | undefined => {
  if (process.env.QUANTA_VERIFY_GUARD === undefined) return undefined
  const raw = process.env.QUANTA_VERIFY_GUARD_MAX_TRIPS
  const trips = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(trips) ? { maxTrips: trips } : {}
}

/**
 * Resolve the `skills` config block from env (Tier 1 capability, ADR-0011 +
 * ADR-0045 system-skills follow-up). Three states:
 *   - `QUANTA_SKILLS_DIR=<path>`     → `{ dir }`  user dir + bundled system skills
 *   - `QUANTA_SKILLS=1` / `--skills` → `{}`       bundled system skills ONLY
 *     (localize-fault, progress-audit available without a user dir — the
 *     whole point of bundled discipline skills per ADR-0045)
 *   - none of the above             → `undefined` byte-identical default-OFF
 *     (no Skill/ToolSearch tools registered; RFC §1.2)
 * A user dir wins over the bare flag (it's a superset — it also pulls system
 * skills in via `buildSkillFeatures`'s merge).
 */
export const buildSkillsConfig = (): AgentConfig["skills"] | undefined => {
  const dir = process.env.QUANTA_SKILLS_DIR
  if (dir) return { dir }
  if (process.env.QUANTA_SKILLS === "1" || hasArg("--skills")) return {}
  return undefined
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
  const disabled = process.env.QUANTA_COMPACT_BREAKER === "off"
  const intEnv = (k: string): number => {
    const raw = process.env[k]
    return raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN
  }
  const reactiveMax = intEnv("QUANTA_COMPACT_BREAKER_REACTIVE_MAX")
  const proactiveMax = intEnv("QUANTA_COMPACT_BREAKER_PROACTIVE_MAX")
  const caps = {
    ...(Number.isFinite(reactiveMax) ? { maxConsecutiveReactive: reactiveMax } : {}),
    ...(Number.isFinite(proactiveMax) ? { maxNoProgressProactive: proactiveMax } : {}),
  }
  const block = {
    ...(disabled ? { disabled: true } : {}),
    ...(Object.keys(caps).length > 0 ? { caps } : {}),
  }
  return Object.keys(block).length > 0 ? block : undefined
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
): LLMPort | undefined => {
  const model = process.env.QUANTA_COMPACT_MODEL
  if (model === undefined || model.trim() === "") return undefined
  const provider = (process.env.QUANTA_COMPACT_PROVIDER ?? mainProvider) as Provider
  return new RetryingLLM({ inner: buildLLM(provider, model.trim()), signal })
}

/**
 * Resolve the fallback-provider model ids from `QUANTA_MODEL_FALLBACK`.
 * Default OFF: unset ⇒ `[]` so the llm stack is left byte-identical to
 * today (no `FallbackLLM` wrap). Comma-separated model ids; a bare flag
 * value with no usable id (e.g. `1`) yields `[]` ⇒ no wrap.
 */
export const fallbackModels = (): string[] => {
  const raw = process.env.QUANTA_MODEL_FALLBACK
  if (raw === undefined) return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "1")
}

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

/** Read MCP server configs from `QUANTA_MCP_CONFIG` (a JSON file). OFF if unset. */
export const readMcpConfig = async (slog: StructuredLogger): Promise<McpServerConfig[]> => {
  const path = process.env.QUANTA_MCP_CONFIG
  if (!path) return []
  try {
    const raw = await Bun.file(path).text()
    const parsed = JSON.parse(raw) as { servers?: McpServerConfig[] }
    return Array.isArray(parsed.servers) ? parsed.servers : []
  } catch (e) {
    slog.warn("mcp.config.error", { path, error: (e as Error).message })
    return []
  }
}

/**
 * MEDIUM-12: this filter is a DENYLIST — every new top-level flag that
 * isn't added here will leak into the LLM prompt (e.g. a user typing
 * `--worktree` by mistake would have "--worktree" sent to the model).
 * Future direction: invert to an allowlist (positional args only), but
 * that's out of scope for this PR. For now we keep the list exhaustive.
 */
export const argvPrompt = (): string =>
  process.argv
    .slice(2)
    .filter(
      (a) =>
        a !== "--plan" &&
        a !== "--lsp" &&
        a !== "--lsp-tools" &&
        a !== "--git-tools" &&
        a !== "--new-session" &&
        a !== "--archived" &&
        a !== "--worktree" &&
        a !== "--force" &&
        a !== "--ids" &&
        a !== "--help" &&
        a !== "-h",
    )
    .filter((a, i, arr) => {
      const flagged = arr[i - 1]
      const valued = ["--state", "--resume", "--observe-dir", "--title"]
      return !valued.includes(a) && !valued.includes(flagged ?? "")
    })
    .join(" ")
    .trim()

export interface Features {
  planMode: boolean
  metrics: Metrics | undefined
  state: string | undefined
  resume: string | undefined
  mcpTools: Tool[]
  mcpClients: McpClient[]
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
    lspTools,
    lspNavTools,
    gitToolList,
  }
}

/** Observability wiring (RFC-0002 §5.4/§8). Default OFF → byte-identical to
 *  today (plain StdoutStream, no RunContext). When `observe` is set: a runId
 *  tags a RunContext and the stdout stream is fanned out to a JsonlRecorder.
 *  Pure extraction of the inline block — same effects, same logging. */
export const buildStreaming = (
  observe: string | undefined,
  slog: StructuredLogger,
): { stream: StreamPort; run: RunContext | undefined } => {
  const stream: StreamPort = new StdoutStream()
  if (!observe) return { stream, run: undefined }
  const runId = crypto.randomUUID()
  const run: RunContext = { runId }
  const recorder = new JsonlRecorder(join(observe, runId, "session.jsonl"), { ctx: run })
  slog.info("observe.on", { dir: observe, runId })
  return { stream: new TeeStream([stream, recorder]), run }
}

/** Compose the LLM stack: bounded retry (inner-most), optional same-turn
 *  provider fallback (outer), and — only in `auto` mode — attach the
 *  LLM-backed permission classifier to `permission`. Default OFF for both
 *  fallback and classifier ⇒ `finalLLM === retryingLLM` and `permission`
 *  untouched, byte-identical to today. Pure extraction of the inline block. */
export const composeLLM = (
  retryingLLM: LLMPort,
  provider: Provider,
  signal: AbortSignal,
  mode: PermissionMode,
  permission: PermissionContext,
  slog: StructuredLogger,
): LLMPort => {
  const fbModels = fallbackModels()
  let finalLLM: LLMPort = retryingLLM
  if (fbModels.length > 0) {
    const fallbackStacks = fbModels.map(
      (m) => new RetryingLLM({ inner: buildLLM(provider, m), signal }),
    )
    finalLLM = new FallbackLLM({ providers: [retryingLLM, ...fallbackStacks], signal })
    slog.info("llm.fallback.on", { models: fbModels })
  }
  if (mode === "auto") {
    permission.classify = createAutoClassifierPort({ llm: finalLLM })
    slog.info("permission.auto.on")
  }
  return finalLLM
}

// ── Split: `SessionDeps`, `compactionDep`, `assembleConfig`, `Tooling` live in
//    `./config-assemble` (PURE composition, no env reads). Re-exported below so
//    importers (`index.ts`, tests) are unaffected.
export type { SessionDeps, Tooling } from "./config-assemble"
export { assembleConfig, compactionDep } from "./config-assemble"

export const buildTooling = (
  mcpTools: Tool[],
  lspTools: Tool[],
  lspNavTools: Tool[],
  gitToolList: Tool[],
  slog: StructuredLogger,
): Tooling => {
  const store = buildStore()
  const embedder = buildEmbedder(store)
  const sessionId = crypto.randomUUID()
  if (store) {
    logger.info(
      `memory on (kind=${process.env.QUANTA_MEMORY}, embed=${embedder ? "on" : "off"}, session=${sessionId})`,
    )
  }
  const memoryConfig = buildMemoryConfig(store)
  // Tier 0/1 absorption knobs — all default OFF, each omitted from the
  // AgentConfig entirely when its env knob is unset (exactOptionalPropertyTypes
  // friendly), so unset-all ⇒ AgentConfig byte-identical to before.
  const subagentConfig = buildSubagentConfig()
  const skillsConfig = buildSkillsConfig()
  const compactionBreakerConfig = buildCompactionBreakerConfig()
  const verifyGuardConfig = buildVerifyGuardConfig()
  if (subagentConfig) slog.info("subagent.on", subagentConfig)
  if (skillsConfig) slog.info("skills.on", skillsConfig)
  if (compactionBreakerConfig) slog.info("compaction.breaker.config", compactionBreakerConfig)
  if (verifyGuardConfig) slog.info("verify.guard.on", verifyGuardConfig)
  // Self-edit memory tools: only when a store exists and `memory.selfEditTools`
  // is not opted out (single knob: QUANTA_MEMORY_SELF_EDIT). With no store the
  // registry is byte-identical to before (nothing appended).
  const memTools: Tool[] =
    store && memoryConfig?.selfEditTools !== false
      ? memoryTools({ store, ...(embedder ? { embedder } : {}) })
      : []
  // Tool merge order (last-write-wins via ToolRegistry's Map): defaultTools →
  // mcp → memory → lsp-diagnostics (swaps the no-op diagnostics in defaultTools)
  // → lsp-nav (8 new tools, opt-in) → git (4 new tools, opt-in). All trailing
  // groups are empty arrays when their knobs are unset, so the registry is
  // byte-identical to today when no absorption knob is set.
  const registry = new ToolRegistry([
    ...defaultTools,
    ...mcpTools,
    ...memTools,
    ...lspTools,
    ...lspNavTools,
    ...gitToolList,
  ])
  return {
    store,
    embedder,
    sessionId,
    registry,
    memoryConfig,
    subagentConfig,
    skillsConfig,
    compactionBreakerConfig,
    verifyGuardConfig,
  }
}

/** Inputs for {@link resolveResume} — every reachable code path is either
 *  default-OFF or behind a flag the caller resolves up front. */
export interface ResolveResumeInput {
  resume: string | undefined
  newSession: boolean
  title: string | undefined
  cwd: string
  initialSessionId: string
  slog: StructuredLogger
}

/** Resolved session-startup state. `idMeta` is `undefined` when the run is in
 *  legacy (path-mode or no-resume) mode — the auto-save branch in `index.ts`
 *  uses that as the "id-mode is unreachable" sentinel. */
export interface ResumeResolution {
  history: Message[]
  sessionId: string
  idMeta: SessionMeta | undefined
  /** True iff id-mode (resumed by id OR `--new-session`). The CLI uses this
   *  to defer the `quanta ready` log until the session id is known so the
   *  log line can carry the id (legacy paths emit the log up front). */
  inIdMode: boolean
  /** Set when `--resume <id>` fails to resolve a session — caller exits 1. */
  missingIdError: string | undefined
  /** HIGH-5: set when both `--new-session` and `--resume <id>` are passed.
   *  The combination is ambiguous (which session id wins?), so the caller
   *  prints an error and exits 1 instead of silently ignoring one flag. */
  conflictError: string | undefined
}

/** HIGH-LOW: default title for `--new-session`. Compact UTC `YYYY-MM-DD HH:mm`
 *  (16 chars) is much friendlier than the prior full ISO. */
export const defaultUntitled = (now: number): string =>
  `Untitled ${new Date(now).toISOString().slice(0, 16).replace("T", " ")}`

/** Resolve `--resume` / `--new-session` startup state. Extracted out of
 *  `main()` to keep that function's cognitive complexity bounded. PURE w.r.t.
 *  argv/env — all inputs are explicit, so testable in isolation if needed.
 *
 *  Behavior matrix:
 *  - no resume / no new-session  → legacy default (empty history, initialId)
 *  - `--resume <path-like>`      → V1 path-mode (loadSession + log via slog)
 *  - `--resume <id-like>`        → V2 id-mode (loadSessionById, idMeta set)
 *  - `--new-session [--title t]` → V2 id-mode (fresh id, stub saved) */
export const resolveResume = async (input: ResolveResumeInput): Promise<ResumeResolution> => {
  const { resume, newSession, title, cwd, initialSessionId, slog } = input
  // HIGH-5: `--new-session --resume <id>` previously silently ignored
  // `--new-session` because the `if (resume !== undefined)` branch returned
  // first. Reject the combination up front so the caller can exit 1 with a
  // clear message — mirrors the `missingIdError` sentinel pattern.
  if (resume !== undefined && newSession) {
    return {
      history: [],
      sessionId: initialSessionId,
      idMeta: undefined,
      inIdMode: false,
      missingIdError: undefined,
      conflictError: "cannot combine --new-session with --resume",
    }
  }
  if (resume !== undefined) {
    if (isPathLikeToken(resume)) {
      const prior = await loadSession(resume)
      if (prior !== null) {
        slog.info("state.resumed", { path: resume, messages: prior.messages.length })
        return {
          history: prior.messages,
          sessionId: prior.sessionId,
          idMeta: undefined,
          inIdMode: false,
          missingIdError: undefined,
          conflictError: undefined,
        }
      }
      return {
        history: [],
        sessionId: initialSessionId,
        idMeta: undefined,
        inIdMode: false,
        missingIdError: undefined,
        conflictError: undefined,
      }
    }
    // ID MODE: opaque session id → load via the session store.
    const saved = await loadSessionById(resume)
    if (saved === undefined) {
      return {
        history: [],
        sessionId: initialSessionId,
        idMeta: undefined,
        inIdMode: true,
        missingIdError: resume,
        conflictError: undefined,
      }
    }
    slog.info("session.id_mode.on", {
      id: saved.meta.id,
      title: saved.meta.title,
      cwd: saved.meta.cwd,
      archived: saved.meta.archived,
    })
    return {
      history: saved.messages,
      sessionId: saved.meta.id,
      idMeta: saved.meta,
      inIdMode: true,
      missingIdError: undefined,
      conflictError: undefined,
    }
  }
  if (newSession) {
    const newId = crypto.randomUUID()
    const now = Date.now()
    const idMeta: SessionMeta = {
      id: newId,
      title: title ?? defaultUntitled(now),
      cwd,
      createdAt: now,
      lastTouched: now,
      archived: false,
    }
    await saveSessionById(idMeta, { reason: "fresh", turns: 0, messages: [] })
    logger.info(`session: ${newId}`)
    slog.info("session.id_mode.on", {
      id: idMeta.id,
      title: idMeta.title,
      cwd: idMeta.cwd,
      archived: idMeta.archived,
    })
    return {
      history: [],
      sessionId: newId,
      idMeta,
      inIdMode: true,
      missingIdError: undefined,
      conflictError: undefined,
    }
  }
  return {
    history: [],
    sessionId: initialSessionId,
    idMeta: undefined,
    inIdMode: false,
    missingIdError: undefined,
    conflictError: undefined,
  }
}
