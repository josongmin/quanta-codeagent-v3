import { pathToFileURL } from "node:url"
import type { Subprocess } from "bun"
import { logger } from "@/shared"
import type { LspPort } from "../ports"
import type { Diagnostic, DiagnosticSeverity, LspServerInfo, Pos } from "../types"
import { encodeMessage, type JsonRpcMessage, type JsonRpcResponse, MessageReader } from "./jsonrpc"

/** Options shared by every stdio LSP adapter. The two concrete adapters differ
 *  only in their default {@link spawnCommand} and {@link languageId}; everything
 *  else (handshake, framing, request correlation, lifecycle) is identical and
 *  lives here once (RFC §3.1: 2+ implementations ⇒ extract a shared base). */
export interface LspClientOptions {
  /** Argv used to spawn the server. Defaults to the standard stdio launcher. */
  command?: string[]
  /** Project root the server analyses. Defaults to `process.cwd()`. */
  cwd?: string
  /** Per-request timeout (also bounds the diagnostics wait). Default 8000ms. */
  requestTimeoutMs?: number
}

/** Per-server identity supplied by the concrete adapter (its only variance). */
export interface LspClientSpec {
  /** Default argv when {@link LspClientOptions.command} is not given. */
  defaultCommand: string[]
  /** Resolve the LSP `languageId` for a file (e.g. `python`, `typescriptreact`). */
  languageIdFor(filePath: string): string
}

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000

/** Raw LSP shapes we read off the wire. Kept minimal: we narrow only the
 *  fields we consume (same pattern as the LLM adapters). */
interface RawRange {
  start: { line: number; character: number }
  end: { line: number; character: number }
}
interface RawDiagnostic {
  range: RawRange
  severity?: number
  message: string
  source?: string
  code?: string | number
}
interface PublishDiagnosticsParams {
  uri: string
  diagnostics: RawDiagnostic[]
}
interface InitializeResult {
  serverInfo?: { name: string; version?: string }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const SEVERITY: Record<number, DiagnosticSeverity> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
}

const toPos = (p: { line: number; character: number }): Pos => ({
  line: p.line,
  character: p.character,
})

const mapDiagnostic = (uri: string, d: RawDiagnostic): Diagnostic => ({
  uri,
  severity: SEVERITY[d.severity ?? 1] ?? "error",
  message: d.message,
  range: { start: toPos(d.range.start), end: toPos(d.range.end) },
  ...(d.source !== undefined ? { source: d.source } : {}),
  ...(d.code !== undefined ? { code: String(d.code) } : {}),
})

const isResponse = (m: JsonRpcMessage): m is JsonRpcResponse => "id" in m && !("method" in m)

const isNotification = (
  m: JsonRpcMessage,
): m is { jsonrpc: "2.0"; method: string; params?: unknown } => "method" in m && !("id" in m)

/** A real LSP client over stdio, parameterised by an {@link LspClientSpec}.
 *
 *  Lifecycle: spawn → `initialize` → `initialized` → (per file)
 *  `textDocument/didOpen` then await `textDocument/publishDiagnostics` →
 *  `shutdown` → `exit` → kill. Requests are correlated by an incrementing id
 *  with per-request timeouts; all pending work is rejected if the process
 *  dies, so there are never unhandled rejections or leaked timers. */
export class LspClient implements LspPort {
  private readonly command: string[]
  private readonly cwd: string
  private readonly requestTimeoutMs: number
  private readonly spec: LspClientSpec

  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null
  private reader = new MessageReader()
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly diagnosticsByUri = new Map<string, Diagnostic[]>()
  private readonly diagnosticsWaiters = new Map<string, Array<(d: Diagnostic[]) => void>>()
  private readPump: Promise<void> | null = null
  private stopped = false
  private exited = false
  serverInfo: LspServerInfo | null = null

