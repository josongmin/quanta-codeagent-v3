import * as readline from "node:readline/promises"
import {
  type AgentConfig,
  type AgentOutcome,
  buildSystemPrompt,
  CachingEmbedder,
  loadMcpTools,
  loadSession,
  memoryTools,
  OpenAIEmbedder,
  RetryingLLM,
  runAgent,
  saveSession,
} from "@/agent"
import { lspDiagnosticsTool } from "@/agent/lsp-bridge"
import { AnthropicAdapter, type LLMPort, type Message, OpenAIAdapter } from "@/llm"
import type { McpClient, McpServerConfig } from "@/mcp"
import { type EmbedderPort, InMemoryStore, type PersistentStorePort, SqliteStore } from "@/memory"
import { Metrics, StructuredLogger } from "@/observability"
import type { PermissionContext, PermissionMode, ToolAction } from "@/permission"
import { logger } from "@/shared"
import { StdoutStream } from "@/stream"
import { defaultTools, type Tool, ToolRegistry } from "@/tool"
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

/** Plan mode is on when `QUANTA_PLAN=1` or `--plan` is present. */
const planEnabled = (): boolean => process.env.QUANTA_PLAN === "1" || hasArg("--plan")

/** LSP diagnostics tool is on when `QUANTA_LSP=1` or `--lsp` is present.
 *  Default OFF: `defaultTools` already registers a no-op `diagnostics`; this
 *  only swaps in the real language-server-backed provider when asked. The
 *  bridge itself still degrades gracefully if a server binary is absent. */
const lspEnabled = (): boolean => process.env.QUANTA_LSP === "1" || hasArg("--lsp")

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
    .filter((a) => a !== "--plan" && a !== "--lsp")
    .filter((a, i, arr) => {
      const flagged = arr[i - 1]
      return a !== "--state" && a !== "--resume" && flagged !== "--state" && flagged !== "--resume"
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

  if (planMode) slog.info("plan.mode.on")
  if (metrics) slog.info("metrics.on")
  if (state) slog.info("state.persist.on", { path: state })
  if (mcpTools.length > 0) slog.info("mcp.tools.loaded", { count: mcpTools.length })
  if (lspTools.length > 0) slog.info("lsp.diagnostics.on")
  return { planMode, metrics, state, resume, mcpTools, mcpClients, lspTools }
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

const main = async (): Promise<void> => {
  const provider = pickProvider()
  const model = env("QUANTA_MODEL", DEFAULT_MODEL[provider])
  const maxTurns = Number(env("QUANTA_MAX_TURNS", "40"))
  const mode = env("QUANTA_PERMISSION", "acceptEdits") as PermissionMode
  const cwd = process.cwd()
  const slog = new StructuredLogger()

  let llm: LLMPort
  try {
    llm = buildLLM(provider, model)
  } catch (e) {
    logger.error((e as Error).message)
    process.exit(1)
  }
  const store = buildStore()
  const embedder = buildEmbedder(store)
  let sessionId: string = crypto.randomUUID()
  if (store) {
    logger.info(
      `memory on (kind=${process.env.QUANTA_MEMORY}, embed=${embedder ? "on" : "off"}, session=${sessionId})`,
    )
  }

  // All features default OFF → behavior unchanged when no QUANTA_* flag set.
  const { planMode, metrics, state, resume, mcpTools, mcpClients, lspTools } =
    await loadFeatures(slog)

  const memoryConfig = buildMemoryConfig(store)
  // Self-edit memory tools: only when a store exists and `memory.selfEditTools`
  // is not opted out (single knob: QUANTA_MEMORY_SELF_EDIT). With no store the
  // registry is byte-identical to before (nothing appended).
  const memTools: Tool[] =
    store && memoryConfig?.selfEditTools !== false
      ? memoryTools({ store, ...(embedder ? { embedder } : {}) })
      : []
  const registry = new ToolRegistry([...defaultTools, ...mcpTools, ...memTools, ...lspTools])
  const stream = new StdoutStream()
  const permission: PermissionContext = { mode }

  const abort = new AbortController()
  const shutdownMcp = async (): Promise<void> => {
    for (const c of mcpClients) await c.stop().catch(() => undefined)
  }
  process.on("SIGINT", () => {
    process.stderr.write("\n(interrupt — finishing current step)\n")
    abort.abort()
  })

  // Bounded retry around transient LLM failures (pre-stream only).
  const retryingLLM = new RetryingLLM({ inner: llm, signal: abort.signal })

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  const onConfirm = async (action: ToolAction): Promise<boolean> => {
    const ans = await rl.question(`Allow ${action.tool}? [y/N] `)
    return ans.trim().toLowerCase() === "y"
  }

  const session = (messages: Message[]): Promise<AgentOutcome> => {
    const config: AgentConfig = {
      llm: retryingLLM,
      registry,
      stream,
      permission,
      messages,
      system: buildSystemPrompt(cwd),
      cwd,
      maxTurns,
      signal: abort.signal,
      onConfirm,
      // Memory + compaction are co-gated: only active when a store is set, so
      // default (no QUANTA_MEMORY) runs are byte-for-byte unchanged.
      ...(store ? { store, sessionId, compaction: {} } : {}),
      ...(embedder ? { embedder } : {}),
      ...(memoryConfig ? { memory: memoryConfig } : {}),
      ...(planMode ? { planMode: true } : {}),
      ...(metrics ? { metrics } : {}),
    }
    return runAgent(config)
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
