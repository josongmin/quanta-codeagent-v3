/** Streamable-HTTP (+ SSE) transport for the MCP client (ADR-0391).
 *
 *  Implements the MCP "Streamable HTTP" transport (spec rev 2025-03-26): the
 *  client communicates with a single server endpoint URL.
 *
 *   - Outbound: every JSON-RPC message is sent as an HTTP `POST` with
 *     `Content-Type: application/json` and
 *     `Accept: application/json, text/event-stream`. The server MAY answer a
 *     POST with either a single `application/json` body (one response) OR a
 *     `text/event-stream` (an SSE stream carrying the response and any related
 *     server messages). Notifications/requests with no reply get `202 Accepted`
 *     and an empty body.
 *   - Inbound (server-initiated): the client opens a standalone `GET` to the
 *     same endpoint with `Accept: text/event-stream`; the server MAY keep this
 *     open as an SSE channel for messages that aren't tied to a client POST.
 *   - Session: if the server returns an `Mcp-Session-Id` header on the
 *     initialize response, the client echoes it on every subsequent request
 *     (and on `DELETE` at close to end the session).
 *
 *  Framing: SSE `data:` lines carry one JSON-RPC message each (the MCP wire
 *  format reuses `../jsonrpc.ts` envelopes). Decoding lives here, behind the
 *  {@link McpTransport} port, so the client core stays carrier-agnostic.
 *
 *  This transport is OPT-IN: the client defaults to stdio, so existing
 *  deployments are byte-identical. */

import { logger } from "@/shared"
import { isResponse, type JsonRpcMessage } from "../jsonrpc"
import type {
  McpTransport,
  McpTransportExitHandler,
  McpTransportMessageHandler,
  McpTransportPayload,
} from "./port"

const PROTOCOL_VERSION = "2025-06-18"
const SESSION_HEADER = "mcp-session-id"

/** Minimal fetch shape so the transport can be driven without a network in
 *  tests. Matches the relevant subset of the WHATWG `fetch` signature. */
export type HttpFetchFn = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<HttpFetchResponse>

/** Subset of `Response` the transport consumes. */
export interface HttpFetchResponse {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  text(): Promise<string>
  /** Web ReadableStream of UTF-8 bytes, or null (e.g. 202 with no body). */
  readonly body: ReadableStream<Uint8Array> | null
}

export interface HttpSseTransportOpts {
  /** Server endpoint URL (the single MCP Streamable-HTTP endpoint). */
  readonly url: string
  /** Logical server name for diagnostics. */
  readonly name: string
  /** Static headers merged into every request (e.g. `Authorization`). */
  readonly headers?: Record<string, string>
  /** Open the standalone GET SSE channel for server-initiated messages.
   *  Default `true`. Servers that don't support it answer `405` and the
   *  client silently proceeds POST-only. */
  readonly openServerStream?: boolean
  /** `fetch` seam (test injection). Default = global `fetch`. */
  readonly fetch?: HttpFetchFn
}

/** Parse one SSE event block's accumulated `data:` lines into text. SSE allows
 *  multiple `data:` fields per event, joined by `\n`. */
const sseDataFromBlock = (block: string): string | null => {
  const lines = block.split("\n")
  const data: string[] = []
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""))
    }
    // `event:`, `id:`, `:`(comment), and blanks are ignored — we only need data.
  }
  return data.length === 0 ? null : data.join("\n")
}

/** Streamable-HTTP transport. */
export class HttpSseMcpTransport implements McpTransport {
  private readonly url: string
  private readonly name: string
  private readonly staticHeaders: Record<string, string>
  private readonly openServerStream: boolean
  private readonly fetchFn: HttpFetchFn

  private readonly messageHandlers = new Set<McpTransportMessageHandler>()
  private readonly exitHandlers = new Set<McpTransportExitHandler>()
  private readonly decoder = new TextDecoder()

  private sessionId: string | null = null
  private started = false
  private closed = false
  private exitFired = false
  private serverStreamAbort: AbortController | null = null
  private serverStreamPump: Promise<void> | null = null

  constructor(opts: HttpSseTransportOpts) {
    this.url = opts.url
    this.name = opts.name
    this.staticHeaders = { ...(opts.headers ?? {}) }
    this.openServerStream = opts.openServerStream ?? true
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as HttpFetchFn)
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    if (this.openServerStream) this.serverStreamPump = this.openStandaloneStream()
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

  /** POST is async, but the {@link McpTransport.send} contract is sync (returns
   *  an immediate enqueue error or null). We launch the POST in the background
   *  and surface inbound messages via `onMessage`; a POST-level failure is
   *  reported by re-routing it through the message pump as a transport-level
   *  problem (logged) — the client's per-request timeout is the backstop. */
  send(payload: McpTransportPayload): Error | null {
    if (this.closed) {
      return new Error(`mcp server "${this.name}" transport unavailable: closed`)
    }
    void this.post(payload).catch((e) => {
      logger.warn("mcp: http POST failed", { server: this.name, error: String(e) })
    })
    return null
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.serverStreamAbort?.abort()
    // Best-effort DELETE to end the server session, if one was assigned.
    if (this.sessionId !== null) {
      try {
        await this.fetchFn(this.url, {
          method: "DELETE",
          headers: this.requestHeaders({}),
        })
      } catch (e) {
        logger.debug("mcp: http session DELETE failed", { server: this.name, error: String(e) })
      }
    }
    await this.serverStreamPump?.catch(() => undefined)
    this.fireExit(`mcp server "${this.name}" closed`)
  }