  constructor(spec: LspClientSpec, options: LspClientOptions = {}) {
    this.spec = spec
    this.command = options.command ?? spec.defaultCommand
    this.cwd = options.cwd ?? process.cwd()
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  async start(): Promise<void> {
    if (this.proc) return
    this.proc = Bun.spawn(this.command, {
      cwd: this.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.readPump = this.pumpStdout()
    this.watchExit()

    const init = (await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "quanta-codeagent", version: "0.1.0" },
      rootUri: pathToFileURL(this.cwd).href,
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: false },
          synchronization: { didSave: false, dynamicRegistration: false },
        },
      },
    })) as InitializeResult
    if (init.serverInfo) {
      this.serverInfo = {
        name: init.serverInfo.name,
        ...(init.serverInfo.version !== undefined ? { version: init.serverInfo.version } : {}),
      }
    }
    this.notify("initialized", {})
  }

  async diagnostics(filePath: string): Promise<Diagnostic[]> {
    if (!this.proc) throw new Error("LspClient.diagnostics called before start()")
    const uri = pathToFileURL(filePath).href
    const text = await Bun.file(filePath).text()

    this.diagnosticsByUri.delete(uri)
    const arrival = this.waitForDiagnostics(uri)

    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: this.spec.languageIdFor(filePath), version: 1, text },
    })

    const diags = await arrival
    this.notify("textDocument/didClose", { textDocument: { uri } })
    return diags
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    const proc = this.proc
    if (!proc) return

    try {
      if (!this.exited) {
        await this.request("shutdown", null).catch(() => undefined)
        this.notify("exit", undefined)
      }
    } finally {
      this.failAllPending(new Error("LSP server stopped"))
      try {
        proc.stdin?.end()
      } catch {
        // stdin may already be closed
      }
      try {
        proc.kill()
      } catch {
        // process may have already exited
      }
      await proc.exited.catch(() => undefined)
      await this.readPump?.catch(() => undefined)
      this.proc = null
    }
  }

  // --- internals -----------------------------------------------------------

  private waitForDiagnostics(uri: string): Promise<Diagnostic[]> {
    const existing = this.diagnosticsByUri.get(uri)
    if (existing) return Promise.resolve(existing)

    return new Promise<Diagnostic[]>((resolve) => {
      const waiters = this.diagnosticsWaiters.get(uri) ?? []
      let settled = false
      const settle = (d: Diagnostic[]) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(d)
      }
      const timer = setTimeout(() => {
        // No publish within the bound: treat as "no diagnostics" rather than
        // hang. Servers emit an empty array for clean files, but a timeout is
        // the safety net if a notification is somehow missed.
        settle(this.diagnosticsByUri.get(uri) ?? [])
      }, this.requestTimeoutMs)
      waiters.push(settle)
      this.diagnosticsWaiters.set(uri, waiters)
    })
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const payload =
      params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP request "${method}" timed out after ${this.requestTimeoutMs}ms`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send(payload)
    })
  }

  private notify(method: string, params: unknown): void {
    const payload =
      params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params }
    this.send(payload)
  }

  private send(payload: unknown): void {
    const stdin = this.proc?.stdin
    if (!stdin) return
    try {
      stdin.write(encodeMessage(payload))
    } catch (e) {
      logger.warn("lsp: failed to write to server stdin", { error: String(e) })
    }
  }

  private async pumpStdout(): Promise<void> {
    const stdout = this.proc?.stdout
    if (!stdout) return
    try {
      for await (const chunk of stdout) {
        for (const msg of this.reader.push(chunk)) {
          this.dispatch(msg)
        }
      }
    } catch (e) {
      logger.debug("lsp: stdout pump ended", { error: String(e) })
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      this.resolvePending(msg)
      return
    }
    if (isNotification(msg) && msg.method === "textDocument/publishDiagnostics") {
      this.onPublishDiagnostics(msg.params)
    }
  }

  private resolvePending(msg: JsonRpcResponse): void {
    const id = typeof msg.id === "number" ? msg.id : Number(msg.id)
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    if (msg.error) {
      entry.reject(new Error(`LSP error: ${msg.error.message}`))
    } else {
      entry.resolve(msg.result)
    }
  }

  private onPublishDiagnostics(params: unknown): void {
    const p = params as PublishDiagnosticsParams | undefined
    if (!p || typeof p.uri !== "string" || !Array.isArray(p.diagnostics)) return
    const mapped = p.diagnostics.map((d) => mapDiagnostic(p.uri, d))
    this.diagnosticsByUri.set(p.uri, mapped)
    const waiters = this.diagnosticsWaiters.get(p.uri)
    if (waiters && waiters.length > 0) {
      this.diagnosticsWaiters.delete(p.uri)
      for (const w of waiters) w(mapped)
    }
  }

  private watchExit(): void {
    const proc = this.proc
    if (!proc) return
    proc.exited
      .then(() => {
        this.exited = true
        this.failAllPending(new Error("LSP server exited"))
      })
      .catch(() => {
        this.exited = true
        this.failAllPending(new Error("LSP server exited"))
      })
  }

  private failAllPending(reason: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(reason)
    }
    this.pending.clear()
    // Unblock any diagnostics waiters with an empty result so callers that
    // raced a shutdown resolve instead of hanging forever.
    for (const [, waiters] of this.diagnosticsWaiters) {
      for (const w of waiters) w([])
    }
    this.diagnosticsWaiters.clear()
  }
}
