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
    let set = this.handlers.get(event)
    if (set === undefined) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler)
  }

  /** Resolve once, on the NEXT occurrence of `event`. */
  waitForEvent(event: string): Promise<unknown> {
    return new Promise((resolve) => {
      const arr = this.waiters.get(event) ?? []
      arr.push(resolve)
      this.waiters.set(event, arr)
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

  private ingest(chunk: string | Buffer): void {
    for (const raw of this.decoder.push(chunk)) {
      const msg = raw as { type?: string; request_seq?: number; event?: string; body?: unknown }
      if (msg.type === "response" && typeof msg.request_seq === "number") {
        const resolve = this.pending.get(msg.request_seq)
        if (resolve !== undefined) {
          this.pending.delete(msg.request_seq)
          const full = raw as DapResponse
          resolve({
            success: full.success === true,
            ...(full.command !== undefined ? { command: full.command } : {}),
            ...(full.message !== undefined ? { message: full.message } : {}),
            ...(full.body !== undefined ? { body: full.body } : {}),
          })
        }
        continue
      }
      if (msg.type === "event" && typeof msg.event === "string") {
        for (const h of this.handlers.get(msg.event) ?? []) {
          try {
            h(msg.body)
          } catch {
            // A buggy subscriber must not break the read loop.
          }
        }
        const arr = this.waiters.get(msg.event)
        if (arr !== undefined && arr.length > 0) {
          this.waiters.delete(msg.event)
          for (const resolve of arr) resolve(msg.body)
        }
      }
    }
  }
}
