/** Streamable-HTTP (+ SSE) transport for the MCP client (ADR-0391).
 *
 *  Implements the MCP "Streamable HTTP" transport: the client communicates with
 *  a single server endpoint URL. The `mcp-protocol-version` header is negotiated
 *  per session (ticket misc-jun-7/01) — it carries the OFFERED version on the
 *  `initialize` POST and the SERVER-PINNED version on every request thereafter.
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

import { errMessage, logger, throwIfAborted } from "@/shared"
import { isResponse, type JsonRpcMessage } from "../jsonrpc"
import { LATEST_PROTOCOL_VERSION } from "../protocol-version"
import type {
  McpTransport,
  McpTransportExitHandler,
  McpTransportMessageHandler,
  McpTransportPayload,
} from "./port"

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
  /** Ticket misc-jun-7/01 — the protocol version to stamp on the
   *  `mcp-protocol-version` header UNTIL negotiation pins one. This is the
   *  OFFERED version (knob-resolved by the client). Omitting it defaults to
   *  {@link LATEST_PROTOCOL_VERSION}; the client always supplies the resolved
   *  offer so the header on the `initialize` POST matches the offered body. */
  readonly protocolVersion?: string
  /** §1.2 resumption — seed the last-seen SSE event id so the standalone GET
   *  sends `Last-Event-ID` on connect (the reconnect supervisor passes the dead
   *  transport's `getLastEventId()` here when it mints the replacement). Absent
   *  ⇒ no header (byte-identical fresh connect). */
  readonly resumeFromEventId?: string
}

/** Parse one SSE event block into its `data` text + the event `id` (§1.2
 *  resumption). SSE allows multiple `data:` fields per event (joined by `\n`);
 *  the LAST `id:` field in the block is the event id (WHATWG SSE §9.2.4). A
 *  block may carry an id with no data (a bare cursor advance) — `data` is then
 *  `null` but `id` still surfaces. `event:` / `:`(comment) / blanks are ignored.
 *  Exported for the resumption hellgate. */
export const sseDataFromBlock = (block: string): { data: string | null; id: string | null } => {
  const lines = block.split("\n")
  const data: string[] = []
  let id: string | null = null
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""))
    } else if (line.startsWith("id:")) {
      // Audit R1#3 + R2#1 — an EMPTY or ALL-WHITESPACE id field (`id:` / `id: ` /
      // `id:  ` / `id:\t`) resets the last-event-id per WHATWG SSE §9.2.4; for
      // resumption a blank cursor is useless and must NOT become a malformed
      // `Last-Event-ID: ` header, so coerce blank → null (`.trim()` catches the
      // multi-space / tab cases the single-space strip misses).
      const v = line.slice(3).replace(/^ /, "")
      id = v.trim().length > 0 ? v : null
    }
  }
  return { data: data.length === 0 ? null : data.join("\n"), id }
}

/** How an SSE pump settled (jun-10 silent-failure audit #4). `aborted` is the
 *  DELIBERATE arm (close() severed the signal); `ended` is a clean stream end
 *  with no throw; `failed` carries the mid-pump error. Callers decide the
 *  escalation: a standalone-channel `ended`/`failed` while the transport is
 *  alive is a DEATH (fireExit so the ADR-0435 supervisor restarts with the
 *  §1.2 `resumeFromEventId` cursor); a POST-body `failed` rejects its pending
 *  entry promptly instead of letting it wait out the per-request timeout. */
interface SsePumpOutcome {
  readonly outcome: "ended" | "aborted" | "failed"
  readonly error?: string
}

/** Pull the JSON-RPC `id` off an outbound payload, if any. A request carries a
 *  string/number `id` and has a pending entry to reject on failure; a
 *  notification has none, so returns `undefined`. */
