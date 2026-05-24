import type { Subprocess } from "bun"
import { logger, QuantaError } from "@/shared"
import { type CapabilityNegotiator, defaultNegotiator } from "./capabilities"
import { encodeMessage, isResponse, type JsonRpcMessage, LineReader } from "./jsonrpc"
import type { McpCallResult, McpServerConfig, McpToolDef } from "./types"

const PROTOCOL_VERSION = "2025-06-18"
const CLIENT_INFO = { name: "quanta", version: "0.1.0" }
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_TOOLS_LIST_PAGES = 256

/** Max chars of joined tool-result text we hand back from `callTool`. A
 *  malicious/buggy MCP server returning a huge text blob would otherwise flow
 *  unbounded into memory and the model prompt (DOS). Mirrors the repo-wide
 *  tool-output cap (`@/tool` `output-spill.ts` `DEFAULT_TOOL_OUTPUT_MAX =
 *  200_000`); kept as a local constant because `@/mcp` may not import `@/tool`
 *  (slice isolation, RFC §3.1). Sub-cap results are returned byte-identical. */
const MAX_RESULT_CHARS = 200_000

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

/** Bound the joined text to {@link MAX_RESULT_CHARS}. Sub-cap input is returned
 *  by reference (byte-identical, no allocation). Over-cap input is truncated to
 *  the head with a clear `[truncated: N bytes omitted]` marker so the model and
 *  any downstream caller can see the result was clipped. */
const capResultText = (text: string): string => {
  if (text.length <= MAX_RESULT_CHARS) return text
  const omitted = text.length - MAX_RESULT_CHARS
  return `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated: ${omitted} bytes omitted]`
}

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
  private readonly negotiator: CapabilityNegotiator

  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null
  private readonly reader = new LineReader()
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readPump: Promise<void> | null = null
  private started = false
  private stopped = false
  private exited = false

  /** `negotiator` is OPTIONAL (ADR-0196): omitting it preserves the
   *  pre-ADR behavior (`capabilities: {}`) — byte-identical for every
   *  existing caller. The composition root injects `fullNegotiator()` when
   *  `QUANTA_MCP_CAPS=full` is set. */
  constructor(config: McpServerConfig, opts?: { negotiator?: CapabilityNegotiator }) {
    this.config = config
    this.requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
    this.negotiator = opts?.negotiator ?? defaultNegotiator
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
      capabilities: this.negotiator.compile(),
    })
    this.notify("notifications/initialized", {})
  }

  async listTools(): Promise<McpToolDef[]> {
    this.ensureReady()
    const tools: McpToolDef[] = []
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    for (let page = 0; page < MAX_TOOLS_LIST_PAGES; page += 1) {
      const params = cursor === undefined ? {} : { cursor }
      const res = (await this.request("tools/list", params)) as ToolsListResult
      for (const t of res.tools ?? []) tools.push(mapTool(t))
      const nextCursor = res.nextCursor
      if (nextCursor === undefined || nextCursor === "") return tools
      if (seenCursors.has(nextCursor)) {
        throw new McpError(
          `mcp server "${this.config.name}" tools/list returned a repeated cursor "${nextCursor}"`,
        )
      }
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }
    throw new McpError(
      `mcp server "${this.config.name}" tools/list exceeded ${MAX_TOOLS_LIST_PAGES} pages`,
    )
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    this.ensureReady()
    const res = (await this.request("tools/call", {
      name,
      arguments: args ?? {},
    })) as ToolsCallResult
    return {
      ok: res.isError !== true,
      content: capResultText(joinTextBlocks(res.content)),
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
      const sendError = this.send({ jsonrpc: "2.0", id, method, params })
      if (sendError) {
        const pending = this.takePending(id)
        if (!pending) return
        pending.reject(sendError)
      }
    })
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params })
  }

  private send(payload: unknown): Error | null {
    const stdin = this.proc?.stdin
    if (!stdin) {
      const err = new McpError(`mcp server "${this.config.name}" transport unavailable: stdin closed`)
      logger.warn("mcp: failed to write to server stdin", { error: err.message })
      return err
    }
    try {
      stdin.write(encodeMessage(payload))
      return null
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.warn("mcp: failed to write to server stdin", { error: msg })
      return new McpError(`mcp server "${this.config.name}" transport write failed: ${msg}`)
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
    const entry = this.takePending(id)
    if (!entry) return
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

  private takePending(id: number): PendingRequest | undefined {
    const entry = this.pending.get(id)
    if (!entry) return undefined
    this.pending.delete(id)
    clearTimeout(entry.timer)
    return entry
  }
}
