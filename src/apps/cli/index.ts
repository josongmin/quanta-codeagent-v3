import { join } from "node:path"
import * as readline from "node:readline/promises"
import {
  type AgentConfig,
  type AgentOutcome,
  buildSystemPrompt,
  CachingEmbedder,
  createAutoClassifierPort,
  loadMcpTools,
  loadSession,
  memoryTools,
  OpenAIEmbedder,
  RetryingLLM,
  runAgent,
  saveSession,
} from "@/agent"
import { lspDiagnosticsTool, lspNavToolList } from "@/agent/lsp-bridge"
import { AnthropicAdapter, FallbackLLM, type LLMPort, type Message, OpenAIAdapter } from "@/llm"
import type { McpClient, McpServerConfig } from "@/mcp"
import { type EmbedderPort, InMemoryStore, type PersistentStorePort, SqliteStore } from "@/memory"
import { Metrics, StructuredLogger } from "@/observability"
import type { PermissionContext, PermissionMode, ToolAction } from "@/permission"
import { logger, type RunContext } from "@/shared"
import { JsonlRecorder, StdoutStream, type StreamPort, TeeStream } from "@/stream"
import { defaultTools, gitTools, type Tool, ToolRegistry } from "@/tool"
import { loadEnvFiles } from "./dotenv"

loadEnvFiles([".env.dev", ".env.local", ".env"])

const env = (k: string, fallback: string): string => process.env[k] ?? fallback

type Provider = "anthropic" | "openai"

const pickProvider = (): Provider => {
  const explicit = process.env.QUANTA_PROVIDER as Provider | undefined
  if (explicit === "anthropic" || explicit === "openai") return explicit
  if (process.env.ANTHROPIC_API_KEY) return "anthropic"
  if (process.env.OPENAI_API_KEY) return "openai"
  return "anthropic"
}

const buildLLM = (provider: Provider, model: string): LLMPort => {
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set")
    return new OpenAIAdapter({
      apiKey,
      model,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    })
  }
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set")
  return new AnthropicAdapter({ apiKey, model })
}

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
}

/**
 * Build the long-term memory store from env. Default OFF so plain runs are
 * unchanged: `QUANTA_MEMORY=sqlite` → on-disk SqliteStore (path from
 * `QUANTA_MEMORY_PATH`, default `.quanta/memory.sqlite`); `=memory` →
 * volatile InMemoryStore; unset / `off` → no store.
 *
 * SOTA++ memory env (all default OFF / behavior-preserving when no store):
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
const buildStore = (): PersistentStorePort | undefined => {
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
const buildEmbedder = (store: PersistentStorePort | undefined): EmbedderPort | undefined => {
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
const parseRecallTiers = (raw: string | undefined): ("episodic" | "semantic")[] | undefined => {
  if (raw === undefined) return undefined
  const seen = new Set<"episodic" | "semantic">()
  for (const part of raw.split(",")) {
    const t = part.trim().toLowerCase()
    if (t === "episodic" || t === "semantic") seen.add(t)
  }
  return seen.size > 0 ? [...seen] : undefined
}

const buildMemoryConfig = (
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
 * Resolve the `subagent` config block from env (SOTA++ Tier 1, ADR-0011).
 * Default OFF: `QUANTA_SUBAGENT` unset ⇒ `undefined` so the key is omitted
 * entirely and the `Agent`/`Task`/`TaskOutput`/`TaskStop` tools are NOT
 * registered (loop byte-identical). When set, an optional integer
 * `QUANTA_SUBAGENT_MAX_DEPTH` caps recursion (else the runner's default).
 */
const buildSubagentConfig = (): AgentConfig["subagent"] | undefined => {
  if (process.env.QUANTA_SUBAGENT === undefined) return undefined
  const rawDepth = process.env.QUANTA_SUBAGENT_MAX_DEPTH
  const depth = rawDepth !== undefined ? Number.parseInt(rawDepth, 10) : Number.NaN
  return Number.isFinite(depth) ? { maxDepth: depth } : {}
}

