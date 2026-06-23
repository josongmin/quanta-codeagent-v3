import type { ProxyEnvInput } from "@/runtime/network-proxy"
import { errMessage, runtimeConfig } from "@/shared"
import { type CapabilityNegotiator, defaultNegotiator } from "./capabilities"
import { httpStatusOf, isUnauthorizedError, McpError, unsupported } from "./client/errors"
import { initializeWithDowngrade, pinNegotiatedVersion } from "./client/negotiate"
import {
  asRecord,
  capResultText,
  extractMedia,
  joinTextBlocks,
  mapTool,
  type ToolsCallResult,
  type ToolsListResult,
} from "./client/result-folding"
import { defaultTransportFor, type McpClientTransport } from "./client/transport-factory"
import { headlessRejecter } from "./elicitation"
import {
  type ElicitationResponse,
  isElicitationMethod,
  routeElicitation,
} from "./elicitation/inbound-router"
import type { ElicitationPrompter } from "./elicitation/port"
import { isResponse, type JsonRpcMessage, type JsonRpcResponse } from "./jsonrpc"
import { headlessOAuthRejecter } from "./oauth"
import type { McpOAuthProviderPort } from "./oauth/port"
import { isProgressMethod, type McpProgressHandler, parseProgress } from "./progress"
import { resolveOfferedVersion } from "./protocol-version"
import type {
  McpCompletionArgument,
  McpCompletionRef,
  McpCompletionResult,
  McpPrompt,
  McpResourceTemplate,
} from "./resources"
import {
  isResourceNotificationMethod,
  isRootsMethod,
  type McpPromptResult,
  type McpResource,
  type McpResourceContent,
  type McpResourceObserver,
  type McpResult,
  parseCompletionResult,
  parsePromptGet,
  parsePromptList,
  parseResourceList,
  parseResourceReadCapped,
  parseResourceTemplateList,
  RESOURCE_READ_MAX_CONTENT_CHARS,
  type RootsProviderPort,
  routeResourceNotification,
  routeRootsList,
} from "./resources"
import { headlessSamplingRejecter } from "./sampling"
import { isSamplingMethod, routeSampling, type SamplingResponse } from "./sampling/inbound-router"
import type { SamplingHandlerPort } from "./sampling/port"
import type { McpTransport } from "./transports/port"
import type { McpCallResult, McpServerConfig, McpToolDef } from "./types"

const CLIENT_INFO = { name: "quanta", version: "0.1.0" }
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_TOOLS_LIST_PAGES = 256

/** ADVERSARIAL inbound-DoS bound (jun-06) — the maximum number of inbound
 *  `sampling/createMessage` requests serviced concurrently. A malicious MCP
 *  server can fire an unbounded stream of inbound sampling requests; each can
 *  fan out to a consent prompt + an LLM completion, so without a cap they spawn
 *  unbounded in-flight async tasks (memory) and unbounded inference (cost). At
 *  the cap the client replies with a JSON-RPC `busy` error rather than spawning
 *  another task — back-pressure the server can observe. 8 is generous for any
 *  legitimate server (sampling is interactive, consent-gated) while bounding a
 *  flood. */
const MAX_INBOUND_SAMPLING_IN_FLIGHT = 8

/** Re-export the public surface (error class + folding cluster + transport
 *  factory type) so EVERY external importer of `@/mcp/client` stays
 *  byte-compatible after the split. */
