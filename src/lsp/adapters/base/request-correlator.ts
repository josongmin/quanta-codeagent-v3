import type { JsonRpcResponse } from "../jsonrpc"
import { LspRequestError } from "./errors"
import { abortError } from "./mappers"
import type { PendingRequest } from "./raw-types"

/** Ports the {@link RequestCorrelator} needs from its host `LspClient` (pure
 *  structural motion — no behavior change). */
export interface RequestCorrelatorPorts {
  /** Per-request timeout (also bounds the diagnostics wait). */
  readonly requestTimeoutMs: number
  /** Server-process-exited flag (owned by the client / transport). */
  isExited(): boolean
  /** Deliberate-stop flag (owned by the client). */
  isStopped(): boolean
  /** Write an encoded payload to the transport. Returns an `Error` on a dead
   *  channel (mirrors the old `send()` return contract), or `null` on success. */
  send(payload: unknown): Error | null
  /** The client's (overridable, protected) notification seam. Used for the
   *  `$/cancelRequest` sent on abort so a test subclass override still sees it. */
  sendNotification(method: string, params: unknown): void
}

/** State owner for JSON-RPC request/response correlation split out of
 *  `LspClient`.
 *
 *  Owns `nextId` (the request-id counter) and `pending` (Map<id,
 *  PendingRequest>). Timeout/timer/abort semantics are preserved EXACTLY. */
export class RequestCorrelator {
  private nextId = 1
  readonly pending = new Map<number, PendingRequest>()

  constructor(private readonly ports: RequestCorrelatorPorts) {}

  /** Send a JSON-RPC request and resolve with the server's `result`.
   *
   *  Correlates by id, bounds the wait by `requestTimeoutMs`, and rejects with
   *  {@link LspRequestError} when the server returns an error (so callers can
   *  inspect the JSON-RPC code). */
  sendRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++
    const payload =
      params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params }
    return new Promise<unknown>((resolve, reject) => {
      // Lifecycle guard: if the server has already exited or we've stopped,
      // reject immediately instead of registering a pending entry whose
      // `send()` would silently no-op (stdin gone) and only fail on timeout —
      // a needless `requestTimeoutMs` hang. Mirrors McpClient.request().
      // `shutdown` is exempt: stop() issues it after setting `stopped`.
      if ((this.ports.isExited() || this.ports.isStopped()) && method !== "shutdown") {
        reject(new Error(`LSP request "${method}" issued after server stopped/exited`))
        return
      }
      if (signal?.aborted) {
        reject(abortError(`LSP request "${method}"`))
        return
      }
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        entry.detachAbort?.()
        reject(
          new Error(`LSP request "${method}" timed out after ${this.ports.requestTimeoutMs}ms`),
        )
      }, this.ports.requestTimeoutMs)
      const entry: PendingRequest = { resolve, reject, timer, method }
      if (signal) {
        const onAbort = () => {
          if (!this.takePending(id)) return
          this.ports.sendNotification("$/cancelRequest", { id })
          reject(abortError(`LSP request "${method}"`))
        }
        signal.addEventListener("abort", onAbort, { once: true })
        entry.detachAbort = () => signal.removeEventListener("abort", onAbort)
      }
      this.pending.set(id, entry)
      const sendError = this.ports.send(payload)
      if (sendError) {
        const pending = this.takePending(id)
        if (!pending) return
        pending.reject(sendError)
      }
    })
  }

  resolvePending(msg: JsonRpcResponse): void {
    const id = typeof msg.id === "number" ? msg.id : Number(msg.id)
    const entry = this.takePending(id)
    if (!entry) return
    if (msg.error) {
      entry.reject(new LspRequestError(entry.method, msg.error))
    } else {
      entry.resolve(msg.result)
    }
  }

  takePending(id: number): PendingRequest | undefined {
    const entry = this.pending.get(id)
    if (!entry) return undefined
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.detachAbort?.()
    return entry
  }

  /** Reject every in-flight request with `reason` and drop the pending set. */
  failAll(reason: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.detachAbort?.()
      entry.reject(reason)
    }
    this.pending.clear()
  }
}
