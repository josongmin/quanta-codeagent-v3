/**
 * W5 — minimal Chrome DevTools Protocol (CDP) client for the NODE runtime.
 *
 * Node speaks CDP (not DAP) over a WebSocket: `node --inspect-brk` exposes a
 * `Debugger`/`Runtime` domain we drive to stop at a failure line and snapshot
 * locals. This is the CDP analogue of {@link DapClient} — same posture: sits
 * over an injected {@link CdpTransport} (a real WebSocket in production, a
 * scripted fake in tests), correlates `id`→reply, and routes `{method}` events
 * to one-shot waiters. Each WS message is ONE complete JSON object (no
 * Content-Length framing, unlike DAP).
 *
 * NEVER rejects on a CDP `error` reply — that is a normal protocol outcome the
 * driver inspects; rejection is reserved for a disposed/closed transport.
 */
import { addHandler, armWaiter, fanOutEvent } from "./event-fanout"

/** Byte carrier between the client and a CDP endpoint (one JSON string per
 *  WebSocket message). */
export interface CdpTransport {
  send(data: string): void
  /** Register the inbound sink. Each call delivers ONE complete JSON message. */
  onData(cb: (message: string) => void): void
  close(): void
}

export interface CdpResponse {
  readonly result?: unknown
  readonly error?: { readonly message?: string }
}

type EventHandler = (params: unknown) => void

/** One decoded CDP frame, before it is known to be a reply or an event. */
interface CdpFrame {
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: { message?: unknown }
}

/** Project a decoded reply frame onto the client-facing {@link CdpResponse}.
 *
 *  These two conditional spreads (one of them with a NESTED ternary) were the
 *  bulk of `ingest`'s complexity: inside `if` > `if` > object literal they were
 *  charged at depth 3 and 4; at top level they cost one point each. Behaviour is
 *  preserved EXACTLY, including the sharp edge: `error: null` is not
 *  `undefined`, so the gate opens and `msg.error.message` throws — the throw
 *  escapes `ingest` (and the transport's onData callback) with the pending entry
 *  ALREADY deleted. Pinned by the differential, deliberately not "fixed" here. */
const toCdpResponse = (msg: CdpFrame): CdpResponse => ({
  ...(msg.result !== undefined ? { result: msg.result } : {}),
  ...(msg.error !== undefined
    ? {
        error: {
          message: typeof msg.error.message === "string" ? msg.error.message : "cdp error",
        },
      }
    : {}),
})

export class CdpClient {
  private seq = 0
  private disposed = false
  private readonly pending = new Map<number, (res: CdpResponse) => void>()
  private readonly waiters = new Map<string, Array<(params: unknown) => void>>()
  private readonly handlers = new Map<string, Set<EventHandler>>()

  constructor(private readonly transport: CdpTransport) {
    transport.onData((raw) => this.ingest(raw))
  }

  /** Send a CDP command; resolves with the reply (result OR error). */
  request(method: string, params?: Record<string, unknown>): Promise<CdpResponse> {
    if (this.disposed)
      return Promise.reject(new Error(`cdp: transport disposed (method=${method})`))
    const id = ++this.seq
    return new Promise<CdpResponse>((resolve) => {
      this.pending.set(id, resolve)
      this.transport.send(JSON.stringify({ id, method, params: params ?? {} }))
    })
  }

  /** Resolve once, on the NEXT occurrence of `method` (a CDP event). */
  waitForEvent(method: string): Promise<unknown> {
    return new Promise((resolve) => {
      armWaiter(this.waiters, method, resolve)
    })
  }

  /** Persistent subscription to a CDP event (stays until dispose). */
  onEvent(method: string, handler: EventHandler): void {
    addHandler(this.handlers, method, handler)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const resolve of this.pending.values())
      resolve({ error: { message: "cdp: client disposed" } })
    this.pending.clear()
    try {
      this.transport.close()
    } catch {
      // best-effort
    }
  }

  /** Correlate ONE reply frame with the command waiting on it. An unknown or
   *  already-settled `id` is a deliberate NO-OP. The pending entry is removed
   *  BEFORE the response is built, which is why a malformed `error` payload
   *  leaves the awaiter permanently unsettled (see {@link toCdpResponse}). */
  private settleReply(id: number, msg: CdpFrame): void {
    const resolve = this.pending.get(id)
    if (resolve === undefined) return
    this.pending.delete(id)
    resolve(toCdpResponse(msg))
  }

  /** The read loop, now only a ROUTER: parse one WS message and send it down
   *  exactly one of the two paths. An `id`-bearing frame NEVER reaches the event
   *  fan-out even when it also carries a `method` (pre-existing behaviour). */
  private ingest(raw: string): void {
    let msg: CdpFrame
    try {
      msg = JSON.parse(raw)
    } catch {
      return // malformed frame — ignore, never throw
    }
    if (typeof msg.id === "number") {
      this.settleReply(msg.id, msg)
      return
    }
    if (typeof msg.method !== "string") return
    fanOutEvent(this.handlers, this.waiters, msg.method, msg.params)
  }
}
