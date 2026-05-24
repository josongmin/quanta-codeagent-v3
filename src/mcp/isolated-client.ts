/**
 * Alternative `McpClient` backed by the `@/plugin-isolation` spawner port
 * (ADR-0162 Phase E).
 *
 * **Default OFF** — gated by `MCP_USE_ISOLATED_SPAWN=1`. The legacy
 * {@link McpClient} (direct `Bun.spawn` in `./client.ts`) remains the default
 * code path, preserving byte-identical behavior for every existing
 * deployment. Setting the env var swaps the spawn implementation; the public
 * surface (`start` / `listTools` / `callTool` / `stop`) is identical.
 *
 * Why opt-in? The isolated client adds:
 *  - 5s typed spawn-timeout (the legacy client waits only for stdin/stdout
 *    pipes to be wired; a hung MCP server's `initialize` is bounded by
 *    `requestTimeoutMs` instead).
 *  - 5s SIGTERM→SIGKILL grace (legacy uses a single `kill()` — a
 *    `trap '' TERM` server would never exit).
 *  - ASCII-validated service name surfaced via `QUANTA_SERVICE_NAME` env.
 *
 * The trade-off is observability: the isolated path logs differently and
 * exposes the JSON-RPC layer via `PluginHost`. For most users the legacy
 * path is fine; the isolated path is for plugins that load unsigned native
 * libs or have a history of crash-looping.
 *
 * Slice contract: this module lives in `@/mcp` (alongside the legacy client)
 * and depends on `@/plugin-isolation` + `@/shared`. It does NOT export from
 * the `@/mcp` barrel by default — callers wire it explicitly via
 * `isolatedMcpEnabledFromEnv()` + `IsolatedMcpClient` import.
 */

import {
  createBunSpawner,
  DEFAULT_GRACEFUL_KILL_MS,
  DEFAULT_SPAWN_TIMEOUT_MS,
  type IsolatedProcessSpawnerPort,
  PluginHost,
  PluginHostError,
} from "@/plugin-isolation"
import { logger, QuantaError } from "@/shared"
import type { McpCallResult, McpServerConfig, McpToolDef } from "./types"

const PROTOCOL_VERSION = "2025-06-18"
const CLIENT_INFO = { name: "quanta", version: "0.1.0" }
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Mirror of `client.ts` MAX_RESULT_CHARS — the slice-isolation rule (RFC §3.1)
 *  forbids importing from `@/tool`, so the constant is duplicated locally and
 *  kept in lockstep by code review. */
const MAX_RESULT_CHARS = 200_000

const ISOLATED_ENV_VAR = "MCP_USE_ISOLATED_SPAWN"

/** Env-flag check. Exported so wire code in `@/agent` (or apps/cli) can
 *  branch on the same source of truth, instead of re-reading the env. */
export const isolatedMcpEnabledFromEnv = (env?: Record<string, string | undefined>): boolean => {
  const source = env ?? (process.env as Record<string, string | undefined>)
  const v = source[ISOLATED_ENV_VAR]
  return v === "1" || v === "true" || v === "yes"
}

export class IsolatedMcpError extends QuantaError {
  constructor(message: string) {
    super("mcp-isolated", message)
  }
}

interface RawTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}
interface ToolsListResult {
  tools?: RawTool[]
  nextCursor?: string
}
interface ContentBlock {
  type: string
  text?: string
}
interface ToolsCallResult {
  content?: ContentBlock[]
  isError?: boolean
}

const mapTool = (t: RawTool): McpToolDef => ({
  name: t.name,
  description: t.description ?? "",
  inputSchema: t.inputSchema ?? { type: "object" },
})

const joinTextBlocks = (content: ContentBlock[] | undefined): string =>
  (content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text ?? "")
    .join("\n")

const capResultText = (text: string): string => {
  if (text.length <= MAX_RESULT_CHARS) return text
  const omitted = text.length - MAX_RESULT_CHARS
  return `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated: ${omitted} bytes omitted]`
}

/** Service-name sanitiser. The MCP `config.name` is free-form (UUID, "user's
 *  server", etc.); the spawner requires ASCII [A-Za-z0-9._-]{1,64}. We
 *  sanitise + truncate, falling back to a stable hash-prefix if nothing
 *  remains so two servers with garbage names don't collide. */
const sanitiseServiceName = (name: string): string => {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64)
  // Spawner regex requires the first char NOT be a special char.
  if (cleaned.length === 0 || !/^[A-Za-z0-9]/.test(cleaned)) {
    return `mcp_${cleaned}`.slice(0, 64) || "mcp_anon"
  }
  return cleaned
}

