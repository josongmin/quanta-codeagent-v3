import { errMessage, QuantaError, runtimeConfig } from "@/shared"
import { type CapabilityNegotiator, defaultNegotiator } from "./capabilities"
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
import {
  isSupportedProtocolVersion,
  PROTOCOL_DOWNGRADE_FLOOR,
  resolveOfferedVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./protocol-version"
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
  parseResourceReadCapped,
  RESOURCE_READ_MAX_CONTENT_CHARS,
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
import type {
  McpCallResult,
  McpMediaBlock,
  McpServerConfig,
  McpToolAnnotations,
  McpToolDef,
} from "./types"

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

/** Typed MCP failure. Stable code lets callers branch without string matching.
 *
 *  R4 (structured-401) — when a failure originated from an HTTP transport
 *  non-2xx, the carrier surfaces the REAL numeric status through the JSON-RPC
 *  error's `data.httpStatus` slot; `dispatch` copies it onto `httpStatus` here
 *  so auth-staleness can key off a STRUCTURED signal rather than substring-
 *  matching the message text (the conservative legacy fallback is kept for
 *  transports/servers that carry no structured status). `undefined` for every
 *  non-HTTP error (stdio, timeout, local refusal). */
export class McpError extends QuantaError {
  /** R4 — the HTTP status this error carried, when the transport surfaced one
   *  structurally (`error.data.httpStatus`). `undefined` otherwise. */
  readonly httpStatus?: number
  constructor(message: string, options?: { cause?: unknown; httpStatus?: number }) {
    super("mcp", message, options)
    if (options?.httpStatus !== undefined) this.httpStatus = options.httpStatus
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
  /** §19.1 — server-advertised `ToolAnnotations` (spec 2025-06-18). UNTRUSTED —
   *  sanitized by {@link sanitizeAnnotations} so only real JSON booleans survive
   *  (a poisoned non-boolean is dropped, never coerced). */
  annotations?: unknown
}
interface ToolsListResult {
  tools?: RawTool[]
  nextCursor?: string
}
/** §19.3 — extended to carry the non-text content shapes (`image` data/mimeType,
 *  embedded `resource` blob/mimeType) the spec defines. Every field stays
 *  optional so a pure text block is byte-identical to the pre-§19.3 shape. */
interface ContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  resource?: unknown
}
interface ToolsCallResult {
  content?: ContentBlock[]
  isError?: boolean
  /** §19.2 — the spec's typed `structuredContent` payload (a JSON object whose
   *  shape the server's `outputSchema` describes). Carried opaque; the bridge
   *  maps it onto `ToolResult.structured`. Absent ⇒ unchanged text-only result. */
  structuredContent?: unknown
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

/** H18 / R2 #1 / R4 — does `err` represent a GENUINE HTTP 401 (Unauthorized)
 *  surfaced through the request core, as opposed to an arbitrary error whose
 *  text merely mentions "401" or "unauthorized"?
 *
 *  R4 (structured-401) — PREFER the STRUCTURED signal: an {@link McpError} that
 *  carries `httpStatus` (copied by `dispatch` from the transport's
 *  `error.data.httpStatus`) is auth-stale IFF that number is exactly `401`.
 *  This is immune to message-text spoofing entirely — a server whose 500-body
 *  text contains "HTTP 401" cannot trigger a re-auth because the structured
 *  status it carries is 500, not 401. A non-401 structured status (403/500/…)
 *  is DEFINITIVELY not auth-stale and short-circuits without consulting text.
 *
 *  FALLBACK (only when NO structured status is present — stdio carriers, or a
 *  transport that did not surface one): the conservative legacy substring match
 *  on the transport's own `HTTP 401` status marker. The ONLY non-structured way
 *  a real auth failure reaches here is the HTTP-SSE carrier's synthesized
 *  `transport POST failed: HTTP 401` message. We key off that token — NOT a bare
 *  `401` (which would spuriously fire on, e.g., `access-401.txt`, a line number,
 *  or a version string) and NOT a bare `unauthorized` (which would fire on any
 *  application-level authorization error a tool/server happens to phrase that
 *  way). Matching is bounded to the literal `HTTP 401` token (case-insensitive
 *  on `HTTP`, word-bounded on `401` so `HTTP 4012` / `HTTP 401x` never match). */
const isUnauthorizedError = (err: unknown): boolean => {
  // Structured signal wins when present: it is unforgeable by message text.
  if (err instanceof McpError && err.httpStatus !== undefined) {
    return err.httpStatus === 401
  }
  const msg = errMessage(err)
  return /\bHTTP\s+401\b/i.test(msg)
}

/** R4 (structured-401) — extract a numeric `httpStatus` from a JSON-RPC error's
 *  `data` slot when the transport attached one. Only a finite integer in the
 *  HTTP status range is accepted; anything else (absent, non-object, non-number,
 *  NaN, out-of-range) yields `undefined` so the conservative substring fallback
 *  applies. A hostile server cannot smuggle a non-401 into a 401 because we read
 *  the EXACT number, not its string form. */
const httpStatusOf = (data: unknown): number | undefined => {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined
  const raw = (data as Record<string, unknown>).httpStatus
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 100 || raw > 599) return undefined
  return raw
}

/** Narrow an unknown value to a plain record (object, not array/null). Used to
 *  safely walk the `initialize` response's nested `capabilities` slot. */
const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** §19.1 — lift ONE annotation field iff it arrived as a real JSON boolean. A
 *  poisoned non-boolean (`"true"`, `1`, `{}`, `null`) is DROPPED — never coerced
 *  — so a downstream `=== true` test on the result is always honest. */
const liftBoolHint = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined)