export { McpError } from "./client/errors"
export { extractMedia, sanitizeAnnotations } from "./client/result-folding"
export type { McpClientTransport } from "./client/transport-factory"

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
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
  /** H3 (jun-10) — session-scoped proxy env for the stdio child spawn. */
  private readonly proxyEnv: ProxyEnvInput | undefined
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
  /** §19.4 — per-call progress sinks, keyed by the `progressToken` the call put
   *  in its `tools/call` `_meta`. Registered for the duration of a `callTool`
   *  that supplied an `onProgress`, removed in its `finally`. Empty ⇒ no progress
   *  routing (byte-identical to a client that never sends a progressToken). */
  private readonly progressHandlers = new Map<string | number, McpProgressHandler>()
  private nextProgressToken = 1
  private readonly pending = new Map<number, PendingRequest>()
  private started = false
  private stopped = false
  private exited = false
  private unsubscribeMessage: (() => void) | null = null
  private unsubscribeExit: (() => void) | null = null
  /** ADVERSARIAL inbound-DoS bound (jun-06) — the number of inbound
   *  `sampling/createMessage` requests currently being serviced. Each inbound
   *  sampling request can fan out to a consent prompt + an LLM completion; a
   *  hostile server that fires thousands concurrently would otherwise spawn
   *  thousands of in-flight async tasks (unbounded promises + inference spend).
   *  When this reaches {@link MAX_INBOUND_SAMPLING_IN_FLIGHT} the client replies
   *  with a JSON-RPC `busy` error INSTEAD of spawning another task. */
  private inboundSamplingInFlight = 0
  /** H18 — a shared in-flight mid-session re-auth (invalidate → fresh bearer →
   *  carrier rebuild). `null` when idle; set while a re-auth runs so concurrent
   *  401s coalesce into a single rebuild rather than racing the carrier swap. */
  private reauthInFlight: Promise<boolean> | null = null
  /** Server-advertised capability record captured from the `initialize`
   *  response (ADR-0431). `null` until `start()` completes. Used to gate the
   *  optional `tasks/*` surface: tools are wired ONLY when a connected server
   *  advertises `capabilities.tasks` — absent ⇒ byte-identical (no tools). */
  private serverCapabilities: Record<string, unknown> | null = null
  /** Ticket misc-jun-7/01 — the protocol version OFFERED on `initialize`,
   *  resolved once at construction from {@link resolveOfferedVersion} (the
   *  `QUANTA_MCP_PROTOCOL_MAX` knob, else the SSOT newest). Bound into the
   *  default/HTTP transport factory so the carrier stamps the same offer the
   *  `initialize` body carries. */
  private readonly offeredVersion: string
  /** Ticket misc-jun-7/01 — the protocol version PINNED after the server's
   *  `initialize` reply was accepted (the offer when the server omits one).
   *  `null` until `start()` completes. */
  private negotiatedVersion: string | null = null
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
      /** H3 (jun-10) — session-scoped egress proxy env threaded down to the
       *  stdio child spawn so an MCP server's OWN sockets are gated. Absent ⇒
       *  byte-identical (no proxy keys in the child env). */
      proxyEnv?: ProxyEnvInput
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
    // Ticket misc-jun-7/01 — resolve the OFFERED protocol version once. Absent
    // knob ⇒ SSOT newest (competitor parity); `QUANTA_MCP_PROTOCOL_MAX` pins a
    // lower ceiling (e.g. back to the floor ⇒ byte-identical to pre-ticket). An
    // unsupported override conservatively falls back to the SSOT newest.
    this.offeredVersion = resolveOfferedVersion(runtimeConfig().mcpProtocolMax)
    this.proxyEnv = opts?.proxyEnv
    const t = opts?.transport
    // Bind the offered version into the DEFAULT factory so the HTTP carrier
    // stamps the same offer the `initialize` body carries. An INJECTED factory
    // (test double) keeps its single-arg `McpClientTransport` shape unchanged.
    const boundDefault = (cfg: McpServerConfig): McpTransport =>
      defaultTransportFor(cfg, this.offeredVersion, this.proxyEnv)
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
      const factory = t ?? boundDefault
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
      const build =
        this.transportFactory ??
        ((cfg: McpServerConfig) => defaultTransportFor(cfg, this.offeredVersion, this.proxyEnv))
      this.transport = build(this.withBearer(this.config, token))
    }
    const transport = this.transport
    this.unsubscribeMessage = transport.onMessage((msg) => this.dispatch(msg))
    this.unsubscribeExit = transport.onExit(() => this.onTransportExit())
    await transport.start()

    // Ticket misc-jun-7/01 — negotiate the protocol version. Offer the resolved
    // version; the §4.c single bounded re-offer downgrades to the floor IFF a
    // strict server rejects an unknown NEWER offer with a JSON-RPC error.
    //
    // R1 (fail-closed teardown): the negotiation read introduces a NEW throw
    // site that fires AFTER a successful `initialize` (a server replying with an
    // unsupported version), at which point the carrier is already `start()`ed
    // with its pumps live. Pre-ticket the reply was discarded, so this could not
    // throw. Tear the carrier down before propagating so a fail-closed (or a §4.c
    // double-reject) never leaks a live transport, subscriptions, or — on HTTP —
    // a standalone SSE GET. `stop()` is idempotent and closes the carrier, drops
    // the subscriptions, and fails any pending request.
    try {
      const { result: initResult, offered } = await initializeWithDowngrade(
        this.offeredVersion,
        transport,
        (version) => this.sendInitialize(version),
      )
      this.serverCapabilities = asRecord(initResult)?.capabilities
        ? (asRecord(asRecord(initResult)?.capabilities) ?? {})
        : {}
      // Read + accept/legacy-tolerant/fail-closed the server's chosen
      // protocolVersion (previously discarded), then pin the HTTP header to it.
      this.negotiatedVersion = pinNegotiatedVersion(
        initResult,
        offered,
        transport,
        this.config.name,
      )
    } catch (err) {
      await this.stop().catch(() => {})
      throw err
    }
    this.notify("notifications/initialized", {})
  }

  /** Emit a single `initialize` request with `version` as the offered
   *  `protocolVersion`. Capabilities + clientInfo are unchanged by this ticket. */
  private sendInitialize(version: string): Promise<unknown> {
    return this.request("initialize", {
      protocolVersion: version,
      clientInfo: CLIENT_INFO,
      capabilities: this.negotiator.compile(),
    })
  }

  /** Ticket misc-jun-7/01 — the protocol version pinned for this session (the
   *  server's choice, or the offer when the server omitted one). `null` until
   *  `start()` completes. Exposed for diagnostics + the SSOT wire tests. */
  pinnedProtocolVersion(): string | null {
    return this.negotiatedVersion
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

  /** §1.2 (ticket-09) — the last SSE event id seen on the standalone stream, for
   *  the reconnect supervisor to carry across a restart (passed as the new
   *  client's `resumeFromEventId`). Feature-detected: only the HTTP-SSE carrier
   *  tracks it; stdio / a torn-down transport ⇒ `null` (no resume). */
  getLastEventId(): string | null {
    const t = this.transport as { getLastEventId?(): string | null } | null
    return typeof t?.getLastEventId === "function" ? t.getLastEventId() : null
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

  /** TICKET-20 — does the connected server advertise `completions`? An
   *  outbound `completion/complete` is refused locally (typed `unsupported`)
   *  unless this is true, so we never emit a request the server answers with a
   *  raw `-32601`. */
  serverSupportsCompletions(): boolean {
    const caps = this.serverCapabilities
    return caps !== null && asRecord(caps.completions) !== null
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

  async callTool(
    name: string,
    args: unknown,
    opts?: { onProgress?: McpProgressHandler },
  ): Promise<McpCallResult> {
    this.ensureReady()
    // §19.4 — when the caller wants progress, mint a unique token, register the
    // sink, and attach `_meta.progressToken` so the server knows it MAY emit
    // `notifications/progress` for this call. No `onProgress` ⇒ no token, no
    // `_meta` (byte-identical to the legacy `tools/call` params).
    const progressToken = opts?.onProgress !== undefined ? this.nextProgressToken++ : undefined
    if (progressToken !== undefined && opts?.onProgress !== undefined) {
      this.progressHandlers.set(progressToken, opts.onProgress)
    }
    try {
      const res = (await this.request("tools/call", {
        name,
        arguments: args ?? {},
        ...(progressToken !== undefined ? { _meta: { progressToken } } : {}),
      })) as ToolsCallResult
      return this.foldCallResult(res)
    } finally {
      if (progressToken !== undefined) this.progressHandlers.delete(progressToken)
    }
  }

  /** Fold the raw `tools/call` result into the typed {@link McpCallResult}. */
  private foldCallResult(res: ToolsCallResult): McpCallResult {
    // §19.3 — surface non-text media (image / embedded resource) ALONGSIDE the
    // joined text. Empty ⇒ `media` is omitted so the result is byte-identical to
    // the legacy text-only shape for every server that returns only text.
    const media = extractMedia(res.content)
    return {
      ok: res.isError !== true,
      content: capResultText(joinTextBlocks(res.content)),
      ...(media.length > 0 ? { media } : {}),
      // §19.2 — carry the server's typed structuredContent through to the bridge.
      // Absent ⇒ omitted (byte-identical to the legacy text-only result).
      ...(res.structuredContent !== undefined ? { structured: res.structuredContent } : {}),
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
   *  Same no-throw / capability-gate contract as {@link listResources}.
   *
   *  R2 #3 — the response is size-gated by {@link parseResourceReadCapped}: a
   *  server returning `text`/`blob` content whose cumulative size exceeds
   *  `RESOURCE_READ_MAX_CONTENT_CHARS` is refused with a typed `too-large`
   *  failure (no unbounded allocation), rather than flowing an arbitrarily large
   *  payload into memory and the model prompt. */
  async readResource(uri: string): Promise<McpResult<McpResourceContent[]>> {
    if (!this.serverSupportsResources()) {
      return unsupported("resources", this.config.name)
    }
    if (!this.started || this.stopped || this.exited) {
      return {
        ok: false,
        reason: "transport",
        message: `mcp server "${this.config.name}" is not running`,
      }
    }
    let raw: unknown
    try {
      raw = await this.request("resources/read", { uri })
    } catch (err) {
      return {
        ok: false,
        reason: "transport",
        message: errMessage(err),
      }
    }
    const parsed = parseResourceReadCapped(raw)
    if (parsed.kind === "malformed") {
      return {
        ok: false,
        reason: "malformed",
        message: `mcp server "${this.config.name}" resources/read returned a malformed response`,
      }
    }
    if (parsed.kind === "too-large") {
      return {
        ok: false,
        reason: "too-large",
        message: `mcp server "${this.config.name}" resources/read content (${parsed.chars} chars) exceeds the ${RESOURCE_READ_MAX_CONTENT_CHARS}-char cap`,
      }
    }
    return { ok: true, value: parsed.contents }
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

  /** TICKET-20 — `resources/templates/list` → typed `McpResourceTemplate[]`
   *  (RFC 6570 `uriTemplate` entries). Folds under the server's `resources`
   *  capability (a template list is a parameterized resource list); refused
   *  locally with `unsupported` when the server omits `resources` (no raw
   *  `-32601` round-trip). A malformed response → `malformed`; an all-malformed
   *  list → `ok` with `[]`. Never throws. */
  async listResourceTemplates(): Promise<McpResult<McpResourceTemplate[]>> {
    if (!this.serverSupportsResources()) {
      return unsupported("resources", this.config.name)
    }
    return this.typedRequest("resources/templates/list", {}, parseResourceTemplateList)
  }

  /** TICKET-20 — `completion/complete` → typed {@link McpCompletionResult}.
   *  Capability-gated on the SERVER's `completions` capability: refused locally
   *  with `unsupported` (no `completion/complete` frame ever put on the wire)
   *  when the server didn't advertise it. `ref` is a discriminated union
   *  ({@link McpCompletionRef}) so callers branch type-safely. An EMPTY
   *  `values:[]` is a first-class OK; a malformed completion → `malformed`.
   *  Never throws. */
  async complete(
    ref: McpCompletionRef,
    argument: McpCompletionArgument,
  ): Promise<McpResult<McpCompletionResult>> {
    if (!this.serverSupportsCompletions()) {
      return unsupported("completions", this.config.name)
    }
    return this.typedRequest("completion/complete", { ref, argument }, parseCompletionResult)
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
        message: errMessage(err),
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
    // Ticket misc-jun-7/01 R4 — UNSUBSCRIBE the carrier-exit handler BEFORE
    // `close()`. A real carrier fires its exit handler FROM `close()` (HTTP's
    // `http-sse.ts close()` → `fireExit` synchronously; stdio's `proc.exited`).
    // That routes to `onTransportExit()`, which fans a `"transport exit"` out to
    // EXTERNAL subscribers (the ADR-0435 auto-restart supervisor). A DELIBERATE
    // `stop()` (incl. the R1 fail-closed teardown inside `start()` for an
    // unsupported negotiated version) must NOT masquerade as a crash, or the
    // supervisor crash-loop-restarts a server that will fail-close again forever.
    // Dropping the subscription first makes the client-initiated close silent on
    // the supervisor channel; an UNSOLICITED carrier death (server crash) still
    // fans out, because that path never goes through `stop()`.
    this.unsubscribeExit?.()
    this.unsubscribeExit = null
    // `transport` is null only if `stop()` runs before `start()` materialized
    // the deferred OAuth carrier — nothing to close in that case.
    await this.transport?.close()
  }

  // --- internals -----------------------------------------------------------

  private ensureReady(): void {
    if (!this.started || this.stopped || this.exited) {
      throw new McpError(`mcp server "${this.config.name}" is not running`)
    }
  }

  /** Issue an MCP request, transparently re-authenticating + retrying ONCE on a
   *  mid-session 401 when OAuth is active for this server. On every other path
   *  this is byte-identical to a single {@link requestRpc} call: a non-401 error
   *  propagates unchanged, and a non-OAuth client never enters the re-auth
   *  branch (so a 401 there surfaces as the ordinary transport error it always
   *  was). The retry is bounded to a single attempt — a second 401 (e.g. the
   *  refreshed token is ALSO rejected) propagates, never looping. */
  private async request(method: string, params: unknown): Promise<unknown> {
    try {
      return await this.requestRpc(method, params)
    } catch (err) {
      // H18 — a mid-session 401 (the server revoked the bearer after we
      // connected) is the single error we recover from, and ONLY when OAuth is
      // active. We forget the stale token, rebuild the carrier with a freshly
      // resolved bearer, and retry the SAME request once. Any other error — or a
      // 401 on a non-OAuth client — propagates exactly as before.
      if (!this.oauthActive || !isUnauthorizedError(err)) throw err
      const reauthed = await this.reauthorize()
      if (!reauthed) throw err // no fresh token obtained ⇒ surface the original 401
      return this.requestRpc(method, params)
    }
  }

  private requestRpc(method: string, params: unknown): Promise<unknown> {
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

  /** H18 — recover from a mid-session 401: forget the (now-revoked) bearer, ask
   *  the provider for a fresh one, and rebuild the carrier so the new
   *  `Authorization` header reaches the wire (the HTTP transport reads static
   *  headers at construction, so a header swap requires a fresh carrier).
   *
   *  Returns `true` IFF a fresh, DIFFERENT bearer was obtained and the carrier
   *  was rebuilt; `false` when no token can be re-resolved (declined/failed
   *  refresh+re-auth) — the caller then surfaces the original 401 rather than
   *  retrying with the same (or no) credential. Only invoked on the OAuth-active
   *  path. Never throws (the provider port is total; rebuild failures degrade to
   *  `false`). Guarded against a rebuild with no factory (explicit-instance
   *  transport) — there is no carrier to rebuild, so re-auth is a no-op `false`.
   *
   *  Reentrancy: a single in-flight re-auth is shared so concurrent 401s on
   *  parallel requests rebuild the carrier exactly once. */
  private reauthorize(): Promise<boolean> {
    this.reauthInFlight ??= this.doReauthorize().finally(() => {
      this.reauthInFlight = null
    })
    return this.reauthInFlight
  }

  private async doReauthorize(): Promise<boolean> {
    if (this.stopped || this.exited) return false
    if (this.transportFactory === null) return false // explicit-instance carrier
    // Forget the revoked token so the next `tokenFor` refreshes/re-authorizes,
    // then resolve a fresh bearer. The port is total (no throw, `undefined` on
    // decline). The bearer is never logged.
    await this.oauthProvider.invalidate(this.config.name)
    const token = await this.oauthProvider.tokenFor(this.config.name)
    if (token === undefined) return false
    // Tear down the old carrier's subscriptions + connection, then rebuild with
    // the bearer-merged config and re-wire the pumps. Pending requests stay
    // queued (their ids are still valid) and resolve on the rebuilt carrier.
    this.unsubscribeMessage?.()
    this.unsubscribeExit?.()
    const old = this.transport
    const next = this.transportFactory(this.withBearer(this.config, token))
    this.transport = next
    this.unsubscribeMessage = next.onMessage((msg) => this.dispatch(msg))
    this.unsubscribeExit = next.onExit(() => this.onTransportExit())
    await next.start()
    // Close the stale carrier last so a close-time error never blocks the rebuilt
    // path; failures here are non-fatal (the connection is already replaced).
    await old?.close().catch(() => {})
    return true
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      this.resolveResponse(msg)
      return
    }
    if (!("method" in msg)) return
    const params = "params" in msg ? msg.params : undefined
    // Track C: an inbound REQUEST (has both `id` and `method`) is a call FROM the
    // server (elicitation / sampling / roots) and carries a reply obligation.
    if ("id" in msg) {
      this.handleInboundRequest(msg.id, msg.method, params)
      return
    }
    // A `method` WITHOUT an `id` is a NOTIFICATION (no reply obligation).
    // §19.4 progress routes to the per-call sink; H19/§19.5 resource/prompt/tool
    // change notifications route to the optional observer; anything else is
    // ignored (byte-identical to the pre-notification client).
    if (isProgressMethod(msg.method)) {
      this.routeProgressNotification(params)
      return
    }
    if (isResourceNotificationMethod(msg.method)) {
      routeResourceNotification(this.resourceObserver, msg.method, params)
    }
  }

  /** Settle the pending request a server RESPONSE correlates to. Extracted from
   *  {@link dispatch} so the dispatcher stays a flat router. R4 (structured-401):
   *  a carrier-surfaced `error.data.httpStatus` is copied onto the typed error so
   *  `isUnauthorizedError` keys off the STRUCTURED number, not a substring. */
  private resolveResponse(msg: JsonRpcResponse): void {
    const id = typeof msg.id === "number" ? msg.id : Number(msg.id)
    const entry = this.takePending(id)
    if (!entry) return
    if (msg.error) {
      const httpStatus = httpStatusOf(msg.error.data)
      // Ticket misc-jun-7/01 R2 — carry the JSON-RPC code structurally so the
      // §4.c re-offer can scope itself to a genuine version-rejection rather than
      // firing on any McpError (timeout / transient fault).
      const code = typeof msg.error.code === "number" ? msg.error.code : undefined
      entry.reject(
        new McpError(`mcp error ${msg.error.code}: ${msg.error.message}`, {
          ...(httpStatus !== undefined ? { httpStatus } : {}),
          ...(code !== undefined ? { jsonRpcCode: code } : {}),
        }),
      )
      return
    }
    entry.resolve(msg.result)
  }

  /** §19.4 — route an inbound `notifications/progress` to the PER-CALL sink
   *  registered under its `progressToken`. Unknown/expired token ⇒ dropped. The
   *  sink is no-throw by contract, but we guard so a buggy one can never crash
   *  the transport message pump. */
  private routeProgressNotification(params: unknown): void {
    const p = parseProgress(params)
    if (p === null) return
    const handler = this.progressHandlers.get(p.progressToken)
    if (handler === undefined) return
    try {
      handler(p)
    } catch {
      // swallow — a throwing progress sink must not break dispatch
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
    // ADVERSARIAL inbound-DoS bound — refuse (with observable back-pressure)
    // once too many inbound sampling requests are already in flight, rather
    // than spawning an unbounded number of consent/LLM tasks. The server gets a
    // typed `busy` error and can retry; it cannot wedge us into OOM/spend.
    if (this.inboundSamplingInFlight >= MAX_INBOUND_SAMPLING_IN_FLIGHT) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: "sampling: too many in-flight requests" },
      })
      return
    }
    this.inboundSamplingInFlight++
    const done = (): void => {
      this.inboundSamplingInFlight--
    }
    void routeSampling(this.samplingHandler, method, params).then(
      (response: SamplingResponse) => {
        done()
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
        done()
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
