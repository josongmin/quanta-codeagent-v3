import { QuantaError } from "@/shared"
import { type CapabilityNegotiator, defaultNegotiator } from "./capabilities"
import { headlessRejecter } from "./elicitation"
import {
  type ElicitationResponse,
  isElicitationMethod,
  routeElicitation,
} from "./elicitation/inbound-router"
import type { ElicitationPrompter } from "./elicitation/port"
import { isResponse, type JsonRpcMessage } from "./jsonrpc"
import { headlessSamplingRejecter } from "./sampling"
import { isSamplingMethod, routeSampling, type SamplingResponse } from "./sampling/inbound-router"
import type { SamplingHandlerPort } from "./sampling/port"
import { HttpSseMcpTransport } from "./transports/http-sse"
import type { McpTransport } from "./transports/port"
import { StdioMcpTransport } from "./transports/stdio"
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

/** Narrow an unknown value to a plain record (object, not array/null). Used to
 *  safely walk the `initialize` response's nested `capabilities` slot. */
const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

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

/** How to construct the carrier for a {@link McpClient}. Omitting it (the
 *  default) selects the stdio transport, which is byte-identical to every
 *  pre-ADR-0391 deployment. A function lets callers fully control construction
 *  (e.g. an HTTP transport, or a test double); an explicit `McpTransport`
 *  instance is also accepted. */
export type McpClientTransport = McpTransport | ((config: McpServerConfig) => McpTransport)

/** Build the default transport for a config. Stdio is the default carrier; the
 *  HTTP-SSE carrier is selected only when the config carries a `url` (an
 *  explicit opt-in), preserving stdio byte-identity for every command-based
 *  server. */
const defaultTransportFor = (config: McpServerConfig): McpTransport => {
  if (config.url !== undefined && config.url !== "") {
    return new HttpSseMcpTransport({
      url: config.url,
      name: config.name,
      ...(config.headers !== undefined ? { headers: config.headers } : {}),
    })
  }
  return new StdioMcpTransport(config)
}

/** A real MCP client speaking newline-delimited JSON-RPC 2.0 over a pluggable
 *  {@link McpTransport} (default: stdio).
 *
 *  Lifecycle: transport.start → `initialize` → `notifications/initialized` →
 *  ready → `tools/list` / `tools/call` → `stop()`. Requests are correlated by
 *  an incrementing id with a per-request timeout; every pending request is
 *  rejected if the transport exits, so there are never leaked timers or
 *  unhandled rejections. `stop()` is idempotent.
 *
 *  The request/dispatch/pending/timeout *core* is transport-agnostic: it only
 *  ever calls `transport.send` and consumes decoded messages via
 *  `transport.onMessage`. */
export class McpClient {
  private readonly config: McpServerConfig
  private readonly requestTimeoutMs: number
  private readonly negotiator: CapabilityNegotiator
  private readonly transport: McpTransport
  private readonly elicitationPrompter: ElicitationPrompter
  /** ADR-0470 — inbound `sampling/createMessage` handler. Defaults to
   *  {@link headlessSamplingRejecter} (declines) when none is injected, which
   *  is the advertise-iff-able default: an unwired client does NOT advertise
   *  `sampling` and a server that asks anyway gets a well-defined decline. */
  private readonly samplingHandler: SamplingHandlerPort

  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private started = false
  private stopped = false
  private exited = false
  private unsubscribeMessage: (() => void) | null = null
  private unsubscribeExit: (() => void) | null = null
  /** Server-advertised capability record captured from the `initialize`
   *  response (ADR-0431). `null` until `start()` completes. Used to gate the
   *  optional `tasks/*` surface: tools are wired ONLY when a connected server
   *  advertises `capabilities.tasks` — absent ⇒ byte-identical (no tools). */
  private serverCapabilities: Record<string, unknown> | null = null
  /** External exit subscribers (ADR-0435 auto-restart supervisor). Empty unless
   *  a supervisor wires one in — when empty, `onTransportExit` is byte-identical
   *  to the pre-ADR behavior (the fan-out loop iterates zero times). */
  private readonly exitHandlers = new Set<(reason?: string) => void>()

