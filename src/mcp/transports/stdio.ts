/** Stdio transport for the MCP client (ADR-0391).
 *
 *  This is the DEFAULT carrier and a byte-identical extraction of the spawn +
 *  stdin.write + stdout-pump + proc.exited logic that previously lived inline
 *  in `../client.ts`. The encoding (`encodeMessage`) and framing (`LineReader`)
 *  coupling now lives here, behind the {@link McpTransport} port, instead of in
 *  the client core.
 *
 *  Env policy is unchanged: the full parent env is intentionally NOT inherited
 *  so host secrets never reach an arbitrary server; only PATH is kept so the
 *  command resolves, plus anything the config explicitly opted in. */

import type { Subprocess } from "bun"
import { logger } from "@/shared"
import { encodeMessage, LineReader } from "../jsonrpc"
import type { McpServerConfig } from "../types"
import type {
  McpTransport,
  McpTransportExitHandler,
  McpTransportMessageHandler,
  McpTransportPayload,
} from "./port"

/** Build the spawn env. The full parent env is intentionally NOT inherited so
 *  host secrets never reach an arbitrary server; only PATH is kept so the
 *  command resolves, plus anything the config explicitly opted in.
 *  (Moved verbatim from `../client.ts` — byte-identical.) */
const buildEnv = (configEnv?: Record<string, string>): Record<string, string> => {
  const base: Record<string, string> = {}
  const path = process.env.PATH
  if (path !== undefined) base.PATH = path
  return configEnv === undefined ? base : { ...base, ...configEnv }
}

/** Optional spawn seam so tests can drive the transport without a real
 *  subprocess. Defaults to `Bun.spawn`. */
export type StdioSpawnFn = (
  command: string[],
  opts: {
    cwd: string
    env: Record<string, string>
    stdin: "pipe"
    stdout: "pipe"
    stderr: "pipe"
  },
) => Subprocess<"pipe", "pipe", "pipe">

const defaultSpawn: StdioSpawnFn = (command, opts) =>
  Bun.spawn(command, opts) as Subprocess<"pipe", "pipe", "pipe">

export interface StdioTransportOpts {
  /** Spawn seam (test injection). Default = `Bun.spawn`. */
  readonly spawn?: StdioSpawnFn
}

/** Newline-delimited JSON-RPC over a spawned subprocess's stdio. */
export class StdioMcpTransport implements McpTransport {
  private readonly config: McpServerConfig
  private readonly spawnFn: StdioSpawnFn
  private readonly reader = new LineReader()
  private readonly messageHandlers = new Set<McpTransportMessageHandler>()
  private readonly exitHandlers = new Set<McpTransportExitHandler>()

  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null
  private readPump: Promise<void> | null = null
  private exitFired = false

  constructor(config: McpServerConfig, opts: StdioTransportOpts = {}) {
    this.config = config
    this.spawnFn = opts.spawn ?? defaultSpawn
  }

  async start(): Promise<void> {
    if (this.proc) return
    this.proc = this.spawnFn(this.config.command, {
      cwd: this.config.cwd ?? process.cwd(),
      env: buildEnv(this.config.env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.readPump = this.pumpStdout()
    this.watchExit()
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

  send(payload: McpTransportPayload): Error | null {
    const stdin = this.proc?.stdin
    if (!stdin) {
      const err = new Error(`mcp server "${this.config.name}" transport unavailable: stdin closed`)
      logger.warn("mcp: failed to write to server stdin", { error: err.message })
      return err
    }
    try {
      stdin.write(encodeMessage(payload))
      return null
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.warn("mcp: failed to write to server stdin", { error: msg })
      return new Error(`mcp server "${this.config.name}" transport write failed: ${msg}`)
    }
  }

  async close(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    try {
      proc.stdin?.end()
    } catch {
      // stdin may already be closed
    }
    try {
      proc.kill()
    } catch {
      // process may have already exited
    }
    await proc.exited.catch(() => undefined)
    await this.readPump?.catch(() => undefined)
    this.proc = null
  }

  // --- internals -----------------------------------------------------------

  private async pumpStdout(): Promise<void> {
    const stdout = this.proc?.stdout
    if (!stdout) return
    try {
      for await (const chunk of stdout) {
        for (const msg of this.reader.push(chunk)) this.emitMessage(msg)
      }
    } catch (e) {
      logger.debug("mcp: stdout pump ended", { error: String(e) })
    }
  }

  private watchExit(): void {
    const proc = this.proc
    if (!proc) return
    const onExit = () => this.fireExit(`mcp server "${this.config.name}" exited`)
    proc.exited.then(onExit).catch(onExit)
  }

  private emitMessage(msg: Parameters<McpTransportMessageHandler>[0]): void {
    for (const handler of [...this.messageHandlers]) {
      try {
        handler(msg)
      } catch {
        // A failing handler must not poison sibling subscribers or the pump.
      }
    }
  }

  private fireExit(reason: string): void {
    if (this.exitFired) return
    this.exitFired = true
    for (const handler of [...this.exitHandlers]) {
      try {
        handler(reason)
      } catch {
        // ignore handler errors during teardown
      }
    }
  }
}