const extractRequestId = (payload: unknown): number | string | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined
  const id = (payload as { id?: unknown }).id
  return typeof id === "number" || typeof id === "string" ? id : undefined
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
  /** Ticket misc-jun-7/01 — the protocol version stamped on the
   *  `mcp-protocol-version` header. Starts at the OFFERED version; the client
   *  re-pins it to the SERVER-CHOSEN version via {@link setProtocolVersion}
   *  once the `initialize` reply is accepted. */
  private protocolVersion: string
  /** §1.2 — last SSE event id seen (or the resume seed). Sent as `Last-Event-ID`
   *  on the standalone GET so a server replays from after it. */
  private lastEventId: string | null
  private started = false
  private closed = false
  private exitFired = false
  private serverStreamAbort: AbortController | null = null
  private serverStreamPump: Promise<void> | null = null
  /** T01 (audit L9 H12): every in-flight POST (and the SSE reader it may be
   *  draining) is tracked here so `close()` can abort them together — a hung
   *  POST that the server answers with an unbounded SSE body previously leaked
   *  its socket + reader past `close()`. */
  private readonly inFlightPosts = new Set<AbortController>()

  constructor(opts: HttpSseTransportOpts) {
    this.url = opts.url
    this.name = opts.name
    this.staticHeaders = { ...(opts.headers ?? {}) }
    this.openServerStream = opts.openServerStream ?? true
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as HttpFetchFn)
    this.protocolVersion = opts.protocolVersion ?? LATEST_PROTOCOL_VERSION
    this.lastEventId = opts.resumeFromEventId ?? null
  }

  /** §1.2 — the last SSE event id seen on the server stream (or the resume
   *  seed). The reconnect supervisor reads this off a dying transport and passes
   *  it as `resumeFromEventId` to the replacement so the server replays missed
   *  events. `null` when no id-tagged event was seen. */
  getLastEventId(): string | null {
    return this.lastEventId
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

  /** Ticket misc-jun-7/01 — re-pin the `mcp-protocol-version` header to the
   *  SERVER-CHOSEN version after the client accepts the `initialize` reply.
   *  Before this is called the header carries the offered version (set at
   *  construction), so the `initialize` POST itself is self-consistent. */
  setProtocolVersion(version: string): void {
    this.protocolVersion = version
  }

  /** POST is async, but the {@link McpTransport.send} contract is sync (returns
   *  an immediate enqueue error or null). We launch the POST in the background
   *  and surface inbound messages via `onMessage`.
   *
   *  A connection-level POST failure (the `fetch` itself rejects — DNS, refused,
   *  reset) used to drop to a warn log, so a request payload (one carrying an
   *  `id`) would hang the client's pending entry for the FULL per-request
   *  timeout before failing. We now correlate the failure back to the request
   *  `id` and synthesize a JSON-RPC error response routed through the same
   *  message pump `onMessage` feeds — the client's `dispatch` rejects the
   *  pending request PROMPTLY instead of waiting out the timeout. A notification
   *  (no `id`) has no pending entry to reject, so it stays a warn. */
  send(payload: McpTransportPayload): Error | null {
    if (this.closed) {
      return new Error(`mcp server "${this.name}" transport unavailable: closed`)
    }
    const requestId = extractRequestId(payload)
    void this.post(payload, requestId).catch((e) => {
      const detail = errMessage(e)
      logger.warn("mcp: http POST failed", { server: this.name, error: detail })
      // Correlated prompt-fail: a connection-level failure on a REQUEST rejects
      // its pending entry now, not at timeout. Synthesize the wire error the
      // server would have returned so the client's existing error path runs.
      if (requestId !== undefined) {
        this.rejectPending(requestId, `transport POST failed: ${detail}`)
      }
    })
    return null
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.serverStreamAbort?.abort()
    // T01 (audit L9 H12): abort every in-flight POST + its SSE reader so no
    // socket/stream survives close. `consumeSseBody` is wired to these signals,
    // so the reader is cancelled (pipe released), not merely abandoned.
    for (const ctrl of [...this.inFlightPosts]) ctrl.abort()
    this.inFlightPosts.clear()
    // Best-effort DELETE to end the server session, if one was assigned.
    if (this.sessionId !== null) {
      try {
        await this.fetchFn(this.url, {
          method: "DELETE",
          headers: this.requestHeaders({}),
        })
      } catch (e) {
        logger.debug("mcp: http session DELETE failed", { server: this.name, error: errMessage(e) })
      }
    }
    await this.serverStreamPump?.catch(() => undefined)
    this.fireExit(`mcp server "${this.name}" closed`)
  }

  // --- internals -----------------------------------------------------------

  private requestHeaders(extra: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "mcp-protocol-version": this.protocolVersion,
      ...this.staticHeaders,
      ...extra,
    }
    if (this.sessionId !== null) headers[SESSION_HEADER] = this.sessionId
    return headers
  }

  /** Synthesize the JSON-RPC error envelope the server would have returned and
   *  route it through the same pump `onMessage` feeds, so the client's pending
   *  entry for `requestId` rejects PROMPTLY (not at per-request timeout). Both
   *  the connection-level POST failure and the HTTP non-2xx path use this so the
   *  two siblings emit an identical wire shape (id + code -32000).
   *
   *  R4 (structured-401) — on the HTTP non-2xx path the REAL numeric status is
   *  known, so we attach it to `error.data.httpStatus`. The client's `dispatch`
   *  copies that onto the typed `McpError.httpStatus`, letting auth-staleness key
   *  off a STRUCTURED signal instead of substring-matching the message. The
   *  message text is UNCHANGED (the `HTTP <status>` marker is still present), so
   *  the legacy substring fallback — and every existing assertion on the message
   *  — is byte-identical. Connection-level failures (no HTTP status) omit it. */
  private rejectPending(requestId: number | string, message: string, httpStatus?: number): void {
    this.emitMessage({
      jsonrpc: "2.0",
      id: requestId,
      error: {
        code: -32000,
        message,
        ...(httpStatus !== undefined ? { data: { httpStatus } } : {}),
      },
    })
  }

  private async post(payload: McpTransportPayload, requestId?: number | string): Promise<void> {
    // T01 (audit L9 H12): each POST gets a tracked AbortController so `close()`
    // can sever the request + any SSE body it is draining. The signal is wired
    // into both the fetch AND `consumeSseBody`'s reader.
    const ctrl = new AbortController()
    this.inFlightPosts.add(ctrl)
    try {
      const res = await this.fetchFn(this.url, {
        method: "POST",
        headers: this.requestHeaders({
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        }),
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      })

      // Capture a server-assigned session id (typically on the initialize reply).
      const assigned = res.headers.get(SESSION_HEADER)
      if (assigned !== null && assigned !== "" && this.sessionId === null) {
        this.sessionId = assigned
      }

      if (!res.ok) {
        logger.warn("mcp: http POST non-2xx", { server: this.name, status: res.status })
        // Sibling of the connection-level fast-fail: a server HTTP non-2xx
        // (e.g. 500) to a REQUEST-bearing POST has no response body to deliver
        // the awaited reply, so the pending entry would otherwise wait the FULL
        // per-request timeout. Synthesize the SAME JSON-RPC error envelope the
        // send() .catch() builds (id + code -32000, message incl the HTTP
        // status) so the client's existing error path rejects it PROMPTLY. A
        // notification (no id) has no pending entry, so it stays a warn.
        if (requestId !== undefined) {
          // R4 — carry the REAL status structurally so the client keys off the
          // number, not the message text. The message marker is unchanged.
          this.rejectPending(requestId, `transport POST failed: HTTP ${res.status}`, res.status)
        }
        // Drain/discard the body so the socket can be released rather than left
        // half-read behind an error response.
        await this.drainBody(res.body)
        return
      }

      // 202 Accepted (notification / fire-and-forget) → no body to consume.
      if (res.status === 202) return

      const contentType = (res.headers.get("content-type") ?? "").toLowerCase()
      if (contentType.includes("text/event-stream")) {
        const pump = await this.consumeSseBody(res.body, ctrl.signal)
        // Audit jun-10 #4 (POST arm): the SSE body carrying the awaited reply
        // died MID-STREAM. Without this, the pending entry waits out the FULL
        // per-request timeout — reject it promptly via the same synthesized
        // envelope the other fast-fail siblings use. `rejectPending` is a
        // no-op at the client if the reply already landed before the death
        // (takePending finds nothing), so a post-reply death is harmless. A
        // clean `ended` is this stream's NORMAL termination, so it stays quiet.
        if (pump.outcome === "failed" && !this.closed) {
          logger.warn("mcp: http POST SSE stream failed", {
            server: this.name,
            error: pump.error,
          })
          if (requestId !== undefined) {
            this.rejectPending(requestId, `transport POST SSE stream failed: ${pump.error}`)
          }
        }
        return
      }
      // Single JSON response.
      const text = await res.text()
      if (text.trim().length === 0) return
      this.decodeAndEmit(text)
    } finally {
      this.inFlightPosts.delete(ctrl)
    }
  }

  private async openStandaloneStream(isResumeRetry = false): Promise<void> {
    const abort = new AbortController()
    this.serverStreamAbort = abort
    // If close() already fired (the standalone GET races a fast teardown), the
    // controller is aborted up front so the fetch is severed and we never begin
    // draining a body the transport no longer owns.
    if (this.closed) abort.abort()
    let res: HttpFetchResponse
    try {
      const handshake = this.fetchFn(this.url, {
        method: "GET",
        // §1.2 — resume from the last seen event id when we have one (the WHATWG
        // SSE reconnect header); absent ⇒ no header (byte-identical fresh GET).
        headers: this.requestHeaders({
          accept: "text/event-stream",
          ...(this.lastEventId !== null ? { "Last-Event-ID": this.lastEventId } : {}),
        }),
        signal: abort.signal,
      })
      // Race the handshake against abort. A fetch impl that ignores the signal
      // must not keep this pump pending past close() (close() awaits it) nor let
      // us open a reader on a torn-down transport (audit L9 H12).
      res = await Promise.race([
        handshake,
        new Promise<HttpFetchResponse>((_, reject) => {
          if (abort.signal.aborted) {
            reject(new Error("standalone GET aborted"))
            return
          }
          abort.signal.addEventListener(
            "abort",
            () => reject(new Error("standalone GET aborted")),
            {
              once: true,
            },
          )
        }),
      ])
    } catch (e) {
      // close() aborting the in-flight handshake is DELIBERATE teardown — keep
      // it at debug and let the pump settle so close() never wedges.
      if (this.closed || abort.signal.aborted) {
        logger.debug("mcp: standalone SSE GET aborted by close", {
          server: this.name,
          error: errMessage(e),
        })
        return
      }
      // Audit jun-10 #11 — a REAL network failure opening the channel used to
      // be conflated with the close()-abort above and silently degrade the
      // whole session to POST-only. The server→client channel is the
      // transport's contract: surface the death so the ADR-0435 supervisor can
      // restart (the replacement re-opens the GET, resuming via §1.2
      // `Last-Event-ID`). Without a supervisor the client fails pending
      // promptly instead of half-living on a one-way wire.
      logger.warn("mcp: standalone SSE GET failed", { server: this.name, error: errMessage(e) })
      this.fireExit(`mcp server "${this.name}" standalone SSE GET failed: ${errMessage(e)}`)
      return
    }
    // 405 = server has no standalone stream; that's spec-legal, proceed.
    if (!res.ok) {
      // §1.2 — a NON-405 failure WHILE CARRYING a resume cursor may mean the id
      // is unknown/expired (the server restarted with a fresh session, or the id
      // aged out). Drop the stale cursor + retry the GET exactly ONCE without
      // `Last-Event-ID` so a bad cursor can't wedge the server stream. The
      // `isResumeRetry` guard makes this strictly one extra attempt — no loop.
      if (
        !isResumeRetry &&
        !this.closed && // Audit R1 #6 — never start the retry on a torn-down transport.
        res.status !== 405 &&
        this.lastEventId !== null
      ) {
        logger.info("mcp: SSE resume reset (cursor rejected on reconnect)", {
          server: this.name,
          status: res.status,
          staleEventId: this.lastEventId,
        })
        this.lastEventId = null
        return this.openStandaloneStream(true)
      }
      return
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase()
    if (!contentType.includes("text/event-stream")) return
    // close() may have fired while the GET handshake was in flight — don't open
    // a reader on a torn-down transport (the abort already fired; this is the
    // belt-and-braces guard so the standalone-GET lifetime is owned exactly as
    // tightly as the POST lifetime).
    try {
      throwIfAborted(abort.signal)
    } catch {
      return
    }
    const pump = await this.consumeSseBody(res.body, abort.signal)
    if (pump.outcome === "aborted" || this.closed) {
      // Deliberate close()-teardown — close() itself fires the quiet exit.
      logger.debug("mcp: standalone SSE stream closed", { server: this.name })
      return
    }
    // Audit jun-10 #4 (+ the clean-end sibling): the standalone server→client
    // channel settled — by mid-stream error OR by ending cleanly — while the
    // transport is supposed to live. Pre-fix this only debug-logged and
    // `fireExit` ran solely from close(), so the supervisor stayed "healthy"
    // over a permanently dead channel and the §1.2 Last-Event-ID resume
    // machinery was unreachable. fireExit is the documented re-open path: the
    // client fails pending promptly and the ADR-0435 supervisor (when wired)
    // mints a replacement seeded with `getLastEventId()` so the server replays
    // missed events.
    const detail =
      pump.outcome === "failed"
        ? (pump.error ?? "stream error")
        : "stream ended while the transport is alive"
    logger.warn("mcp: standalone SSE stream died", {
      server: this.name,
      outcome: pump.outcome,
      detail,
    })
    this.fireExit(`mcp server "${this.name}" standalone SSE stream died: ${detail}`)
  }

  /** Discard a response body (error path) so the underlying socket is released
   *  rather than left half-read. Best-effort: cancelling the stream is enough to
   *  free it; any cancel error is irrelevant on an already-failed exchange. */
  private async drainBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
    if (body === null) return
    try {
      await body.cancel()
    } catch {
      // The exchange already failed; a cancel error changes nothing.
    }
  }

  /** Read an SSE byte stream, splitting on blank-line event boundaries and
   *  emitting each event's `data:` payload as a decoded JSON-RPC message.
   *  T01 (audit L9 H12): `signal` (the owning POST / standalone-GET controller)
   *  cancels the reader so `close()` releases the socket instead of leaking it
   *  behind a server that streams an unbounded body.
   *
   *  Audit jun-10 #4 — returns HOW the pump settled instead of swallowing a
   *  mid-stream error at debug, so each caller applies its own escalation
   *  (see {@link SsePumpOutcome}). A throw with the owning signal already
   *  aborted is classified `aborted`, not `failed` — reader.cancel() racing
   *  read() commonly rejects during a deliberate close(). */
  private async consumeSseBody(
    body: ReadableStream<Uint8Array> | null,
    signal?: AbortSignal,
  ): Promise<SsePumpOutcome> {
    // A 200 SSE response with NO body never delivered a channel — report it as
    // a clean end and let the caller decide whether that violates its contract.
    if (body === null) return { outcome: "ended" }
    const reader = body.getReader()
    let buffer = ""
    // Resolves the moment the owning signal aborts. We race it against
    // reader.read() so the drain loop exits PROMPTLY on close() even when
    // reader.cancel() does not unblock an already-pending read() — a real
    // hazard with some SSE bodies/proxies that would otherwise wedge close()
    // (which awaits this pump) forever (audit L9 H12).
    const ABORTED = Symbol("aborted")
    const onAbort = (): void => {
      void reader.cancel(signal?.reason).catch(() => undefined)
    }
    let abortWait: Promise<typeof ABORTED> = new Promise(() => {})
    if (signal !== undefined) {
      abortWait = new Promise<typeof ABORTED>((resolve) => {
        const fire = (): void => {
          onAbort()
          resolve(ABORTED)
        }
        if (signal.aborted) fire()
        else signal.addEventListener("abort", fire, { once: true })
      })
    }
    let outcome: "ended" | "aborted" = "ended"
    try {
      for (;;) {
        const next = await Promise.race([reader.read(), abortWait])
        if (next === ABORTED) {
          outcome = "aborted"
          break
        }
        const { value, done } = next
        if (done) break
        if (value !== undefined) buffer += this.decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf("\n\n")
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const parsed = sseDataFromBlock(block)
          if (parsed.id !== null) this.lastEventId = parsed.id // §1.2 resume cursor
          if (parsed.data !== null) this.decodeAndEmit(parsed.data)
          boundary = buffer.indexOf("\n\n")
        }
      }
      // Flush a trailing event with no terminating blank line (back-compat: some
      // servers omit the final `\n\n`). Audit R1#4 + R2#2 — advance the cursor
      // from this block ONLY when every line is COMPLETE (buffer ends with `\n`):
      // a complete-but-not-blank-terminated event's id is real (else a reconnect
      // RE-replays the just-delivered event = duplicate), but a stream cut
      // MID-line (`id: ab…`) must NOT record a truncated id.
      const trailingComplete = buffer.endsWith("\n")
      const parsed = sseDataFromBlock(buffer)
      if (trailingComplete && parsed.id !== null) this.lastEventId = parsed.id
      if (parsed.data !== null) this.decodeAndEmit(parsed.data)
      return { outcome }
    } catch (e) {
      // Audit jun-10 #4 — classify, don't swallow: an abort-driven rejection
      // (reader.cancel racing read() during close()) is the deliberate arm;
      // anything else is a REAL mid-pump failure the caller must escalate.
      if (signal?.aborted === true) return { outcome: "aborted" }
      return { outcome: "failed", error: errMessage(e) }
    } finally {
      if (signal !== undefined) signal.removeEventListener("abort", onAbort)
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
