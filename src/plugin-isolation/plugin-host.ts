/**
 * `PluginHost` — typed JSON-RPC 2.0 wrapper over an {@link IsolatedProcess}
 * (ADR-0162 Phase B).
 *
 * Why a wrapper at all (instead of using McpClient's JSON-RPC directly)?
 *  - McpClient owns the MCP protocol grammar (`initialize`, `tools/call`, ...).
 *    PluginHost is protocol-agnostic — any plugin can speak any method names.
 *  - PluginHost depends on {@link IsolatedProcess} only (closed port), so the
 *    same wrapper works for the Bun spawner today and a future Electron
 *    `UtilityProcess` adapter without code change (OCP).
 *
 * Contract bullets (sealed by hellgate):
 *  - `call(method, params, opts)` returns a typed Promise; per-call timeout
 *    defaults to `DEFAULT_CALL_TIMEOUT_MS` (30s), overridable.
 *  - `notify(method, params)` is fire-and-forget — no correlation, no timer.
 *  - Inbound notifications are routed to handlers registered by `onNotification`.
 *    Unknown methods are warn-logged and dropped (NO-THROW).
 *  - Duplicate response `id` from child → typed reject + warn; subsequent uses
 *    of the same id are dropped.
 *  - Corrupted envelope (non-object / missing jsonrpc / malformed id) → drop
 *    + warn (NO-THROW).
 *  - `AbortSignal` on a call → reject {@link IsolatedCallAborted} + remove
 *    from pending map (no timer leak).
 *  - Child exit → fail-all-pending (every queued resolve becomes a reject
 *    with code `process-exited`).
 *  - `stop()` is idempotent — calls `proc.kill('SIGTERM')` once, waits for
 *    `exitPromise`, then resolves.
 */

import { logger, QuantaError } from "@/shared"
import type { IsolatedProcess } from "./types"

export const DEFAULT_CALL_TIMEOUT_MS = 30_000

export type PluginHostErrorKind =
  | "call-timeout"
  | "call-aborted"
  | "process-exited"
  | "remote-error"
  | "duplicate-id"

export class PluginHostError extends QuantaError {
  /** Typed sub-classification — `code` is fixed to "plugin-host" by
   *  {@link QuantaError}, but callers need to branch on the specific failure. */
  readonly kind: PluginHostErrorKind
  constructor(kind: PluginHostErrorKind, message: string) {
    super("plugin-host", message)
    this.kind = kind
  }
}

interface PendingCall {
  readonly resolve: (value: unknown) => void
  readonly reject: (e: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly abortHandler?: () => void
  readonly signal?: AbortSignal
}

interface JsonRpcRequest {
  readonly jsonrpc: "2.0"
  readonly id: number
  readonly method: string
  readonly params?: unknown
}
interface JsonRpcNotification {
  readonly jsonrpc: "2.0"
  readonly method: string
  readonly params?: unknown
}
interface JsonRpcResponse {
  readonly jsonrpc: "2.0"
  readonly id: number
  readonly result?: unknown
  readonly error?: { code: number; message: string; data?: unknown }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const isResponse = (v: Record<string, unknown>): boolean =>
  v["jsonrpc"] === "2.0" &&
  typeof v["id"] === "number" &&
  !("method" in v) &&
  ("result" in v || "error" in v)

const isNotification = (v: Record<string, unknown>): boolean =>
  v["jsonrpc"] === "2.0" && typeof v["method"] === "string" && !("id" in v)

export interface PluginHostOpts {
  readonly defaultCallTimeoutMs?: number
}

export interface CallOpts {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** Stateful JSON-RPC 2.0 client over an {@link IsolatedProcess}. One instance
 *  per process. Construct, use, then `stop()`. */
export class PluginHost {
  private readonly proc: IsolatedProcess
  private readonly defaultCallTimeoutMs: number
  private readonly pending = new Map<number, PendingCall>()
  private readonly notifHandlers = new Map<string, Set<(params: unknown) => void>>()
  private nextId = 1
  private exited = false
  private stopping: Promise<void> | null = null
  private readonly unsubscribeMessages: () => void

  constructor(proc: IsolatedProcess, opts: PluginHostOpts = {}) {
    this.proc = proc
    this.defaultCallTimeoutMs = opts.defaultCallTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    this.unsubscribeMessages = proc.onMessage((m) => {
      this.handleIncoming(m)
    })
    void proc.exitPromise.then(
      () => this.onProcessExit(),
      () => this.onProcessExit(),
    )
  }