/** §19.1 — sanitize raw server-advertised annotations into the boolean-only
 *  {@link McpToolAnnotations}. Returns `undefined` when the input is not a plain
 *  object OR carries no usable field — so absent/garbage annotations stay absent
 *  (the bridge's predicates remain byte-identical to the pre-annotation path).
 *  The `title` is carried only as a display string (no security meaning). */
export const sanitizeAnnotations = (raw: unknown): McpToolAnnotations | undefined => {
  const obj = asRecord(raw)
  if (obj === null) return undefined
  const out: McpToolAnnotations = {}
  if (typeof obj.title === "string") out.title = obj.title
  const ro = liftBoolHint(obj.readOnlyHint)
  if (ro !== undefined) out.readOnlyHint = ro
  const de = liftBoolHint(obj.destructiveHint)
  if (de !== undefined) out.destructiveHint = de
  const id = liftBoolHint(obj.idempotentHint)
  if (id !== undefined) out.idempotentHint = id
  const ow = liftBoolHint(obj.openWorldHint)
  if (ow !== undefined) out.openWorldHint = ow
  return Object.keys(out).length === 0 ? undefined : out
}

const mapTool = (t: RawTool): McpToolDef => {
  const annotations = sanitizeAnnotations(t.annotations)
  return {
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object" },
    ...(annotations !== undefined ? { annotations } : {}),
  }
}

const joinTextBlocks = (content: ContentBlock[] | undefined): string =>
  (content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text ?? "")
    .join("\n")

/** §19.3 — extract non-text content blocks (image / embedded resource) into the
 *  typed {@link McpMediaBlock} carrier. Text blocks are left to
 *  {@link joinTextBlocks}.
 *
 *  - `image`: needs base64 `data` + a string `mimeType`.
 *  - `resource`: an embedded resource with a base64 `blob` + `mimeType` becomes
 *    a document-class block (a text resource is left to the text join — the
 *    server already exposes that via its content text where present).
 *
 *  Size enforcement (the 5 MB inbound cap + magic-byte sniff) lives in the
 *  BRIDGE where the `@/tool` image-cap policy is reachable — this stays a pure
 *  shape extractor (slice fence: `@/mcp` may not import `@/tool`). A block
 *  missing `data`/`mimeType` is SKIPPED rather than throwing, so a buggy or
 *  malicious server can never crash the call. */
