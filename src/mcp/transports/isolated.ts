/** Isolated-process MCP transport (C-F1).
 *
 *  Same {@link McpTransport} port as stdio/HTTP. Spawn is delegated to
 *  {@link IsolatedProcessSpawnerPort}; JSON-RPC correlation stays in `McpClient`.
 *
 *  Ready modes (W0.5 freeze):
 *  - `dxt-ready-line` — first stdout line is a sentinel (DXT/plugin default).
 *  - `process-ready` — stdio connected is ready; first line is JSON-RPC (McpClient owns initialize).
 *
 *  Send failures (dead/oversize) surface as `Error` via {@link McpTransport.send}.
 *  DXT `IsolatedProcess.send` stays NO-THROW; this adapter uses `trySend` when present. */

import {
  createBunSpawner,
  DEFAULT_GRACEFUL_KILL_MS,
  DEFAULT_SPAWN_TIMEOUT_MS,
  type IsolatedProcess,
  type IsolatedProcessSpawnerPort,
} from "@/plugin-isolation"
import type { IsolatedReadyMode } from "@/plugin-isolation/types"
import { type ProxyEnvInput, withProxyEnv } from "@/runtime/network-proxy"
import { errMessage, isJsonRpcEnvelope, logger } from "@/shared"
import type { JsonRpcMessage } from "../jsonrpc"
import type { McpServerConfig } from "../types"
import type {
  McpTransport,
  McpTransportExitHandler,
  McpTransportMessageHandler,
  McpTransportPayload,
} from "./port"

/** MCP `config.name` is free-form; the spawner requires ASCII [A-Za-z0-9._-]{1,64}. */
export const sanitiseIsolatedServiceName = (name: string): string => {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64)
  if (cleaned.length === 0 || !/^[A-Za-z0-9]/.test(cleaned)) {
    return `mcp_${cleaned}`.slice(0, 64) || "mcp_anon"
  }
  return cleaned
}

export interface IsolatedMcpTransportOpts {
  readonly spawner?: IsolatedProcessSpawnerPort
  readonly readyMode?: IsolatedReadyMode
  readonly spawnTimeoutMs?: number
  readonly gracefulKillMs?: number
  readonly proxyEnv?: ProxyEnvInput
}

const spawnEnv = (
  configEnv: Record<string, string> | undefined,
  proxyEnv: ProxyEnvInput | undefined,
): Record<string, string> | undefined => {
  const withConfig = configEnv === undefined ? {} : { ...configEnv }
  const merged = withProxyEnv(withConfig, proxyEnv ?? {}) as Record<string, string>
  return Object.keys(merged).length === 0 ? undefined : merged
}

export class IsolatedMcpTransport implements McpTransport {
  private readonly config: McpServerConfig
  private readonly spawner: IsolatedProcessSpawnerPort
  private readonly readyMode: IsolatedReadyMode
  private readonly spawnTimeoutMs: number
  private readonly gracefulKillMs: number
  private readonly proxyEnv: ProxyEnvInput | undefined

  private readonly messageHandlers = new Set<McpTransportMessageHandler>()
  private readonly exitHandlers = new Set<McpTransportExitHandler>()

  private proc: IsolatedProcess | null = null
  private unsubMessages: (() => void) | null = null
  private exitFired = false
  private closing = false

  constructor(config: McpServerConfig, opts: IsolatedMcpTransportOpts = {}) {
    this.config = config
    this.spawner = opts.spawner ?? createBunSpawner()
    // DXT/plugin default. `defaultTransportFor` must pass `process-ready` (C-F1).
    this.readyMode = opts.readyMode ?? "dxt-ready-line"
    this.spawnTimeoutMs = opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS
    this.gracefulKillMs = opts.gracefulKillMs ?? DEFAULT_GRACEFUL_KILL_MS
    this.proxyEnv = opts.proxyEnv
  }

  readonly readyModeUsed = (): IsolatedReadyMode => this.readyMode

  async start(): Promise<void> {
    if (this.proc) return
    if (this.config.command.length === 0) {
      throw new Error(`mcp server "${this.config.name}" has empty command`)
    }
    const entry = this.config.command[0]
    if (entry === undefined) {
      throw new Error(`mcp server "${this.config.name}" has empty command`)
    }
    const env = spawnEnv(this.config.env, this.proxyEnv)
    const spawnOpts = {
      entry,
      args: this.config.command.slice(1),
      serviceName: sanitiseIsolatedServiceName(this.config.name),
      spawnTimeoutMs: this.spawnTimeoutMs,
      gracefulKillMs: this.gracefulKillMs,
      cwd: this.config.cwd ?? process.cwd(),
      readyMode: this.readyMode,
      ...(env !== undefined ? { env } : {}),
    }
    const proc = await this.spawner.spawn(spawnOpts)
    this.proc = proc
    this.unsubMessages = proc.onMessage((msg) => {
      if (isJsonRpcEnvelope(msg)) this.emitMessage(msg as JsonRpcMessage)
    })
    void proc.exitPromise.then(
      () => this.fireExit(`mcp server "${this.config.name}" exited`),
      () => this.fireExit(`mcp server "${this.config.name}" exited`),
    )
  }

  onMessage(handler: McpTransportMessageHandler): () => void {
    this.messageHandlers.add(handler)
    return () => {
      this.messageHandlers.delete(handler)
    }
  }

  onExit(handler: McpTransportExitHandler): () => void {
    this.exitHandlers.add(handler)
    return () => {
      this.exitHandlers.delete(handler)
    }
  }

  setProtocolVersion(_version: string): void {
    // Isolated stdio stamps no header.
  }

  send(payload: McpTransportPayload): Error | null {
    const proc = this.proc
    if (!proc) {
      return new Error(`mcp server "${this.config.name}" transport unavailable: not started`)
    }
    if (typeof proc.trySend === "function") {
      const err = proc.trySend(payload)
      if (err === null) return null
      logger.warn("mcp: isolated send failed", { server: this.config.name, error: err.message })
      return err instanceof Error ? err : new Error(errMessage(err))
    }
    try {
      proc.send(payload)
      return null
    } catch (e) {
      const msg = errMessage(e)
      logger.warn("mcp: isolated send failed", { server: this.config.name, error: msg })
      return new Error(`mcp server "${this.config.name}" transport write failed: ${msg}`)
    }
  }

  async close(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    this.closing = true
    this.unsubMessages?.()
    this.unsubMessages = null
    try {
      await proc.kill("SIGTERM")
    } catch {
      // already exited
    }
    this.proc = null
  }

  private emitMessage(msg: JsonRpcMessage): void {
    for (const handler of [...this.messageHandlers]) {
      try {
        handler(msg)
      } catch (e) {
        // A failing handler must not poison sibling subscribers or the pump — but a
        // handler that throws on every message is a bug, and an unbound catch made it
        // invisible.
        logger.warn(`mcp isolated transport: a message handler threw: ${errMessage(e)}`)
      }
    }
  }

  private fireExit(reason: string): void {
    if (this.exitFired || this.closing) return
    this.exitFired = true
    for (const handler of [...this.exitHandlers]) {
      try {
        handler(reason)
      } catch (e) {
        // Teardown continues for the other handlers; the failure is attributed, not lost.
        logger.warn(`mcp isolated transport: an exit handler threw (${reason}): ${errMessage(e)}`)
      }
    }
  }
}