  /** Issue a JSON-RPC request, await the typed result. */
  call(method: string, params?: unknown, opts: CallOpts = {}): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(
        new PluginHostError(
          "process-exited",
          `plugin host "${this.proc.serviceName}" has exited; call("${method}") rejected`,
        ),
      )
    }
    const id = this.nextId++
    const timeoutMs = opts.timeoutMs ?? this.defaultCallTimeoutMs
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.deletePending(id)
        reject(
          new PluginHostError(
            "call-timeout",
            `plugin call "${method}" on "${this.proc.serviceName}" timed out after ${timeoutMs}ms`,
          ),
        )
      }, timeoutMs)
      const signal = opts.signal
      let abortHandler: (() => void) | undefined
      if (signal !== undefined) {
        if (signal.aborted) {
          clearTimeout(timer)
          reject(
            new PluginHostError(
              "call-aborted",
              `plugin call "${method}" on "${this.proc.serviceName}" aborted`,
            ),
          )
          return
        }
        abortHandler = (): void => {
          this.deletePending(id)
          reject(
            new PluginHostError(
              "call-aborted",
              `plugin call "${method}" on "${this.proc.serviceName}" aborted`,
            ),
          )
        }
        signal.addEventListener("abort", abortHandler, { once: true })
      }
      const entry: PendingCall =
        abortHandler === undefined || signal === undefined
          ? { resolve, reject, timer }
          : { resolve, reject, timer, abortHandler, signal }
      this.pending.set(id, entry)
      const req: JsonRpcRequest =
        params === undefined
          ? { jsonrpc: "2.0", id, method }
          : { jsonrpc: "2.0", id, method, params }
      this.proc.send(req)
    })
  }

  /** Fire-and-forget. */
  notify(method: string, params?: unknown): void {
    if (this.exited) return
    const n: JsonRpcNotification =
      params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params }
    this.proc.send(n)
  }

  /** Register a handler for inbound notifications of `method`. Returns
   *  idempotent unsubscribe. */
  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let set = this.notifHandlers.get(method)
    if (!set) {
      set = new Set()
      this.notifHandlers.set(method, set)
    }
    set.add(handler)
    return () => {
      const s = this.notifHandlers.get(method)
      if (!s) return
      s.delete(handler)
      if (s.size === 0) this.notifHandlers.delete(method)
    }
  }

  /** Resolves when the underlying isolated process exits. Mirror of the
   *  IsolatedProcess.exitPromise field; exposed so lifecycle managers can
   *  attach exit watchers without reaching into the private `proc`. */
  get exitPromise(): Promise<{ code: number | null; signal: string | null }> {
    return this.proc.exitPromise
  }

  /** Politely SIGTERM the child, await reaping. Idempotent — concurrent
   *  invocations all await the same exit. */
  stop(): Promise<void> {
    if (this.stopping !== null) return this.stopping
    this.stopping = (async (): Promise<void> => {
      try {
        await this.proc.kill("SIGTERM")
      } finally {
        this.onProcessExit()
      }
    })()
    return this.stopping
  }

  // --- internals -----------------------------------------------------------

  private deletePending(id: number): void {
    const entry = this.pending.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    if (entry.abortHandler && entry.signal) {
      entry.signal.removeEventListener("abort", entry.abortHandler)
    }
    this.pending.delete(id)
  }

  private handleIncoming(raw: unknown): void {
    if (!isObj(raw)) {
      logger.warn("plugin-host: dropping non-object frame", {
        serviceName: this.proc.serviceName,
      })
      return
    }
    if (isResponse(raw)) {
      this.handleResponse(raw as unknown as JsonRpcResponse)
      return
    }
    if (isNotification(raw)) {
      this.handleNotification(raw as unknown as JsonRpcNotification)
      return
    }
    logger.warn("plugin-host: dropping malformed envelope", {
      serviceName: this.proc.serviceName,
      keys: Object.keys(raw).slice(0, 8),
    })
  }

  private handleResponse(res: JsonRpcResponse): void {
    const id = res.id
    const entry = this.pending.get(id)
    if (!entry) {
      logger.warn("plugin-host: dropping response for unknown/duplicate id", {
        serviceName: this.proc.serviceName,
        id,
      })
      return
    }
    this.deletePending(id)
    if (res.error !== undefined) {
      entry.reject(
        new PluginHostError(
          "remote-error",
          `plugin remote error ${res.error.code}: ${res.error.message}`,
        ),
      )
      return
    }
    entry.resolve(res.result)
  }

  private handleNotification(n: JsonRpcNotification): void {
    const handlers = this.notifHandlers.get(n.method)
    if (!handlers || handlers.size === 0) {
      logger.warn("plugin-host: unhandled notification", {
        serviceName: this.proc.serviceName,
        method: n.method,
      })
      return
    }
    const snapshot = Array.from(handlers)
    for (const h of snapshot) {
      try {
        h(n.params)
      } catch (e) {
        logger.warn("plugin-host: notification handler threw", {
          serviceName: this.proc.serviceName,
          method: n.method,
          error: String(e),
        })
      }
    }
  }

  private onProcessExit(): void {
    if (this.exited) return
    this.exited = true
    this.unsubscribeMessages()
    const err = new PluginHostError(
      "process-exited",
      `plugin host "${this.proc.serviceName}" exited; pending calls rejected`,
    )
    const snapshot = Array.from(this.pending.entries())
    for (const [id, entry] of snapshot) {
      clearTimeout(entry.timer)
      if (entry.abortHandler && entry.signal) {
        entry.signal.removeEventListener("abort", entry.abortHandler)
      }
      this.pending.delete(id)
      entry.reject(err)
    }
  }
}