export const extractMedia = (content: ContentBlock[] | undefined): McpMediaBlock[] => {
  const out: McpMediaBlock[] = []
  for (const b of content ?? []) {
    if (b.type === "image") {
      if (typeof b.data === "string" && typeof b.mimeType === "string") {
        out.push({ kind: "image", data: b.data, mimeType: b.mimeType })
      }
    } else if (b.type === "resource") {
      const r = asRecord(b.resource)
      if (r !== null && typeof r.blob === "string" && typeof r.mimeType === "string") {
        out.push({ kind: "resource", data: r.blob, mimeType: r.mimeType })
      }
    }
  }
  return out
}

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
const defaultTransportFor = (config: McpServerConfig, offeredVersion: string): McpTransport => {
  if (config.url !== undefined && config.url !== "") {
    return new HttpSseMcpTransport({
      url: config.url,
      name: config.name,
      // Ticket misc-jun-7/01 — stamp the OFFERED protocol version on the header
      // until negotiation pins the server-chosen one (client calls
      // `setProtocolVersion` after `initialize`).
      protocolVersion: offeredVersion,
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
    const t = opts?.transport
    // Bind the offered version into the DEFAULT factory so the HTTP carrier
    // stamps the same offer the `initialize` body carries. An INJECTED factory
    // (test double) keeps its single-arg `McpClientTransport` shape unchanged.
    const boundDefault = (cfg: McpServerConfig): McpTransport =>
      defaultTransportFor(cfg, this.offeredVersion)
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
        ((cfg: McpServerConfig) => defaultTransportFor(cfg, this.offeredVersion))
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
      const { result: initResult, offered } = await this.initializeWithDowngrade(transport)
      this.serverCapabilities = asRecord(initResult)?.capabilities
        ? (asRecord(asRecord(initResult)?.capabilities) ?? {})
        : {}
      // Read + accept/legacy-tolerant/fail-closed the server's chosen
      // protocolVersion (previously discarded), then pin the HTTP header to it.
      this.pinNegotiatedVersion(initResult, offered, transport)
    } catch (err) {
      await this.stop().catch(() => {})
      throw err
    }
    this.notify("notifications/initialized", {})
  }

  /** Ticket misc-jun-7/01 — issue `initialize` offering {@link offeredVersion};
   *  on a rejection from a STRICT server (a JSON-RPC error rather than a
   *  negotiated-down reply) AND only when the offer was newer than the floor,
   *  retry exactly ONCE at the floor ({@link PROTOCOL_DOWNGRADE_FLOOR}). The
   *  re-offer is bounded — a second failure (or a non-McpError, or an offer that
   *  was already the floor) propagates, never looping. The §5 worst case is one
   *  extra round-trip, then byte-identical.
   *
   *  Returns BOTH the raw result AND the version that ultimately succeeded on
   *  the wire, so the legacy-tolerant pin (server omits `protocolVersion`) uses
   *  the offer that actually connected — not the pre-downgrade offer.
   *
   *  The downgrade is offer-side only: a spec-compliant server that negotiates
   *  DOWN (returns the floor in a SUCCESSFUL reply) never enters the catch — it
   *  is handled by {@link pinNegotiatedVersion}'s accept branch. */
  private async initializeWithDowngrade(
    transport: McpTransport,
  ): Promise<{ result: unknown; offered: string }> {
    const offer = this.offeredVersion
    try {
      return { result: await this.sendInitialize(offer), offered: offer }
    } catch (err) {
      // Re-offer ONLY when the offered version was newer than the floor (so the
      // floor is a real downgrade) and the failure is a protocol error (any
      // McpError thrown by the request core — a strict server's -32602, a
      // synthesized transport error, etc.). A floor-level offer has nowhere to
      // downgrade to, so it propagates.
      if (offer === PROTOCOL_DOWNGRADE_FLOOR || !(err instanceof McpError)) throw err
      // Re-pin the transport header to the floor for the re-offer POST so the
      // header and body agree on the retry.
      transport.setProtocolVersion?.(PROTOCOL_DOWNGRADE_FLOOR)
      const result = await this.sendInitialize(PROTOCOL_DOWNGRADE_FLOOR)
      return { result, offered: PROTOCOL_DOWNGRADE_FLOOR }
    }
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

  /** Ticket misc-jun-7/01 — read the server's chosen `protocolVersion` from the
   *  `initialize` reply and decide:
   *   - ABSENT (legacy-tolerant) ⇒ pin the OFFERED version that connected
   *     (today's behavior, no regression). A malformed/non-string slot is
   *     treated as absent — routed around, never thrown on (§4.e).
   *   - IN the supported set ⇒ accept + pin it (this is what the HTTP header then
   *     carries on every subsequent request).
   *   - PRESENT but NOT in the set ⇒ fail closed with a typed `McpError` (Codex
   *     `UNSUPPORTED_PROTOCOL` parity). We never proceed on a version we do not
   *     implement. This is a PROTOCOL error ⇒ a throw, NOT an `isError` result. */
  private pinNegotiatedVersion(
    initResult: unknown,
    offered: string,
    transport: McpTransport,
  ): void {
    const replied = asRecord(initResult)?.protocolVersion
    if (typeof replied !== "string") {
      // Absent or malformed → legacy-tolerant: pin the offer that connected.
      this.negotiatedVersion = offered
      transport.setProtocolVersion?.(offered)
      return
    }
    if (!isSupportedProtocolVersion(replied)) {
      throw new McpError(
        `mcp server "${this.config.name}" replied with unsupported protocolVersion "${replied}"; supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
      )
    }
    this.negotiatedVersion = replied
    transport.setProtocolVersion?.(replied)
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
      entry.reject(
        new McpError(
          `mcp error ${msg.error.code}: ${msg.error.message}`,
          httpStatus !== undefined ? { httpStatus } : undefined,
        ),
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