export interface IsolatedMcpClientOpts {
  /** Override the spawner port (test seam). Default = `createBunSpawner()`. */
  readonly spawner?: IsolatedProcessSpawnerPort
  /** Override the spawn timeout. Default = 5s (DXT). */
  readonly spawnTimeoutMs?: number
  /** Override the SIGTERM grace. Default = 5s (DXT). */
  readonly gracefulKillMs?: number
  /** Per-request JSON-RPC timeout. Default = 30s. */
  readonly requestTimeoutMs?: number
}

/** Public API mirrors {@link McpClient} from `./client.ts` so the two are
 *  drop-in interchangeable. Differences are internal — the isolated path
 *  delegates spawn to {@link IsolatedProcessSpawnerPort} and uses
 *  {@link PluginHost} for JSON-RPC correlation. */
export class IsolatedMcpClient {
  private readonly config: McpServerConfig
  private readonly spawner: IsolatedProcessSpawnerPort
  private readonly spawnTimeoutMs: number
  private readonly gracefulKillMs: number
  private readonly requestTimeoutMs: number

  private host: PluginHost | null = null
  private started = false
  private stopped = false

  constructor(config: McpServerConfig, opts: IsolatedMcpClientOpts = {}) {
    this.config = config
    this.spawner = opts.spawner ?? createBunSpawner()
    this.spawnTimeoutMs = opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS
    this.gracefulKillMs = opts.gracefulKillMs ?? DEFAULT_GRACEFUL_KILL_MS
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    if (this.config.command.length === 0) {
      throw new IsolatedMcpError(`mcp server "${this.config.name}" has empty command`)
    }
    const entry = this.config.command[0]
    if (entry === undefined) {
      throw new IsolatedMcpError(`mcp server "${this.config.name}" has empty command`)
    }
    const args = this.config.command.slice(1)
    const spawnOpts: Parameters<IsolatedProcessSpawnerPort["spawn"]>[0] = {
      entry,
      args,
      serviceName: sanitiseServiceName(this.config.name),
      spawnTimeoutMs: this.spawnTimeoutMs,
      gracefulKillMs: this.gracefulKillMs,
      cwd: this.config.cwd ?? process.cwd(),
    }
    if (this.config.env !== undefined) Object.assign(spawnOpts, { env: this.config.env })

    const proc = await this.spawner.spawn(spawnOpts)
    this.host = new PluginHost(proc, { defaultCallTimeoutMs: this.requestTimeoutMs })
    try {
      await this.host.call("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: CLIENT_INFO,
        capabilities: {},
      })
      this.host.notify("notifications/initialized", {})
    } catch (e) {
      // Roll back partial start so a follow-up start() can be reattempted.
      void this.host.stop().catch(() => undefined)
      this.host = null
      this.started = false
      throw new IsolatedMcpError(`mcp server "${this.config.name}" initialize failed: ${String(e)}`)
    }
  }

  async listTools(): Promise<McpToolDef[]> {
    const host = this.ensureReady()
    const tools: McpToolDef[] = []
    let cursor: string | undefined
    do {
      const params = cursor === undefined ? {} : { cursor }
      const res = (await host.call("tools/list", params)) as ToolsListResult
      for (const t of res.tools ?? []) tools.push(mapTool(t))
      cursor = res.nextCursor
    } while (cursor !== undefined && cursor !== "")
    return tools
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    const host = this.ensureReady()
    let res: ToolsCallResult
    try {
      res = (await host.call("tools/call", {
        name,
        arguments: args ?? {},
      })) as ToolsCallResult
    } catch (e) {
      if (e instanceof PluginHostError) {
        throw new IsolatedMcpError(`mcp call "${name}" failed (${e.kind}): ${e.message}`)
      }
      throw e
    }
    return {
      ok: res.isError !== true,
      content: capResultText(joinTextBlocks(res.content)),
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    const host = this.host
    this.host = null
    if (host) {
      try {
        await host.stop()
      } catch (e) {
        logger.debug("isolated-mcp: stop encountered error", { error: String(e) })
      }
    }
  }

  // --- internals -----------------------------------------------------------

  private ensureReady(): PluginHost {
    if (!this.started || this.stopped || !this.host) {
      throw new IsolatedMcpError(`mcp server "${this.config.name}" is not running`)
    }
    return this.host
  }
}