/**
 * Resolve the verify-guard control from env (SOTA++ Tier 0 safety, ADR-0011).
 * Default OFF: `QUANTA_VERIFY_GUARD` unset ⇒ `undefined` so the key is omitted
 * and the loop is byte-identical (no tool-history, no finish interception).
 * When set, a finish right after an unverified mutating tool is blocked,
 * forcing one more turn up to `QUANTA_VERIFY_GUARD_MAX_TRIPS` (else default 2).
 */
const buildVerifyGuardConfig = (): AgentConfig["verifyGuard"] | undefined => {
  if (process.env.QUANTA_VERIFY_GUARD === undefined) return undefined
  const raw = process.env.QUANTA_VERIFY_GUARD_MAX_TRIPS
  const trips = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(trips) ? { maxTrips: trips } : {}
}

/**
 * Resolve the `skills` config block from env (SOTA++ Tier 1, ADR-0011).
 * Default OFF: `QUANTA_SKILLS_DIR` unset ⇒ `undefined` so the key is omitted
 * and no skill discovery happens / the `Skill`/`ToolSearch` tools are NOT
 * registered (loop byte-identical). When set ⇒ skills are discovered from it.
 */
const buildSkillsConfig = (): AgentConfig["skills"] | undefined => {
  const dir = process.env.QUANTA_SKILLS_DIR
  return dir ? { dir } : undefined
}

/**
 * Resolve the compaction circuit-breaker control from env (SOTA++ Tier 0
 * safety, ADR-0011). The breaker is ON by default with safe caps and only
 * trips on pathological compaction thrash, so omitting the key is the
 * behavior-preserving default. `QUANTA_COMPACT_BREAKER=off` ⇒
 * `{ disabled: true }`. Optional integer caps overrides (only applied when
 * a valid integer): `QUANTA_COMPACT_BREAKER_REACTIVE_MAX` →
 * `maxConsecutiveReactive`, `QUANTA_COMPACT_BREAKER_PROACTIVE_MAX` →
 * `maxNoProgressProactive`.
 */
