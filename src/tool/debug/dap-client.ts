/**
 * W5 DAP — request/response correlation client.
 *
 * Sits over a {@link DapTransport} (the byte carrier — a spawned adapter's
 * stdio in production, a scripted fake in tests). Responsibilities:
 *   - assign monotonic `seq`, frame+send requests, resolve each by matching
 *     `request_seq` on the response (adapters answer OUT OF ORDER);
 *   - decode the inbound byte stream via {@link DapFrameDecoder} and route
 *     `event` messages to subscribers / one-shot waiters;
 *   - NEVER reject on a `success:false` DAP response — that is a normal protocol
 *     outcome the tool layer reports, not a transport failure. Rejection is
 *     reserved for a genuinely dead transport (disposed / closed).
 */
import { DapFrameDecoder, encodeDapMessage } from "./dap-codec"
import { addHandler, armWaiter, fanOutEvent } from "./event-fanout"

/** Byte carrier between the client and a debug adapter. */
export interface DapTransport {
  /** Write framed bytes to the adapter's stdin. */
  send(data: string): void
  /** Register the inbound (adapter→client) byte sink. Called once. */
  onData(cb: (chunk: string | Buffer) => void): void
  /** Tear down the underlying carrier (kill the process / close the socket). */
  close(): void
}

export interface DapResponse {
  readonly success: boolean
  readonly command?: string
  readonly message?: string
  readonly body?: unknown
}

type EventHandler = (body: unknown) => void

/** Project a raw DAP response frame onto the client-facing {@link DapResponse}.
 *
 *  These three conditional spreads WERE the bulk of `ingest`'s complexity: at
 *  their old home (`for` > `if` > `if` > object literal) each ternary was
 *  charged at nesting depth 3; hoisted to a top-level projection they cost one
 *  point each. Behaviour is unchanged and deliberately literal-minded:
 *  `success === true` (a missing or non-boolean `success` is a FAILED response,
 *  never a truthy one), and an explicit `null` `command`/`message`/`body` is NOT
 *  `undefined`, so it is carried through rather than dropped. */
const toDapResponse = (raw: unknown): DapResponse => {
  const full = raw as DapResponse
  return {
    success: full.success === true,
    ...(full.command !== undefined ? { command: full.command } : {}),
    ...(full.message !== undefined ? { message: full.message } : {}),
    ...(full.body !== undefined ? { body: full.body } : {}),
  }
}

export class DapClient {
  private seq = 1
  private disposed = false
  private readonly decoder = new DapFrameDecoder()
  private readonly pending = new Map<number, (res: DapResponse) => void>()
  private readonly handlers = new Map<string, Set<EventHandler>>()
  private readonly waiters = new Map<string, Array<(body: unknown) => void>>()

  constructor(private readonly transport: DapTransport) {
    transport.onData((chunk) => this.ingest(chunk))
  }

  /** Send a DAP request; resolves with the response (success true OR false). */
  request(command: string, args?: unknown): Promise<DapResponse> {
    if (this.disposed)
      return Promise.reject(new Error(`dap: transport disposed (command=${command})`))
    const seq = this.seq++
    const msg = {
      seq,
      type: "request",
      command,
      ...(args !== undefined ? { arguments: args } : {}),
    }
    return new Promise<DapResponse>((resolve) => {
      this.pending.set(seq, resolve)
      this.transport.send(encodeDapMessage(msg))
    })
  }

  /** Subscribe to a DAP event (`stopped`, `output`, `terminated`, …). */
  onEvent(event: string, handler: EventHandler): void {
    addHandler(this.handlers, event, handler)
  }

  /** Resolve once, on the NEXT occurrence of `event`. */
  waitForEvent(event: string): Promise<unknown> {
    return new Promise((resolve) => {
      armWaiter(this.waiters, event, resolve)
    })
  }

  /** Stop accepting work; pending requests are rejected (no silent hangs). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const resolve of this.pending.values()) {
      // Resolve pending as a synthetic failure so awaiters unblock deterministically.
      resolve({ success: false, message: "dap: client disposed" })
    }
    this.pending.clear()
    try {
      this.transport.close()
    } catch {
      // close() is best-effort.
    }
  }

  /** Correlate ONE response frame with the request waiting on it. An unknown or
   *  already-settled `request_seq` is a deliberate NO-OP (adapters do re-answer
   *  and answer out of order). The pending entry is removed BEFORE the resolver
   *  runs, so a resolver that re-enters can never observe a half-settled map. */
  private settleResponse(requestSeq: number, raw: unknown): void {
    const resolve = this.pending.get(requestSeq)
    if (resolve === undefined) return
    this.pending.delete(requestSeq)
    resolve(toDapResponse(raw))
  }

  /** The read loop, now only a ROUTER: decode the byte stream into whole frames
   *  and send each down exactly one of the two paths (response correlation /
   *  event fan-out). The `continue` is load-bearing — a `type:"response"` frame
   *  whose `request_seq` is missing or non-numeric falls through to the event
   *  test (and fails it), which is the pre-existing behaviour. */
  private ingest(chunk: string | Buffer): void {
    for (const raw of this.decoder.push(chunk)) {
      const msg = raw as { type?: string; request_seq?: number; event?: string; body?: unknown }
      if (msg.type === "response" && typeof msg.request_seq === "number") {
        this.settleResponse(msg.request_seq, raw)
        continue
      }
      if (msg.type === "event" && typeof msg.event === "string")
        fanOutEvent(this.handlers, this.waiters, msg.event, msg.body)
    }
  }
}
