/**
 * Delegating facade over {@link McpClient} + isolated {@link McpTransport}
 * (C-F1 / W0.5 freeze).
 *
 * Isolated MCP is the SAME protocol core as `McpClient`. This class no longer
 * owns initialize / PluginHost JSON-RPC. Production plugin launchers construct
 * `McpClient` + `IsolatedMcpTransport` (`dxt-ready-line`) directly; this facade
 * remains for existing hellgates and explicit IsolatedMcpClient callers.
 *
 * Ready mode for this facade is `dxt-ready-line` (plugin/DXT default). The
 * production factory path (`MCP_USE_ISOLATED_SPAWN`) selects `process-ready`.
 */

import type { IsolatedProcessSpawnerPort } from "@/plugin-isolation"
import { errMessage, logger, QuantaError } from "@/shared"
import { McpClient } from "./client"
import { IsolatedMcpTransport } from "./transports/isolated"
import type { McpCallResult, McpServerConfig, McpToolDef } from "./types"

export { isolatedMcpEnabledFromEnv } from "./client/isolated-flag"

export class IsolatedMcpError extends QuantaError {
  constructor(message: string) {
    super("mcp-isolated", message)
  }
}

export interface IsolatedMcpClientOpts {
  /** Override the spawner port (test seam). Default = `createBunSpawner()`. */
  readonly spawner?: IsolatedProcessSpawnerPort
  /** Override the spawn timeout. Default = 5s (DXT). */
  readonly spawnTimeoutMs?: number
  /** Override the SIGTERM grace. Default = 5s (DXT). */
  readonly gracefulKillMs?: number
  /** Per-request JSON-RPC timeout. Default = 30s. Kept for API compatibility;
   *  the inner `McpClient` still uses its core default. */
  readonly requestTimeoutMs?: number
}

/** Public API mirrors {@link McpClient} so existing plugin/hellgate callers stay
 *  drop-in. All protocol work delegates to the inner client. */
export class IsolatedMcpClient {
  private readonly config: McpServerConfig
  private readonly opts: IsolatedMcpClientOpts
  private inner: McpClient | null = null
  private stopped = false
  private readonly exitHandlers = new Set<(reason?: string) => void>()
  private unsubInnerExit: (() => void) | null = null

  constructor(config: McpServerConfig, opts: IsolatedMcpClientOpts = {}) {
    this.config = config
    this.opts = opts
  }

  async start(): Promise<void> {
    if (this.stopped) {
      throw new IsolatedMcpError(`mcp server "${this.config.name}" is not running`)
    }
    if (this.inner) {
      await this.inner.start()
      return
    }
    const transport = new IsolatedMcpTransport(this.config, {
      ...(this.opts.spawner !== undefined ? { spawner: this.opts.spawner } : {}),
      readyMode: "dxt-ready-line",
      ...(this.opts.spawnTimeoutMs !== undefined
        ? { spawnTimeoutMs: this.opts.spawnTimeoutMs }
        : {}),
      ...(this.opts.gracefulKillMs !== undefined
        ? { gracefulKillMs: this.opts.gracefulKillMs }
        : {}),
    })
    const inner = new McpClient(this.config, { transport })
    this.wireExit(inner)
    this.inner = inner
    try {
      await inner.start()
    } catch (e) {
      this.unsubInnerExit?.()
      this.unsubInnerExit = null
      await inner.stop().catch(() => undefined)
      this.inner = null
      throw this.asIsolated(e)
    }
  }

  async listTools(): Promise<McpToolDef[]> {
    try {
      return await this.ensureInner().listTools()
    } catch (e) {
      throw this.asIsolated(e)
    }
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    try {
      return await this.ensureInner().callTool(name, args)
    } catch (e) {
      throw this.asIsolated(e)
    }
  }

  onExit(handler: (reason?: string) => void): () => void {
    this.exitHandlers.add(handler)
    if (this.inner && this.unsubInnerExit === null) this.wireExit(this.inner)
    return () => this.exitHandlers.delete(handler)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.unsubInnerExit?.()
    this.unsubInnerExit = null
    const inner = this.inner
    if (inner) {
      try {
        await inner.stop()
      } catch (e) {
        logger.debug("isolated-mcp: stop encountered error", { error: errMessage(e) })
      }
    }
  }

  pinnedProtocolVersion(): string | null {
    return this.inner?.pinnedProtocolVersion() ?? null
  }

  private ensureInner(): McpClient {
    if (this.stopped || !this.inner) {
      throw new IsolatedMcpError(`mcp server "${this.config.name}" is not running`)
    }
    return this.inner
  }

  private wireExit(inner: McpClient): void {
    this.unsubInnerExit?.()
    this.unsubInnerExit = inner.onExit((reason) => {
      if (this.stopped) return
      for (const h of this.exitHandlers) h(reason)
    })
  }

  private asIsolated(e: unknown): IsolatedMcpError {
    if (e instanceof IsolatedMcpError) return e
    return new IsolatedMcpError(
      e instanceof Error ? e.message : `mcp server "${this.config.name}": ${errMessage(e)}`,
    )
  }
}