const buildCompactionBreakerConfig = (): AgentConfig["compactionBreaker"] | undefined => {
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
 * SOTA++ (ADR-0011): dedicated compaction summarizer model. `QUANTA_COMPACT_MODEL`
 * (+ optional `QUANTA_COMPACT_PROVIDER`, default = the main provider) builds a
 * cheaper/faster `LLMPort` (retry-wrapped, same as the main stack) used ONLY
 * for the compaction summary turn. Unset ⇒ `undefined` ⇒ `config.llm` is used
 * (byte-identical). Tradeoff documented on `AgentConfig.compaction.summarizerLlm`.
 */
const buildSummarizerLlm = (mainProvider: Provider, signal: AbortSignal): LLMPort | undefined => {
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
const fallbackModels = (): string[] => {
  const raw = process.env.QUANTA_MODEL_FALLBACK
  if (raw === undefined) return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "1")
}

const hasArg = (flag: string): boolean => process.argv.slice(2).includes(flag)

/** Resolve the state-file path: `--state <p>` / `QUANTA_STATE_PATH`. Default OFF. */
const statePath = (): string | undefined => {
  const idx = process.argv.indexOf("--state")
  if (idx >= 0) return process.argv[idx + 1]
  return process.env.QUANTA_STATE_PATH
}

/** Resolve the resume path: `--resume <p>` / `QUANTA_RESUME`. Default OFF. */
const resumePath = (): string | undefined => {
  const idx = process.argv.indexOf("--resume")
  if (idx >= 0) return process.argv[idx + 1]
  return process.env.QUANTA_RESUME
}

/** Resolve the observe dir: `--observe-dir <d>` / `QUANTA_OBSERVE_DIR`.
 *  Default OFF (undefined) → current behavior byte-identical. */
const observeDir = (): string | undefined => {
  const idx = process.argv.indexOf("--observe-dir")
  if (idx >= 0) return process.argv[idx + 1]
  return process.env.QUANTA_OBSERVE_DIR
}

/** Plan mode is on when `QUANTA_PLAN=1` or `--plan` is present. */
const planEnabled = (): boolean => process.env.QUANTA_PLAN === "1" || hasArg("--plan")

/** LSP diagnostics tool is on when `QUANTA_LSP=1` or `--lsp` is present.
 *  Default OFF: `defaultTools` already registers a no-op `diagnostics`; this
 *  only swaps in the real language-server-backed provider when asked. The
 *  bridge itself still degrades gracefully if a server binary is absent. */
const lspEnabled = (): boolean => process.env.QUANTA_LSP === "1" || hasArg("--lsp")

/** SOTA++ Codex `may-20-codex-lsp.md` absorption (ADR-0015). LSP NAV tools
 *  (definition / references / hover / type_definition / implementation /
 *  document_symbol / workspace_symbol / rename_preview) are NOT in
 *  `defaultTools` — they expand the tool surface, so opt-in only via
 *  `QUANTA_LSP_TOOLS=full`. With the knob unset the registry is byte-identical. */
const lspNavEnabled = (): boolean => process.env.QUANTA_LSP_TOOLS === "full"

/** SOTA++ Codex `may-20-codex-signal.md` absorption (ADR-0016). First-class
 *  git tools (diff/status/log/blame) are NOT in `defaultTools` to keep the
 *  default registry byte-identical. Opt-in via `QUANTA_GIT_TOOLS=1`. */
const gitToolsEnabled = (): boolean => process.env.QUANTA_GIT_TOOLS === "1"

/** Read MCP server configs from `QUANTA_MCP_CONFIG` (a JSON file). OFF if unset. */
const readMcpConfig = async (slog: StructuredLogger): Promise<McpServerConfig[]> => {
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

const argvPrompt = (): string =>
  process.argv
    .slice(2)
    .filter((a) => a !== "--plan" && a !== "--lsp" && a !== "--lsp-tools" && a !== "--git-tools")
    .filter((a, i, arr) => {
      const flagged = arr[i - 1]
      const valued = ["--state", "--resume", "--observe-dir"]
      return !valued.includes(a) && !valued.includes(flagged ?? "")
    })
    .join(" ")
    .trim()

interface Features {
  planMode: boolean
  metrics: Metrics | undefined
  state: string | undefined
  resume: string | undefined
  mcpTools: Tool[]
  mcpClients: McpClient[]
  lspTools: Tool[]
  /** SOTA++ ADR-0015: LSP nav tools (8). Default-OFF; appended to registry
   *  when `QUANTA_LSP_TOOLS=full`. */
  lspNavTools: Tool[]
  /** SOTA++ ADR-0016: first-class git tools (4). Default-OFF; appended to
   *  registry when `QUANTA_GIT_TOOLS=1`. */
  gitToolList: Tool[]
}

/** Resolve all default-OFF feature flags from env/argv and start MCP servers.
 *  Logs each enabled feature via the structured logger (minimal). */
const loadFeatures = async (slog: StructuredLogger): Promise<Features> => {
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
  // SOTA++ ADR-0015: LSP nav tools. NOT in defaultTools — opt-in only.
  const lspNavTools: Tool[] = lspNavEnabled() ? lspNavToolList() : []
  // SOTA++ ADR-0016: first-class git tools. NOT in defaultTools — opt-in only.
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

/** Interactive REPL loop: each line continues the same conversation. */
const runRepl = async (
  rl: readline.Interface,
  signal: AbortSignal,
  turn: (text: string) => Promise<void>,
): Promise<void> => {
  while (!signal.aborted) {
    const input = (await rl.question("\nquanta› ")).trim()
    if (input === "") continue
    if (input === "/exit" || input === "/quit") break
    await turn(input)
  }
}

/** Observability wiring (RFC-0002 §5.4/§8). Default OFF → byte-identical to
 *  today (plain StdoutStream, no RunContext). When `observe` is set: a runId
 *  tags a RunContext and the stdout stream is fanned out to a JsonlRecorder.
 *  Pure extraction of the inline block — same effects, same logging. */
const buildStreaming = (
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
const composeLLM = (
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

/** Inputs the per-turn `AgentConfig` is assembled from. Grouping the optional
 *  default-OFF knobs keeps `assembleConfig` a single cohesive site and lifts
 *  the conditional-spread chain out of `main`. */
interface SessionDeps {
  llm: LLMPort
  registry: ToolRegistry
  stream: StreamPort
  permission: PermissionContext
  cwd: string
  maxTurns: number
  signal: AbortSignal
  onConfirm: (action: ToolAction) => Promise<boolean>
  store: PersistentStorePort | undefined
  sessionId: string
  embedder: EmbedderPort | undefined
  memoryConfig: AgentConfig["memory"] | undefined
  planMode: boolean
  metrics: Metrics | undefined
  run: RunContext | undefined
  subagentConfig: AgentConfig["subagent"] | undefined
  skillsConfig: AgentConfig["skills"] | undefined
  compactionBreakerConfig: AgentConfig["compactionBreaker"] | undefined
  verifyGuardConfig: AgentConfig["verifyGuard"] | undefined
  summarizerLlm: LLMPort | undefined
}

/** Compaction config dependency. Present when memory/store is on (preserving
 *  the prior `compaction: {}` default) OR a dedicated summarizer model is set;
 *  carries `summarizerLlm` when configured. Absent when neither ⇒ omitted
 *  entirely (byte-identical to the pre-knob default path). */
const compactionDep = (d: SessionDeps): AgentConfig["compaction"] | undefined => {
  if (!d.store && !d.summarizerLlm) return undefined
  return d.summarizerLlm ? { summarizerLlm: d.summarizerLlm } : {}
}

/** Assemble the per-turn `AgentConfig`. Every conditional spread is preserved
 *  verbatim (same keys, same gating) — this is a pure relocation so the wired
 *  knobs are byte-identical; it only moves the chain off `main`/`session`. */
const assembleConfig = (messages: Message[], d: SessionDeps): AgentConfig => {
  const compaction = compactionDep(d)
  return {
    llm: d.llm,
    registry: d.registry,
    stream: d.stream,
    permission: d.permission,
    messages,
    system: buildSystemPrompt(d.cwd),
    cwd: d.cwd,
    maxTurns: d.maxTurns,
    signal: d.signal,
    onConfirm: d.onConfirm,
    // Store/sessionId gated on memory; compaction is now decoupled so a
    // dedicated summarizer model works without a store. Store-only ⇒
    // `compaction: {}` exactly as before (byte-identical).
    ...(d.store ? { store: d.store, sessionId: d.sessionId } : {}),
    ...(compaction ? { compaction } : {}),
    ...(d.embedder ? { embedder: d.embedder } : {}),
    ...(d.memoryConfig ? { memory: d.memoryConfig } : {}),
    ...(d.planMode ? { planMode: true } : {}),
    ...(d.metrics ? { metrics: d.metrics } : {}),
    ...(d.run ? { run: d.run } : {}),
    ...(d.subagentConfig ? { subagent: d.subagentConfig } : {}),
    ...(d.skillsConfig ? { skills: d.skillsConfig } : {}),
    ...(d.compactionBreakerConfig ? { compactionBreaker: d.compactionBreakerConfig } : {}),
    ...(d.verifyGuardConfig ? { verifyGuard: d.verifyGuardConfig } : {}),
  }
}

/** The memory store + tool registry + per-run config knobs, resolved once.
 *  Pure relocation of the inline store/memory/registry block — same env
 *  gating, same logging, same conditional `memoryTools` registration. */
interface Tooling {
  store: PersistentStorePort | undefined
  embedder: EmbedderPort | undefined
  sessionId: string
  registry: ToolRegistry
  memoryConfig: AgentConfig["memory"] | undefined
  subagentConfig: AgentConfig["subagent"] | undefined
  skillsConfig: AgentConfig["skills"] | undefined
  compactionBreakerConfig: AgentConfig["compactionBreaker"] | undefined
  verifyGuardConfig: AgentConfig["verifyGuard"] | undefined
}

const buildTooling = (
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
  // SOTA++ Tier 0/1 absorption knobs — all default OFF, each omitted from the
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
  // byte-identical to today when no SOTA++ knob is set.
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

const main = async (): Promise<void> => {
  const provider = pickProvider()
  const model = env("QUANTA_MODEL", DEFAULT_MODEL[provider])
  const maxTurns = Number(env("QUANTA_MAX_TURNS", "40"))
  // Secure-by-default (S7): unattended auto-allow of every mutating tool
  // gated only by a regex denylist is not secure-by-default. Default is now
  // `default` (ask on mutation; read-only still auto-allows). An explicit
  // QUANTA_PERMISSION=acceptEdits|bypass|auto is still honored.
  const mode = env("QUANTA_PERMISSION", "default") as PermissionMode
  const cwd = process.cwd()
  const slog = new StructuredLogger()

  let llm: LLMPort
  try {
    llm = buildLLM(provider, model)
  } catch (e) {
    logger.error((e as Error).message)
    process.exit(1)
  }
  // All features default OFF → behavior unchanged when no QUANTA_* flag set.
  const {
    planMode,
    metrics,
    state,
    resume,
    mcpTools,
    mcpClients,
    lspTools,
    lspNavTools,
    gitToolList,
  } = await loadFeatures(slog)

  const {
    store,
    embedder,
    sessionId: initialSessionId,
    registry,
    memoryConfig,
    subagentConfig,
    skillsConfig,
    compactionBreakerConfig,
    verifyGuardConfig,
  } = buildTooling(mcpTools, lspTools, lspNavTools, gitToolList, slog)
  // `let` because a resumed session reassigns it before any turn (preserved).
  let sessionId = initialSessionId

  // Observability (RFC-0002 §5.4/§8). Default OFF → byte-identical to today.
  const { stream, run } = buildStreaming(observeDir(), slog)
  const permission: PermissionContext = { mode }

  const abort = new AbortController()
  const shutdownMcp = async (): Promise<void> => {
    for (const c of mcpClients) await c.stop().catch(() => undefined)
  }
  process.on("SIGINT", () => {
    process.stderr.write("\n(interrupt — finishing current step)\n")
    abort.abort()
  })

  // Bounded retry around transient LLM failures (pre-stream only), then the
  // optional same-turn fallback + auto classifier (both default OFF ⇒
  // finalLLM === retryingLLM, byte-identical to today).
  const retryingLLM = new RetryingLLM({ inner: llm, signal: abort.signal })
  const finalLLM = composeLLM(retryingLLM, provider, abort.signal, mode, permission, slog)

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  const onConfirm = async (action: ToolAction): Promise<boolean> => {
    const ans = await rl.question(`Allow ${action.tool}? [y/N] `)
    return ans.trim().toLowerCase() === "y"
  }

  const argPrompt = argvPrompt()
  logger.info(`quanta ready (provider=${provider}, model=${model}, mode=${mode}, cwd=${cwd})`)

  let history: Message[] = []
  if (resume) {
    const prior = await loadSession(resume)
    if (prior) {
      history = prior.messages
      sessionId = prior.sessionId
      slog.info("state.resumed", { path: resume, messages: history.length })
    }
  }

  // Built AFTER the resume block so a resumed `sessionId` is captured (the
  // store-gated branch in assembleConfig must see the post-resume id, exactly
  // as the prior call-time closure did).
  const sessionDeps: SessionDeps = {
    llm: finalLLM,
    registry,
    stream,
    permission,
    cwd,
    maxTurns,
    signal: abort.signal,
    onConfirm,
    store,
    sessionId,
    embedder,
    memoryConfig,
    planMode,
    metrics,
    run,
    subagentConfig,
    skillsConfig,
    compactionBreakerConfig,
    verifyGuardConfig,
    summarizerLlm: buildSummarizerLlm(provider, abort.signal),
  }
  const session = (messages: Message[]): Promise<AgentOutcome> =>
    runAgent(assembleConfig(messages, sessionDeps))

  const turn = async (text: string): Promise<void> => {
    history.push({ role: "user", content: [{ type: "text", text }] })
    const outcome = await session(history)
    history = outcome.messages
    if (state) {
      await saveSession(state, {
        sessionId,
        messages: history,
        reason: outcome.reason,
        turns: outcome.turns,
      })
    }
    if (metrics) slog.info("metrics.snapshot", { snapshot: metrics.snapshot() })
  }

  try {
    if (argPrompt) {
      await turn(argPrompt)
    } else {
      await runRepl(rl, abort.signal, turn)
    }
    rl.close()
  } finally {
    await shutdownMcp()
  }
}

main().catch((e) => {
  logger.error(`fatal: ${(e as Error).message}`)
  process.exit(1)
})
