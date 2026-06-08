/**
 * `mcp/server.ts` — TICKET-19 reverse-MCP: quanta AS an MCP server.
 *
 * The INVERSE of {@link file://./client.ts}'s dispatcher. Where the client
 * SPEAKS outward to a server, {@link McpServer} LISTENS: it services inbound
 * JSON-RPC requests + notifications arriving on quanta's stdin and writes
 * replies back to stdout over the SHARED newline-delimited codec
 * ({@link file://./jsonrpc.ts} `encodeMessage` / `LineReader`). It owns its own
 * stdin/stdout pump — the `Stdio`/`HttpSse` transports are CLIENT-shaped
 * (spawn/connect outward) and are NOT reusable as a server listener.
 *
 * Security posture (this is an RCE surface — an external client calling our
 * `bash` would be remote code execution):
 *   - `tools/list` projects ONLY the whitelisted tools (read-only by default;
 *     see {@link file://./server-builder.ts}).
 *   - `tools/call` re-checks the whitelist BEFORE dispatch; a non-whitelisted
 *     name is `-32602` and the {@link ToolCallPort} is NEVER invoked.
 *   - The folded `toolCall` adapter at the composition root runs the FULL
 *     locked `dispatchTool` pipeline (permission / HARD_DENY / HITL / jail /
 *     redactSecrets), so even a force-opted-in mutating tool still hits the
 *     permission gate — it surfaces as `isError`, never a raw breakout.
 *
 * Slice fence: duck-typed injected ports only — NO `@/agent`, NO `@/tool`
 * import. The local {@link MAX_RESULT_CHARS} cap keeps the wire frame bounded
 * without reaching into `@/tool`'s output-spill constants.
 */

import { sliceWholeChars } from "@/shared"
import { encodeMessage, type JsonRpcMessage, type JsonRpcResponse, LineReader } from "./jsonrpc"
import { resolveOfferedVersion } from "./protocol-version"
import type { ServerToolSpec, ToolCallPort, ToolListSource } from "./server-builder"

/** LOCAL cap on a single `tools/call` text result. Kept local (NOT imported
 *  from `@/tool`) to honor the slice fence. A result past this is truncated
 *  with a visible marker so the client sees the truncation, not a silent cut. */
export const MAX_RESULT_CHARS = 1_000_000

/** Description prefix that marks every exposed tool as a quanta read-only
 *  surface in the client's tool picker (UX). */
const READONLY_PREFIX = "[quanta · read-only]"

/** JSON-RPC error codes (spec). */
const E_PARSE_PARAMS = -32602
const E_METHOD_NOT_FOUND = -32601
const E_INTERNAL = -32603

/** Ctor options for {@link McpServer}. Built by
 *  {@link file://./server-builder.ts}'s `buildMcpServer`, but exported so a test
 *  can construct the server directly with a fake whitelist. */
export interface McpServerCtorOptions {
  readonly toolList: ToolListSource
  readonly write: (line: string) => void
  /** The WHITELIST predicate (the security fence). `buildMcpServer` binds the
   *  frozen `read-only ∪ explicitOptIn` set here; a direct test caller may pass
   *  the raw read-only predicate. Consulted for BOTH `tools/list` projection
   *  AND the `tools/call` admit-check. */
  readonly readOnlyPolicy: (name: string) => boolean
  /** Folded REAL dispatch. Absent ⇒ every `tools/call` is `-32603`. */
  readonly toolCall?: ToolCallPort
  /** `tools/list` page size. */
  readonly pageSize?: number
  /** Operator override for the OFFERED protocol version (QUANTA_MCP_PROTOCOL_MAX).
   *  Resolved through the shared SSOT; absent ⇒ latest. */
  readonly protocolMax?: string
  /** serverInfo.version (default "0.1.0"). */
  readonly version?: string
}

/** A page cursor minted by the server: an opaque base64 of the next start
 *  index. We mint + validate it ourselves (never trust a client-supplied free
 *  string) so a bogus cursor is a clean `-32602`, not an out-of-range slice. */
const CURSOR_PREFIX = "quanta-mcp:"

export class McpServer {
  private readonly toolList: ToolListSource
  private readonly write: (line: string) => void
  private readonly isWhitelisted: (name: string) => boolean
  private readonly toolCall: ToolCallPort | undefined
  private readonly pageSize: number
  private readonly protocolMax: string | undefined
  private readonly version: string
  private readonly reader = new LineReader()
  /** In-flight `tools/call` dispatches. The pump fires each call async (a slow
   *  tool must not block decoding the next frame), so the composition root must
   *  {@link drain} these before exit — otherwise an async tool effect (e.g. an
   *  FS write) could land AFTER the command returned, dropping the reply and
   *  hiding the effect from any post-run assertion. */
  private readonly inflight = new Set<Promise<void>>()