  // --- internals -----------------------------------------------------------

  private requestHeaders(extra: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...this.staticHeaders,
      ...extra,
    }
    if (this.sessionId !== null) headers[SESSION_HEADER] = this.sessionId
    return headers
  }

  private async post(payload: McpTransportPayload): Promise<void> {
    const res = await this.fetchFn(this.url, {
      method: "POST",
      headers: this.requestHeaders({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      }),
      body: JSON.stringify(payload),
    })

    // Capture a server-assigned session id (typically on the initialize reply).
    const assigned = res.headers.get(SESSION_HEADER)
    if (assigned !== null && assigned !== "" && this.sessionId === null) {
      this.sessionId = assigned
    }

    if (!res.ok) {
      logger.warn("mcp: http POST non-2xx", { server: this.name, status: res.status })
      return
    }

    // 202 Accepted (notification / fire-and-forget) → no body to consume.
    if (res.status === 202) return

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase()
    if (contentType.includes("text/event-stream")) {
      await this.consumeSseBody(res.body)
      return
    }
    // Single JSON response.
    const text = await res.text()
    if (text.trim().length === 0) return
    this.decodeAndEmit(text)
  }

  private async openStandaloneStream(): Promise<void> {
    const abort = new AbortController()
    this.serverStreamAbort = abort
    let res: HttpFetchResponse
    try {
      res = await this.fetchFn(this.url, {
        method: "GET",
        headers: this.requestHeaders({ accept: "text/event-stream" }),
        signal: abort.signal,
      })
    } catch (e) {
      // Network error opening the channel — proceed POST-only.
      logger.debug("mcp: standalone SSE GET failed", { server: this.name, error: String(e) })
      return
    }
    // 405 = server has no standalone stream; that's spec-legal, proceed.
    if (!res.ok || res.status === 405) return
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase()
    if (!contentType.includes("text/event-stream")) return
    await this.consumeSseBody(res.body)
  }

  /** Read an SSE byte stream, splitting on blank-line event boundaries and
   *  emitting each event's `data:` payload as a decoded JSON-RPC message. */
  private async consumeSseBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
    if (body === null) return
    const reader = body.getReader()
    let buffer = ""
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value !== undefined) buffer += this.decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf("\n\n")
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = sseDataFromBlock(block)
          if (data !== null) this.decodeAndEmit(data)
          boundary = buffer.indexOf("\n\n")
        }
      }
      // Flush a trailing event with no terminating blank line.
      const data = sseDataFromBlock(buffer)
      if (data !== null) this.decodeAndEmit(data)
    } catch (e) {
      logger.debug("mcp: SSE stream ended", { server: this.name, error: String(e) })
    } finally {
      reader.releaseLock?.()
    }
  }

  /** Parse one JSON-RPC line and emit it. A response or notification that
   *  passes the envelope shape reaches the handlers; junk is dropped (mirrors
   *  the stdio `LineReader` tolerance). */
  private decodeAndEmit(text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      logger.warn("mcp: skipping malformed http JSON-RPC payload", {
        server: this.name,
        payload: text.slice(0, 200),
      })
      return
    }
    if (!isValidEnvelope(parsed)) {
      logger.warn("mcp: skipping non-jsonrpc http payload", {
        server: this.name,
        payload: text.slice(0, 200),
      })
      return
    }
    this.emitMessage(parsed)
  }

  private emitMessage(msg: JsonRpcMessage): void {
    for (const handler of [...this.messageHandlers]) {
      try {
        handler(msg)
      } catch {
        // A failing handler must not poison sibling subscribers.
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

/** Strict JSON-RPC 2.0 envelope check, mirroring `../jsonrpc.ts` `LineReader`.
 *  Duplicated locally (not exported from jsonrpc) so the HTTP path applies the
 *  same fail-closed discipline a hostile server would otherwise bypass. */
const isValidEnvelope = (m: unknown): m is JsonRpcMessage => {
  if (typeof m !== "object" || m === null) return false
  const o = m as Record<string, unknown>
  if (o["jsonrpc"] !== "2.0") return false
  const hasId = "id" in o
  const hasMethod = "method" in o
  if (!hasId && !hasMethod) return false
  if (hasId) {
    const id = o["id"]
    if (typeof id !== "string" && typeof id !== "number") return false
  }
  if (hasMethod && typeof o["method"] !== "string") return false
  return true
}

/** Re-export so callers can narrow inbound HTTP messages with the same helper
 *  the stdio path uses. Kept here to avoid a second import site in wire code. */
export const isHttpResponse = isResponse
