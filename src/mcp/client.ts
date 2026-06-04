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
import { headlessOAuthRejecter } from "./oauth"
import type { McpOAuthProviderPort } from "./oauth/port"
import type { McpPrompt } from "./resources"
import {
  isResourceNotificationMethod,
  isRootsMethod,
  type McpPromptResult,
  type McpResource,
  type McpResourceContent,
  type McpResourceObserver,
  type McpResult,
  parsePromptGet,
  parsePromptList,
  parseResourceList,
  parseResourceRead,
  type RootsProviderPort,
  routeResourceNotification,
  routeRootsList,
} from "./resources"
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

/** H19 — build the typed `unsupported` failure for a method whose required
 *  server capability was not advertised. Refusing locally (instead of emitting
 *  the request and surfacing the server's raw `-32601`) gives the caller a
 *  stable, branchable reason. */
const unsupported = <T>(capability: string, serverName: string): McpResult<T> => ({
  ok: false,
  reason: "unsupported",
  message: `mcp server "${serverName}" does not advertise the "${capability}" capability`,
})

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
  /** The carrier. Constructed eagerly when an explicit transport was supplied
   *  (or no OAuth resolution is needed); otherwise built lazily in `start()`
   *  AFTER the OAuth bearer is resolved so it can be merged into the static
   *  headers the HTTP transport reads at construction (H18). */
  private transport: McpTransport | null
  /** H18 — how to (re)build the carrier once the bearer is known. Set only when
   *  transport construction is deferred (OAuth active + a factory/default
   *  carrier). `null` once `transport` is materialized. */
  private readonly transportFactory: ((config: McpServerConfig) => McpTransport) | null
  /** H18 — the wired OAuth provider. Defaults to {@link headlessOAuthRejecter}
   *  (obtains no token), so a client with no provider — or a server that did NOT
   *  opt in (`config.oauth !== true`) — is byte-identical to the pre-H18 path:
   *  no discovery, no flow, no `Authorization` header. */
  private readonly oauthProvider: McpOAuthProviderPort
  /** H18 — true IFF this server opted into OAuth (`config.oauth === true`) AND a
   *  real provider is wired. The single gate for every OAuth side effect. */
  private readonly oauthActive: boolean
  private readonly elicitationPrompter: ElicitationPrompter
  /** ADR-0470 — inbound `sampling/createMessage` handler. Defaults to
   *  {@link headlessSamplingRejecter} (declines) when none is injected, which
   *  is the advertise-iff-able default: an unwired client does NOT advertise
   *  `sampling` and a server that asks anyway gets a well-defined decline. */
  private readonly samplingHandler: SamplingHandlerPort
  /** H19 — source for inbound `roots/list`. `undefined` (the default) means no
   *  roots source is wired: the client does NOT advertise `roots` and answers an
   *  unsolicited `roots/list` with an empty list (well-defined, never dropped).
   *  Wiring this is the single signal that authorizes advertising `roots`. */
  private readonly rootsProvider: RootsProviderPort | undefined
  /** H19 — optional sink for inbound `notifications/resources/updated` etc.
   *  `undefined` ⇒ notifications are ignored gracefully (byte-identical to the
   *  pre-H19 client which dropped all inbound notifications). */
  private readonly resourceObserver: McpResourceObserver | undefined

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
      rootsProvider?: RootsProviderPort
      resourceObserver?: McpResourceObserver
      oauthProvider?: McpOAuthProviderPort
    },
  ) {
    this.config = config
    this.requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
    this.negotiator = opts?.negotiator ?? defaultNegotiator
    // H18 — OAuth is active only when this server opted in AND a real provider
    // is wired. The default rejecter obtains no token, so an unwired client (or
    // a non-opted-in server) is byte-identical: no deferral, no header.
    this.oauthProvider = opts?.oauthProvider ?? headlessOAuthRejecter
    this.oauthActive = config.oauth === true && opts?.oauthProvider !== undefined
    const t = opts?.transport
    // When OAuth is active we MUST resolve the bearer before constructing the
    // carrier (the HTTP transport reads static headers at construction time), so
    // we defer to `start()` — UNLESS an explicit transport INSTANCE was supplied
    // (a test double / already-built carrier), which we use verbatim. A factory
    // (or the default) is captured and invoked in `start()` with the
    // bearer-merged config.
    if (t !== undefined && typeof t !== "function") {
      // Explicit instance: use as-is (byte-identical to the legacy path).
      this.transport = t
      this.transportFactory = null
    } else {
      const factory = t ?? defaultTransportFor
      if (this.oauthActive) {
        // Defer construction until the bearer is known.
        this.transport = null
        this.transportFactory = factory
      } else {
        // No OAuth: construct eagerly, exactly as before (byte-identical).
        this.transport = factory(config)
        this.transportFactory = null
      }
    }
    // Track C: when no prompter is injected, default to the headless rejecter.
    // This makes inbound `elicitation/create` requests resolve to a proper
    // `{action:"decline"}` response instead of being silently dropped — well-
    // defined and byte-identical-safe (no double prompts in tests).
    this.elicitationPrompter = opts?.elicitationPrompter ?? headlessRejecter
    // ADR-0470: when no sampling handler is injected, default to the headless
    // rejecter. The composition root injects an `@/llm`-backed handler (and a
    // `fullNegotiator({ sampling: true })`) together — advertise-iff-able.
    this.samplingHandler = opts?.samplingHandler ?? headlessSamplingRejecter
    // H19 — both default to undefined (advertise-iff-able / observer-absent),
    // preserving byte-identical negotiation + inbound handling for every
    // existing caller. The composition root wires these from the workspace.
    this.rootsProvider = opts?.rootsProvider
    this.resourceObserver = opts?.resourceObserver
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    if (this.config.command.length === 0 && (this.config.url ?? "") === "") {
      throw new McpError(`mcp server "${this.config.name}" has empty command`)
    }
    // H18 — when OAuth is active the transport was deferred so the bearer can be
    // resolved and merged into the static headers the HTTP carrier reads at
    // construction. `tokenFor` is total (resolves `undefined` on a declined/
    // failed login), in which case we proceed unauthenticated (the server
    // answers 401, surfaced like any other error) rather than crashing the load.
    if (this.transport === null) {
      const token = await this.oauthProvider.tokenFor(this.config.name)
      this.transport = (this.transportFactory ?? defaultTransportFor)(
        this.withBearer(this.config, token),
      )
    }
    const transport = this.transport
    this.unsubscribeMessage = transport.onMessage((msg) => this.dispatch(msg))
    this.unsubscribeExit = transport.onExit(() => this.onTransportExit())
    await transport.start()

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

  /** H19 — does the connected server advertise `resources`? Reads the
   *  `capabilities.resources` slot from the `initialize` response. */
  serverSupportsResources(): boolean {
    const caps = this.serverCapabilities
    return caps !== null && asRecord(caps.resources) !== null
  }

  /** H19 — does the server advertise `resources.subscribe`? A subscribe call is
   *  refused (typed `unsupported`) unless this is true, so we never emit a
   *  `resources/subscribe` the server answers with a raw `-32601`. */
  serverSupportsResourceSubscribe(): boolean {
    const caps = this.serverCapabilities
    if (caps === null) return false
    return asRecord(caps.resources)?.subscribe === true
  }

  /** H19 — does the connected server advertise `prompts`? */
  serverSupportsPrompts(): boolean {
    const caps = this.serverCapabilities
    return caps !== null && asRecord(caps.prompts) !== null
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

  // --- H19: resources / prompts (outbound, no-throw) -----------------------

  /** `resources/list` → typed `McpResource[]`. Refuses locally with a typed
   *  `unsupported` failure when the server didn't advertise `resources` (no raw
   *  `-32601` round-trip). A malformed response → `malformed`; a transport/server
   *  error → `transport`. Never throws. */
  async listResources(): Promise<McpResult<McpResource[]>> {
    if (!this.serverSupportsResources()) {
      return unsupported("resources", this.config.name)
    }
    return this.typedRequest("resources/list", {}, parseResourceList)
  }

  /** `resources/read` → typed `McpResourceContent[]` (text and/or blob blocks).
   *  Same no-throw / capability-gate contract as {@link listResources}. */
  async readResource(uri: string): Promise<McpResult<McpResourceContent[]>> {
    if (!this.serverSupportsResources()) {
      return unsupported("resources", this.config.name)
    }
    return this.typedRequest("resources/read", { uri }, parseResourceRead)
  }

  /** `resources/subscribe` → register interest in change notifications for
   *  `uri`. Refused with `unsupported` unless the server advertises
   *  `resources.subscribe`. The empty `{}` result maps to `value: undefined`. */
  async subscribeResource(uri: string): Promise<McpResult<undefined>> {
    if (!this.serverSupportsResourceSubscribe()) {
      return unsupported("resources.subscribe", this.config.name)
    }
    return this.typedRequest("resources/subscribe", { uri }, () => undefined)
  }

  /** `resources/unsubscribe` — counterpart to {@link subscribeResource}. */
  async unsubscribeResource(uri: string): Promise<McpResult<undefined>> {
    if (!this.serverSupportsResourceSubscribe()) {
      return unsupported("resources.subscribe", this.config.name)
    }
    return this.typedRequest("resources/unsubscribe", { uri }, () => undefined)
  }

  /** `prompts/list` → typed `McpPrompt[]`. Capability-gated on `prompts`. */
  async listPrompts(): Promise<McpResult<McpPrompt[]>> {
    if (!this.serverSupportsPrompts()) {
      return unsupported("prompts", this.config.name)
    }
    return this.typedRequest("prompts/list", {}, parsePromptList)
  }

  /** `prompts/get` → typed `McpPromptResult` (rendered messages). `args` are
   *  forwarded as the spec `arguments` map (omitted when undefined). */
  async getPrompt(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<McpResult<McpPromptResult>> {
    if (!this.serverSupportsPrompts()) {
      return unsupported("prompts", this.config.name)
    }
    const params = args === undefined ? { name } : { name, arguments: args }
    return this.typedRequest("prompts/get", params, parsePromptGet)
  }

  /** Shared no-throw request+parse core for the typed resource/prompt methods.
   *  A server/transport error rejects the underlying request → `transport`; a
   *  parser returning `null` → `malformed`. Never throws. */
  private async typedRequest<T>(
    method: string,
    params: unknown,
    parse: (result: unknown) => T | null,
  ): Promise<McpResult<T>> {
    if (!this.started || this.stopped || this.exited) {
      return {
        ok: false,
        reason: "transport",
        message: `mcp server "${this.config.name}" is not running`,
      }
    }
    let raw: unknown
    try {
      raw = await this.request(method, params)
    } catch (err) {
      return {
        ok: false,
        reason: "transport",
        message: err instanceof Error ? err.message : String(err),
      }
    }
    const parsed = parse(raw)
    if (parsed === null) {
      return {
        ok: false,
        reason: "malformed",
        message: `mcp server "${this.config.name}" ${method} returned a malformed response`,
      }
    }
    return { ok: true, value: parsed }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.failAllPending(new McpError(`mcp server "${this.config.name}" stopped`))
    this.unsubscribeMessage?.()
    this.unsubscribeMessage = null
    // `transport` is null only if `stop()` runs before `start()` materialized
    // the deferred OAuth carrier — nothing to close in that case.
    await this.transport?.close()
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
    if (this.transport === null) {
      // Unreachable on the happy path: `send` is only called after `start()`
      // materializes the carrier. Guarded so a pre-start send fails as a typed
      // error rather than a null deref.
      return new McpError(`mcp server "${this.config.name}" transport not started`)
    }
    const err = this.transport.send(payload)
    if (err === null) return null
    return err instanceof McpError ? err : new McpError(err.message, { cause: err })
  }

  /** H18 — return a copy of `config` with `Authorization: Bearer <token>` merged
   *  into its static headers. When `token` is `undefined` (no token obtained)
   *  the config is returned UNCHANGED, so an unauthenticated load is
   *  byte-identical (no empty/blank header injected). The bearer is never logged
   *  — it flows only into the transport's header map. */
  private withBearer(config: McpServerConfig, token: string | undefined): McpServerConfig {
    if (token === undefined) return config
    return {
      ...config,
      headers: { ...(config.headers ?? {}), Authorization: `Bearer ${token}` },
    }
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
      return
    }
    // H19 — an inbound NOTIFICATION (a `method` WITHOUT an `id`) carries no reply
    // obligation. Resource/prompt change notifications route to the optional
    // observer; any other notification is ignored (byte-identical to pre-H19).
    if ("method" in msg && isResourceNotificationMethod(msg.method)) {
      routeResourceNotification(
        this.resourceObserver,
        msg.method,
        "params" in msg ? msg.params : undefined,
      )
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
    // H19 — inbound `roots/list` (server → client). We answer from the wired
    // `RootsProviderPort`; with none wired the provider defaults to an empty
    // list (we recognize the method, so we never reply `-32601` — a server that
    // asks gets a well-defined empty result rather than a dropped request).
    if (isRootsMethod(method)) {
      const provider = this.rootsProvider ?? { listRoots: () => [] }
      const result = routeRootsList(provider, method)
      this.send({ jsonrpc: "2.0", id, result })
      return
    }
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