  constructor(opts: McpServerCtorOptions) {
    this.toolList = opts.toolList
    this.write = opts.write
    this.isWhitelisted = opts.readOnlyPolicy
    this.toolCall = opts.toolCall
    this.pageSize = opts.pageSize ?? 50
    this.protocolMax = opts.protocolMax
    this.version = opts.version ?? "0.1.0"
  }

  /** The names this server exposes — the whitelist, materialized for the start
   *  banner + the builder's unit assertions. Stable registry order. */
  exposedToolNames(): string[] {
    return this.toolList
      .specs()
      .map((s) => s.name)
      .filter((n) => this.isWhitelisted(n))
  }

  /** Push raw stdin bytes (or a string line) into the pump. The {@link
   *  LineReader} buffers partial reads + splits coalesced flushes; each fully
   *  framed inbound message is routed through {@link handle}. NEVER throws — a
   *  routing fault is caught and (when the message carried an id) answered with
   *  `-32603`. */
  feed(chunk: Uint8Array | string): void {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
    for (const msg of this.reader.push(bytes)) this.handle(msg)
  }

  /** Convenience for the composition root's stdin pump. */
  get lineReader(): LineReader {
    return this.reader
  }

  /** Inbound dispatcher — the INVERSE of `McpClient.dispatch`. Only inbound
   *  REQUESTS (have a `method`, and an `id` ⇒ a reply obligation) and
   *  NOTIFICATIONS (a `method` without an `id`) are expected; a stray response
   *  (no `method`) is ignored. */
  private handle(msg: JsonRpcMessage): void {
    if (!("method" in msg)) return // a response — we never sent a request; drop.
    const method = msg.method
    const params = "params" in msg ? msg.params : undefined
    const id = "id" in msg ? msg.id : undefined
    try {
      this.route(id, method, params)
    } catch {
      // NO-THROW pump: a routing fault never escapes; answer if there's an id.
      if (id !== undefined) this.sendError(id, E_INTERNAL, "internal error")
    }
  }

  private route(id: number | string | undefined, method: string, params: unknown): void {
    if (method === "initialize") {
      if (id !== undefined) this.sendResult(id, this.initializeResult())
      return
    }
    // `notifications/initialized` (and any other notification) ⇒ no reply.
    if (method === "notifications/initialized") return
    if (method === "tools/list") {
      if (id !== undefined) this.handleToolsList(id, params)
      return
    }
    if (method === "tools/call") {
      if (id !== undefined) this.handleToolsCall(id, params)
      return
    }
    // Unknown method — answer requests with -32601; ignore unknown notifications.
    if (id !== undefined) this.sendError(id, E_METHOD_NOT_FOUND, `method not found: ${method}`)
  }

  private initializeResult(): Record<string, unknown> {
    return {
      protocolVersion: resolveOfferedVersion(this.protocolMax),
      serverInfo: { name: "quanta", version: this.version },
      capabilities: { tools: { listChanged: false } },
    }
  }

  /** `tools/list` — project the whitelist into MCP tool defs, paginated. The
   *  cursor is server-minted + validated (never a client free string), and the
   *  page window is bounded so a bogus cursor is `-32602`, not a bad slice. */
  private handleToolsList(id: number | string, params: unknown): void {
    const all = this.toolList.specs().filter((s) => this.isWhitelisted(s.name))
    const start = this.parseCursor(params)
    if (start === null) {
      this.sendError(id, E_PARSE_PARAMS, "tools/list: invalid or stale cursor")
      return
    }
    const page = all.slice(start, start + this.pageSize)
    const tools = page.map((s) => this.toMcpToolDef(s))
    const nextStart = start + this.pageSize
    const result: { tools: unknown[]; nextCursor?: string } =
      nextStart < all.length ? { tools, nextCursor: this.mintCursor(nextStart) } : { tools }
    this.sendResult(id, result)
  }

  /** Decode a client-supplied cursor to a start index. No cursor ⇒ start 0. A
   *  malformed / out-of-range cursor ⇒ `null` (caller maps to -32602). This is
   *  the loop guard: a cursor can only ever decode to a forward index we minted,
   *  and an index past the list is rejected, so a client cannot drive an
   *  infinite re-page. */
  private parseCursor(params: unknown): number | null {
    if (typeof params !== "object" || params === null) return 0
    const raw = (params as Record<string, unknown>)["cursor"]
    if (raw === undefined) return 0
    if (typeof raw !== "string" || !raw.startsWith(CURSOR_PREFIX)) return null
    const n = Number.parseInt(raw.slice(CURSOR_PREFIX.length), 10)
    if (!Number.isInteger(n) || n <= 0) return null
    // An index at/over the total is stale (we never mint a terminal cursor).
    const total = this.toolList.specs().filter((s) => this.isWhitelisted(s.name)).length
    if (n >= total) return null
    return n
  }

