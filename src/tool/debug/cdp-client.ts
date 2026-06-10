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
    if (this.disposed) return Promise.reject(new Error(`cdp: transport disposed (method=${method})`))
    const id = ++this.seq
    return new Promise<CdpResponse>((resolve) => {
      this.pending.set(id, resolve)
      this.transport.send(JSON.stringify({ id, method, params: params ?? {} }))
    })
  }

  /** Resolve once, on the NEXT occurrence of `method` (a CDP event). */
  waitForEvent(method: string): Promise<unknown> {
    return new Promise((resolve) => {
      const arr = this.waiters.get(method) ?? []
      arr.push(resolve)
      this.waiters.set(method, arr)
    })
  }

  /** Persistent subscription to a CDP event (stays until dispose). */
  onEvent(method: string, handler: EventHandler): void {
    let set = this.handlers.get(method)
    if (set === undefined) {
      set = new Set()
      this.handlers.set(method, set)
    }
    set.add(handler)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const resolve of this.pending.values()) resolve({ error: { message: "cdp: client disposed" } })
    this.pending.clear()
    try {
      this.transport.close()
    } catch {
      // best-effort
    }
  }

  private ingest(raw: string): void {
    let msg: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: unknown } }
    try {
      msg = JSON.parse(raw)
    } catch {
      return // malformed frame — ignore, never throw
    }
    if (typeof msg.id === "number") {
      const resolve = this.pending.get(msg.id)
      if (resolve !== undefined) {
        this.pending.delete(msg.id)
        resolve({
          ...(msg.result !== undefined ? { result: msg.result } : {}),
          ...(msg.error !== undefined ? { error: { message: typeof msg.error.message === "string" ? msg.error.message : "cdp error" } } : {}),
        })
      }
      return
    }
    if (typeof msg.method !== "string") return
    for (const h of this.handlers.get(msg.method) ?? []) {
      try {
        h(msg.params)
      } catch {
        // a buggy subscriber must not break the read loop
      }
    }
    const arr = this.waiters.get(msg.method)
    if (arr !== undefined && arr.length > 0) {
      this.waiters.delete(msg.method)
      for (const resolve of arr) resolve(msg.params)
    }
  }
}
