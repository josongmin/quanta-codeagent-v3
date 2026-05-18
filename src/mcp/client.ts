import type { Subprocess } from "bun"
import { logger, QuantaError } from "@/shared"
import { encodeMessage, isResponse, type JsonRpcMessage, LineReader } from "./jsonrpc"
import type { McpCallResult, McpServerConfig, McpToolDef } from "./types"

const PROTOCOL_VERSION = "2025-06-18"
const CLIENT_INFO = { name: "quanta", version: "0.1.0" }
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Typed MCP failure. Stable code lets callers branch without string matching. */
export class McpError extends QuantaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("mcp", message, options)
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Raw `tools/list` shapes — only the fields we consume are narrowed. */
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

/** Build the spawn env. The full parent env is intentionally NOT inherited so
 *  host secrets never reach an arbitrary server; only PATH is kept so the
 *  command resolves, plus anything the config explicitly opted in. */
const buildEnv = (configEnv?: Record<string, string>): Record<string, string> => {
  const base: Record<string, string> = {}
  const path = process.env.PATH
  if (path !== undefined) base.PATH = path
  return configEnv === undefined ? base : { ...base, ...configEnv }
}

/** A real MCP client speaking newline-delimited JSON-RPC 2.0 over stdio.
 *
 *  Lifecycle: spawn → `initialize` → `notifications/initialized` → ready →
 *  `tools/list` / `tools/call` → `stop()`. Requests are correlated by an
 *  incrementing id with a per-request timeout; every pending request is
 *  rejected if the process exits, so there are never leaked timers or
 *  unhandled rejections. `stop()` is idempotent. */
export class McpClient {
  private readonly config: McpServerConfig
  private readonly requestTimeoutMs: number

  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null
  private readonly reader = new LineReader()
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readPump: Promise<void> | null = null
  private started = false
  private stopped = false
  private exited = false

  constructor(config: McpServerConfig) {
    this.config = config
    this.requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    if (this.config.command.length === 0) {
      throw new McpError(`mcp server "${this.config.name}" has empty command`)
    }
    this.proc = Bun.spawn(this.config.command, {
      cwd: this.config.cwd ?? process.cwd(),
      env: buildEnv(this.config.env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.readPump = this.pumpStdout()
    this.watchExit()

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: CLIENT_INFO,
      capabilities: {},
    })
    this.notify("notifications/initialized", {})
  }

  async listTools(): Promise<McpToolDef[]> {
    this.ensureReady()
    const tools: McpToolDef[] = []
    let cursor: string | undefined
    do {
      const params = cursor === undefined ? {} : { cursor }
      const res = (await this.request("tools/list", params)) as ToolsListResult
      for (const t of res.tools ?? []) tools.push(mapTool(t))
      cursor = res.nextCursor
    } while (cursor !== undefined && cursor !== "")
    return tools
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    this.ensureReady()
    const res = (await this.request("tools/call", {
      name,
      arguments: args ?? {},
    })) as ToolsCallResult
    return {
      ok: res.isError !== true,
      content: joinTextBlocks(res.content),
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    const proc = this.proc
    if (!proc) return
    this.failAllPending(new McpError(`mcp server "${this.config.name}" stopped`))
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

  private ensureReady(): void {
    if (!this.started || this.stopped || !this.proc) {
      throw new McpError(`mcp server "${this.config.name}" is not running`)
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      if (this.stopped || this.exited) {
        reject(new McpError(`mcp server "${this.config.name}" is not running`))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpError(`mcp request "${method}" timed out after ${this.requestTimeoutMs}ms`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ jsonrpc: "2.0", id, method, params })
    })
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params })
  }

  private send(payload: unknown): void {
    const stdin = this.proc?.stdin
    if (!stdin) return
    try {
      stdin.write(encodeMessage(payload))
    } catch (e) {
      logger.warn("mcp: failed to write to server stdin", { error: String(e) })
    }
  }

  private async pumpStdout(): Promise<void> {
    const stdout = this.proc?.stdout
    if (!stdout) return
    try {
      for await (const chunk of stdout) {
        for (const msg of this.reader.push(chunk)) this.dispatch(msg)
      }
    } catch (e) {
      logger.debug("mcp: stdout pump ended", { error: String(e) })
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (!isResponse(msg)) return
    const id = typeof msg.id === "number" ? msg.id : Number(msg.id)
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    if (msg.error) {
      entry.reject(new McpError(`mcp error ${msg.error.code}: ${msg.error.message}`))
    } else {
      entry.resolve(msg.result)
    }
  }

  private watchExit(): void {
    const proc = this.proc
    if (!proc) return
    const onExit = () => {
      this.exited = true
      this.failAllPending(new McpError(`mcp server "${this.config.name}" exited`))
    }
    proc.exited.then(onExit).catch(onExit)
  }

  private failAllPending(reason: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(reason)
    }
    this.pending.clear()
  }
}