  /** `negotiator` is OPTIONAL (ADR-0196): omitting it preserves the
   *  pre-ADR behavior (`capabilities: {}`) — byte-identical for every
   *  existing caller. The composition root injects `fullNegotiator()` when
   *  `QUANTA_MCP_CAPS=full` is set.
   *
   *  `transport` is OPTIONAL (ADR-0391): omitting it selects stdio (or HTTP-SSE
   *  if the config carries a `url`) — byte-identical to the pre-port client for
   *  every command-based server. */
  constructor(
    config: McpServerConfig,
    opts?: {
      negotiator?: CapabilityNegotiator
      transport?: McpClientTransport
      elicitationPrompter?: ElicitationPrompter
      samplingHandler?: SamplingHandlerPort
    },
  ) {
    this.config = config
    this.requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
    this.negotiator = opts?.negotiator ?? defaultNegotiator
    const t = opts?.transport
    this.transport =
      t === undefined ? defaultTransportFor(config) : typeof t === "function" ? t(config) : t
    // Track C: when no prompter is injected, default to the headless rejecter.
    // This makes inbound `elicitation/create` requests resolve to a proper
    // `{action:"decline"}` response instead of being silently dropped — well-
    // defined and byte-identical-safe (no double prompts in tests).
    this.elicitationPrompter = opts?.elicitationPrompter ?? headlessRejecter
    // ADR-0470: when no sampling handler is injected, default to the headless
    // rejecter. The composition root injects an `@/llm`-backed handler (and a
    // `fullNegotiator({ sampling: true })`) together — advertise-iff-able.
    this.samplingHandler = opts?.samplingHandler ?? headlessSamplingRejecter
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    if (this.config.command.length === 0 && (this.config.url ?? "") === "") {
      throw new McpError(`mcp server "${this.config.name}" has empty command`)
    }
    this.unsubscribeMessage = this.transport.onMessage((msg) => this.dispatch(msg))
    this.unsubscribeExit = this.transport.onExit(() => this.onTransportExit())
    await this.transport.start()

    const initResult = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: CLIENT_INFO,
      capabilities: this.negotiator.compile(),
    })
    this.serverCapabilities = asRecord(initResult)?.capabilities
      ? (asRecord(asRecord(initResult)?.capabilities) ?? {})
      : {}
    this.notify("notifications/initialized", {})
  }

  /** ADR-0431 — does the connected server advertise the `tasks/*` capability?
   *  Reads the `capabilities.tasks` slot captured from the `initialize`
   *  response. Returns `false` before `start()` completes, when the server
   *  omits the slot, or when the slot is not an object. The composition root
   *  uses this to gate the optional MCP-tasks tool surface (default-OFF). */
  serverSupportsTasks(): boolean {
    const caps = this.serverCapabilities
    if (caps === null) return false
    return asRecord(caps.tasks) !== null
  }

  /** ADR-0431 — dispatch a single outbound JSON-RPC request and return the raw
   *  `result`. Mirrors the inbound elicitation router but for client→server
   *  calls: it goes through the same correlated `request`/timeout/pending core
   *  as `tools/call`. Transport errors (exit, timeout) reject with `McpError`,
   *  exactly like every other request. Used by `clientTasksPort` to speak
   *  `tasks/list` / `tasks/getInfo` / `tasks/getResult` / `tasks/cancel`.
   *
   *  Kept generic (method + params → result) so the `@/mcp/tasks` adapter owns
   *  the per-method response codec rather than baking task shapes into the
   *  transport core. */
  async requestRaw(method: string, params?: unknown): Promise<unknown> {
    this.ensureReady()
    return this.request(method, params ?? {})
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
    this.failAllPending(new McpError(`mcp server "${this.config.name}" stopped`))
    this.unsubscribeMessage?.()
    this.unsubscribeMessage = null
    await this.transport.close()
    this.unsubscribeExit?.()
    this.unsubscribeExit = null
  }

  // --- internals -----------------------------------------------------------

  private ensureReady(): void {
    if (!this.started || this.stopped || this.exited) {
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

  /** Hand a payload to the transport. A transport-level enqueue failure is
   *  wrapped as an {@link McpError} so callers branch on a stable type; the
   *  transport never throws here (it returns the error). */
  private send(payload: unknown): Error | null {
    const err = this.transport.send(payload)
    if (err === null) return null
    return err instanceof McpError ? err : new McpError(err.message, { cause: err })
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id)
      const entry = this.takePending(id)
      if (!entry) return
      if (msg.error) {
        entry.reject(new McpError(`mcp error ${msg.error.code}: ${msg.error.message}`))
      } else {
        entry.resolve(msg.result)
      }
      return
    }
    // Track C: an inbound REQUEST (has both `id` and `method`) is a call FROM
    // the server. Route elicitation requests to the prompter and reply.
    // Notifications (a `method` WITHOUT an `id`) carry no reply obligation and
    // are ignored — byte-identical to the pre-Track-C behavior.
    if ("method" in msg && "id" in msg) {
      this.handleInboundRequest(msg.id, msg.method, "params" in msg ? msg.params : undefined)
    }
  }

  /** Service an inbound server→client JSON-RPC request. Two inbound methods are
   *  handled — `elicitation/*` (routes to the prompter) and `sampling/
   *  createMessage` (ADR-0470, routes to the sampling handler). Any other
   *  inbound method gets a `-32601 method not found` JSON-RPC error so the
   *  server is never left hanging on a dropped request. Never throws (both port
   *  contracts are no-throw, and any unexpected failure is mapped to a typed
   *  decline response). */
  private handleInboundRequest(id: number | string, method: string, params: unknown): void {
    // ADR-0470 — sampling/createMessage routes to the injected handler. With no
    // handler wired the default rejecter declines (and the client does not
    // advertise `sampling`, so a well-behaved server never reaches here). A
    // decline is shaped as a JSON-RPC *error*, not a dropped request.
    if (isSamplingMethod(method)) {
      this.handleInboundSampling(id, method, params)
      return
    }
    if (!isElicitationMethod(method)) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      })
      return
    }
    void routeElicitation(this.elicitationPrompter, method, params).then(
      (response: ElicitationResponse) => {
        this.send({ jsonrpc: "2.0", id, result: response })
      },
      // Defensive: the prompter contract is no-throw, but if a custom impl
      // rejects we still must answer rather than drop the request.
      () => {
        this.send({ jsonrpc: "2.0", id, result: { action: "decline" } })
      },
    )
  }

  /** ADR-0470 — route an inbound `sampling/createMessage` request to the
   *  injected {@link SamplingHandlerPort} and reply. A fulfilled completion is
   *  sent as the JSON-RPC `result`; a typed decline (the default-OFF case is
   *  `no-handler`) is sent as a JSON-RPC `error` so the server learns the
   *  client refused rather than being left hanging. Never throws — the router
   *  contract is total and a rejecting custom handler is mapped to a decline. */
  private handleInboundSampling(id: number | string, method: string, params: unknown): void {
    void routeSampling(this.samplingHandler, method, params).then(
      (response: SamplingResponse) => {
        if (response.kind === "result") {
          this.send({ jsonrpc: "2.0", id, result: response.result })
        } else {
          this.send({
            jsonrpc: "2.0",
            id,
            error: { code: response.code, message: response.message },
          })
        }
      },
      // Defensive: routeSampling is no-throw, but if it ever rejects we still
      // answer rather than drop the request.
      () => {
        this.send({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "sampling: internal error" },
        })
      },
    )
  }

  /** Subscribe to a one-shot transport-exit notification (ADR-0435). Returns an
   *  unsubscribe. No-op for the default code path (no subscriber registered). */
  onExit(handler: (reason?: string) => void): () => void {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  private onTransportExit(): void {
    this.exited = true
    this.failAllPending(new McpError(`mcp server "${this.config.name}" exited`))
    // Fan-out to external subscribers (auto-restart supervisor). Zero
    // subscribers ⇒ this loop is a no-op and the side effects above are
    // byte-identical to the pre-ADR-0435 behavior.
    for (const h of this.exitHandlers) h("transport exit")
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