  private mintCursor(start: number): string {
    return `${CURSOR_PREFIX}${start}`
  }

  private toMcpToolDef(spec: ServerToolSpec): Record<string, unknown> {
    return {
      name: spec.name,
      // UX: mark the surface read-only + carry the original description.
      description: `${READONLY_PREFIX} ${spec.description}`,
      inputSchema: spec.input_schema,
    }
  }

  /** `tools/call` — validate params, re-check the whitelist (the dispatch
   *  fence), then fold the REAL dispatch to text. A non-whitelisted name is
   *  `-32602` and {@link toolCall} is NEVER reached. */
  private handleToolsCall(id: number | string, params: unknown): void {
    const parsed = this.parseCallParams(params)
    if (parsed === null) {
      this.sendError(
        id,
        E_PARSE_PARAMS,
        "tools/call: params must be { name: string, arguments?: object }",
      )
      return
    }
    if (!this.isWhitelisted(parsed.name)) {
      // RCE fence: name WHY + remediation. The risk class explains the default.
      const risk = this.toolList.readOnly(parsed.name) ? "read-only" : "mutating"
      this.sendError(
        id,
        E_PARSE_PARAMS,
        `tool not exposed: ${parsed.name} is ${risk}-risk; only read-only tools are exposed by default — opt in per-tool via QUANTA_MCP_SERVER_EXPOSE`,
      )
      return
    }
    if (this.toolCall === undefined) {
      this.sendError(id, E_INTERNAL, "tools/call: no dispatcher wired")
      return
    }
    // Fire the async dispatch; map its outcome (or any throw) to a reply. The
    // `.then(..., ...)` rejection arm is the no-throw guard — a buggy adapter
    // becomes -32603, never an unhandled rejection that wedges the pump. The
    // promise is TRACKED so {@link drain} can await it on shutdown (an FS effect
    // must settle before the command returns — see {@link inflight}).
    const pending = this.toolCall(parsed.name, parsed.args).then(
      (out) => this.sendCallResult(id, out),
      () => this.sendError(id, E_INTERNAL, "tool dispatch failed"),
    )
    this.inflight.add(pending)
    void pending.finally(() => this.inflight.delete(pending))
  }

  /** Await every in-flight `tools/call` dispatch. The composition root calls
   *  this after stdin EOF (and on SIGINT) so every reply is flushed and every
   *  tool effect has settled before the process exits. Looped because a settling
   *  dispatch could (in principle) enqueue another; converges once the set
   *  empties. NEVER throws — rejections are already folded to `-32603` replies in
   *  {@link handleToolsCall}, so `allSettled` simply drains them. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight])
    }
  }

  /** Validate `{ name: string, arguments?: object }`. Returns null on any
   *  violation so the caller maps to -32602. */
  private parseCallParams(params: unknown): { name: string; args: unknown } | null {
    if (typeof params !== "object" || params === null) return null
    const p = params as Record<string, unknown>
    const name = p["name"]
    if (typeof name !== "string" || name.length === 0) return null
    const args = p["arguments"]
    // `arguments` is optional; when present it must be an object (not array/scalar).
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      return null
    }
    return { name, args: args ?? {} }
  }

  /** Fold a `{ text, isError }` dispatch outcome to an MCP `tools/call` result,
   *  truncating an oversized text to {@link MAX_RESULT_CHARS} with a marker. */
  private sendCallResult(id: number | string, out: { text: string; isError: boolean }): void {
    const text =
      out.text.length > MAX_RESULT_CHARS
        ? `${sliceWholeChars(out.text, MAX_RESULT_CHARS)}\n…[truncated ${out.text.length - MAX_RESULT_CHARS} chars]`
        : out.text
    this.sendResult(id, { content: [{ type: "text", text }], isError: out.isError })
  }

  private sendResult(id: number | string, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result })
  }

  private sendError(id: number | string, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } })
  }

  /** Serialize + write one framed line via the injected `write`. NEVER throws —
   *  a write fault is swallowed (the pump must survive a broken stdout). */
  private send(payload: JsonRpcResponse): void {
    try {
      this.write(new TextDecoder().decode(encodeMessage(payload)))
    } catch {
      // stdout broke — nothing more we can do; do not crash the pump.
    }
  }
}
