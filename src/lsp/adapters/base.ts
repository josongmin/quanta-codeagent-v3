import { randomBytes } from "node:crypto"
import { readdir, rename, unlink } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import type { Subprocess } from "bun"
import { logger } from "@/shared"
import type { LspPort } from "../ports"
import type { CodeAction, CodeActionWorkspaceEdit } from "../ports/code-action-port"
import type { FormatRange, TextEdit as FormatTextEdit } from "../ports/format-port"
import type { RenameWorkspaceEdit } from "../ports/rename-apply-port"
import type { SignatureInfo } from "../ports/signature-help-port"
import type {
  CallHierarchyEntry,
  Diagnostic,
  Hover,
  Location,
  LspServerInfo,
  Pos,
  RenamePreview,
  SymbolInfo,
} from "../types"
import { applyWorkspaceEditAtomic } from "./base/atomic-edit"
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  type LspClientOptions,
  type LspClientSpec,
  type LspProcessTreeSignal,
} from "./base/config"
import { DiagnosticsHub } from "./base/diagnostics-hub"
import { DocumentTracker } from "./base/document-tracker"
import { isUnsupportedError, LspRequestError } from "./base/errors"
import {
  codeActionFilterFor,
  flattenDocumentSymbol,
  flattenHoverContents,
  isNotification,
  isRawRange,
  isRequest,
  isResponse,
  isSymbolInformationList,
  mapCodeAction,
  mapSignature,
  mapSymbolInformation,
  mapWorkspaceSymbolEntry,
  pointRange,
  throwIfAborted,
  toCallEntry,
  toFormatTextEdit,
  toLocation,
  toLocationOrLink,
  toRange,
  toRawRange,
  toRenameWorkspaceEdit,
} from "./base/mappers"
import type {
  InitializeResult,
  PendingRequest,
  RawCallHierarchyItem,
  RawCallHierarchyResult,
  RawCodeActionResult,
  RawDefinitionResult,
  RawDocumentSymbolResult,
  RawHover,
  RawLocation,
  RawPrepareRenameResult,
  RawSignatureHelpResult,
  RawTextEdit,
  RawWorkspaceEdit,
  RawWorkspaceSymbolResult,
  WorkspaceConfigurationParams,
} from "./base/raw-types"
import { RequestCorrelator } from "./base/request-correlator"
import { LspTransport } from "./base/transport"
import { resolveWorkspaceConfiguration, toWorkspaceFolder } from "./base/workspace"
import type { JsonRpcMessage, JsonRpcResponse } from "./jsonrpc"

export type { LspClientOptions, LspClientSpec } from "./base/config"
// Re-export the complete original public surface so every importer of
// `@/lsp/adapters/base` stays byte-compatible after the god-module split.
export { LspRequestError } from "./base/errors"

const LSP_PROCESS_KILL_GRACE_MS = 2_000

/** A real LSP client over stdio, parameterised by an {@link LspClientSpec}.
 *
 *  Lifecycle: spawn → `initialize` → `initialized` → (per file)
 *  `textDocument/didOpen` then await `textDocument/publishDiagnostics` →
 *  `shutdown` → `exit` → kill. Requests are correlated by an incrementing id
 *  with per-request timeouts; all pending work is rejected if the process
 *  dies, so there are never unhandled rejections or leaked timers.
 *
 *  The transport (subprocess + pumps + RSS watchdog), request correlation,
 *  per-session diagnostics, and open-document LRU are each owned by a
 *  collaborator ({@link LspTransport}, {@link RequestCorrelator},
 *  {@link DiagnosticsHub}, {@link DocumentTracker}); this class composes them
 *  and wires the read-pump fan-out. */
export class LspClient implements LspPort {
  private readonly requestTimeoutMs: number
  private readonly workspaceFolders: readonly string[]
  private readonly workspaceConfiguration: Readonly<Record<string, unknown>>
  private readonly spec: LspClientSpec

  private readonly transport: LspTransport
  private readonly correlator: RequestCorrelator
  private readonly diagnosticsHub: DiagnosticsHub
  private readonly documents: DocumentTracker

  private stopped = false
  serverInfo: LspServerInfo | null = null

  // --- Delegating views onto collaborator-owned state --------------------
  // Kept as instance accessors under the original field names so both the
  // internals below AND the in-process test seams (which reach `this.proc`,
  // `this.opened`, `this.pending`, `this.diagnosticsByUri`,
  // `this.diagnosticsWaiters` via casts) observe the exact same objects.
  /** Live subprocess handle (owned by {@link LspTransport}). The setter lets a
   *  test subclass inject a fake transport (`self.proc = { stdin }`). */
  protected get proc(): Subprocess<"pipe", "pipe", "pipe"> | null {
    return this.transport.proc
  }
  protected set proc(value: Subprocess<"pipe", "pipe", "pipe"> | null) {
    this.transport.proc = value
  }
  private get exited(): boolean {
    return this.transport.exited
  }
  private set exited(value: boolean) {
    this.transport.exited = value
  }
  private get pending(): Map<number, PendingRequest> {
    return this.correlator.pending
  }
  private get diagnosticsByUri(): Map<string, Diagnostic[]> {
    return this.diagnosticsHub.diagnosticsByUri
  }
  private get diagnosticsWaiters(): Map<string, Array<(d: Diagnostic[]) => void>> {
    return this.diagnosticsHub.diagnosticsWaiters
  }
  private get opened(): Map<string, { version: number; text: string }> {
    return this.documents.opened
  }
  private get command(): string[] {
    return this.transport.command
  }
  private get cwd(): string {
    return this.transport.cwd
  }

  constructor(spec: LspClientSpec, options: LspClientOptions = {}) {
    this.spec = spec
    const command = options.command ?? spec.defaultCommand
    const cwd = options.cwd ?? process.cwd()
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.workspaceFolders = options.workspaceFolders ?? []
    this.workspaceConfiguration = options.workspaceConfiguration ?? {}

    this.transport = new LspTransport(command, cwd, options.processTreeKiller, {
      onMessage: (msg) => this.dispatch(msg),
      isStopped: () => this.stopped,
      failAllPending: (reason) => this.failAllPending(reason),
    })
    this.correlator = new RequestCorrelator({
      requestTimeoutMs: this.requestTimeoutMs,
      isExited: () => this.exited,
      isStopped: () => this.stopped,
      send: (payload) => this.send(payload),
      sendNotification: (method, params) => this.sendNotification(method, params),
    })
    this.diagnosticsHub = new DiagnosticsHub(this.requestTimeoutMs)
    this.documents = new DocumentTracker({
      sendNotification: (method, params) => this.sendNotification(method, params),
      languageIdFor: (filePath) => this.spec.languageIdFor(filePath),
      forgetDiagnostics: (uri) => this.diagnosticsByUri.delete(uri),
    })
  }

  async start(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, "LSP start")
    if (this.proc) return
    this.transport.spawn(() => this.onProcessExit())

    const onAbort = () => {
      void this.stop().catch(() => undefined)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      const init = (await this.sendRequest(
        "initialize",
        {
          processId: process.pid,
          clientInfo: { name: "quanta-codeagent", version: "0.1.0" },
          rootUri: pathToFileURL(this.cwd).href,
          ...(this.workspaceFolders.length > 0
            ? { workspaceFolders: this.workspaceFolders.map((dir) => toWorkspaceFolder(dir)) }
            : {}),
          capabilities: {
            workspace: {
              configuration: true,
              workspaceFolders: true,
            },
            textDocument: {
              publishDiagnostics: { relatedInformation: false },
              synchronization: { didSave: false, dynamicRegistration: false },
              // Advertise call-hierarchy support so spec-strict servers offer the
              // `callHierarchyProvider` (RFC jun-6). Purely additive — no behavior
              // change for diagnostics / the other nav methods.
              callHierarchy: { dynamicRegistration: false },
            },
          },
        },
        signal,
      )) as InitializeResult
      if (init.serverInfo) {
        this.serverInfo = {
          name: init.serverInfo.name,
          ...(init.serverInfo.version !== undefined ? { version: init.serverInfo.version } : {}),
        }
      }
      this.sendNotification("initialized", {})
      // PUSH the settings too (not just answer the pull). pyright (matching the
      // VS Code client) only fully applies `pythonPath` / analysis settings —
      // and therefore only resolves cross-file imports — once it sees a
      // `workspace/didChangeConfiguration`. With the pull-response alone it
      // hangs every request. Skipped when no config is configured (other langs).
      if (Object.keys(this.workspaceConfiguration).length > 0) {
        this.sendNotification("workspace/didChangeConfiguration", {
          settings: this.workspaceConfiguration,
        })
      }
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }
  }

  async diagnostics(filePath: string): Promise<Diagnostic[]> {
    if (!this.proc) throw new Error("LspClient.diagnostics called before start()")
    const uri = pathToFileURL(filePath).href
    const text = await this.readFileText(filePath)

    this.diagnosticsByUri.delete(uri)
    const arrival = this.waitForDiagnostics(uri)
    this.syncOpenDocument(filePath, uri, text)

    const diags = await arrival
    this.sendNotification("textDocument/didClose", { textDocument: { uri } })
    this.opened.delete(uri)
    return diags
  }

  /** Prime a file into the live session without issuing a nav RPC. Useful for
   *  warm-up/readiness paths that want `didOpen` / `didChange` semantics but
   *  choose their own follow-up probe. */
  async prime(filePath: string, signal?: AbortSignal): Promise<void> {
    if (!this.proc) throw new Error("LspClient.prime called before start()")
    await this.ensureOpen(filePath, signal)
  }

  // --- Nav RPC -----------------------------------------------------------
  // Each method:
  //   1. Lazily opens the document (idempotent via {@link opened})
  //   2. Issues the LSP request via {@link sendRequest}
  //   3. Normalizes the wire shape to our `@/lsp/types`
  //   4. Returns `null` for server `null` / "method not supported" results
  // Errors other than "unsupported" (timeout, transport) propagate to the
  // caller — the tool layer decides whether to degrade.

  async definition(filePath: string, pos: Pos, signal?: AbortSignal): Promise<Location[] | null> {
    return this.navLocations(filePath, "textDocument/definition", pos, signal)
  }

  async references(
    filePath: string,
    pos: Pos,
    includeDeclaration: boolean,
    signal?: AbortSignal,
  ): Promise<Location[] | null> {
    const uri = await this.ensureOpen(filePath, signal)
    const raw = await this.callOrNullOnUnsupported(
      "textDocument/references",
      {
        textDocument: { uri },
        position: pos,
        context: { includeDeclaration },
      },
      signal,
    )
    if (raw === null || raw === undefined) return null
    if (!Array.isArray(raw)) return null
    return (raw as RawLocation[]).map(toLocation)
  }

  async hover(filePath: string, pos: Pos, signal?: AbortSignal): Promise<Hover | null> {
    const uri = await this.ensureOpen(filePath, signal)
    const raw = await this.callOrNullOnUnsupported(
      "textDocument/hover",
      {
        textDocument: { uri },
        position: pos,
      },
      signal,
    )
    if (raw === null || raw === undefined) return null
    const h = raw as RawHover
    const contents = flattenHoverContents(h.contents)
    return h.range !== undefined ? { contents, range: toRange(h.range) } : { contents }
  }

  async typeDefinition(
    filePath: string,
    pos: Pos,
    signal?: AbortSignal,
  ): Promise<Location[] | null> {
    return this.navLocations(filePath, "textDocument/typeDefinition", pos, signal)
  }

  async implementation(
    filePath: string,
    pos: Pos,
    signal?: AbortSignal,
  ): Promise<Location[] | null> {
    return this.navLocations(filePath, "textDocument/implementation", pos, signal)
  }

  async documentSymbol(filePath: string, signal?: AbortSignal): Promise<SymbolInfo[] | null> {
    const uri = await this.ensureOpen(filePath, signal)
    const raw = (await this.callOrNullOnUnsupported(
      "textDocument/documentSymbol",
      {
        textDocument: { uri },
      },
      signal,
    )) as RawDocumentSymbolResult | undefined
    if (raw === null || raw === undefined) return null
    if (!Array.isArray(raw) || raw.length === 0) return []
    if (isSymbolInformationList(raw)) return raw.map((s) => mapSymbolInformation(s))
    const out: SymbolInfo[] = []
    for (const s of raw) flattenDocumentSymbol(s, uri, undefined, out)
    return out
  }

  async workspaceSymbol(query: string, signal?: AbortSignal): Promise<SymbolInfo[] | null> {
    const raw = (await this.callOrNullOnUnsupported(
      "workspace/symbol",
      {
        query,
      },
      signal,
    )) as RawWorkspaceSymbolResult | undefined
    if (raw === null || raw === undefined) return null
    if (!Array.isArray(raw)) return null
    if (raw.length === 0) return []
    return raw.map(mapWorkspaceSymbolEntry)
  }

  async prepareRename(
    filePath: string,
    pos: Pos,
    signal?: AbortSignal,
  ): Promise<RenamePreview | null> {
    const uri = await this.ensureOpen(filePath, signal)
    const raw = (await this.callOrNullOnUnsupported(
      "textDocument/prepareRename",
      {
        textDocument: { uri },
        position: pos,
      },
      signal,
    )) as RawPrepareRenameResult | undefined
    if (raw === null || raw === undefined) return null
    if (isRawRange(raw)) return { range: toRange(raw), placeholder: "" }
    if (raw.defaultBehavior === true) return null
    if (raw.range === undefined) return null
    return { range: toRange(raw.range), placeholder: raw.placeholder ?? "" }
  }

  /** Callers of the symbol at `pos` (RFC jun-6). Two-hop:
   *  `prepareCallHierarchy` resolves the position to callable item(s), then
   *  `callHierarchyItem/incomingCalls` per item. `from` is the caller. */
  async incomingCalls(
    filePath: string,
    pos: Pos,
    signal?: AbortSignal,
  ): Promise<CallHierarchyEntry[] | null> {
    return this.callHierarchy(filePath, "callHierarchy/incomingCalls", pos, signal)
  }

  /** Callees invoked by the symbol at `pos`. Same two-hop as
   *  {@link incomingCalls}; `to` is the callee. */
  async outgoingCalls(
    filePath: string,
    pos: Pos,
    signal?: AbortSignal,
  ): Promise<CallHierarchyEntry[] | null> {
    return this.callHierarchy(filePath, "callHierarchy/outgoingCalls", pos, signal)
  }

  /** ADR-0404 (S2) — `textDocument/rename`. Sibling of {@link prepareRename}:
   *  `prepareRename` only PROBES whether the cursor sits on a renameable
   *  identifier; THIS issues the actual rename and returns the
   *  {@link RenameWorkspaceEdit} the server proposes (every file + edit). The
   *  caller (`RenameApplyPort.applyEdit`) commits it via
   *  {@link applyWorkspaceEdit} (2-phase atomic).
   *
   *  Mirrors the nav-RPC posture exactly: lazy-open the document, issue via
   *  `callOrNullOnUnsupported` so a server without the `rename` capability
   *  surfaces as `null` (not a throw), and normalize the wire `WorkspaceEdit`
   *  (legacy `changes` map OR newer `documentChanges` array) to the port
   *  shape. A `null` server payload ⇒ `null`; an empty edit (neither field)
   *  ⇒ `{ changes: [] }` (symbol unused — the tool treats it as a no-op). */
  async computeRename(
    filePath: string,
    pos: Pos,
    newName: string,
    signal?: AbortSignal,
  ): Promise<RenameWorkspaceEdit | null> {
    const uri = await this.ensureOpen(filePath, signal)
    const raw = (await this.callOrNullOnUnsupported(
      "textDocument/rename",
      {
        textDocument: { uri },
        position: pos,
        newName,
      },
      signal,
    )) as RawWorkspaceEdit | undefined
    if (raw === null || raw === undefined) return null
    return toRenameWorkspaceEdit(raw)
  }

  // --- ADR-0143 — wire methods for the 4 expansion ports -----------------
  // Each follows the same posture as the nav RPCs above:
  //   1. lazily open the document
  //   2. issue the request via `callOrNullOnUnsupported` so "method not
  //      supported" surfaces as a `null` result instead of throwing
  //   3. normalize the wire shape to our port types
  // Errors other than "unsupported" (timeout, transport, internal) propagate.

  /** Send `textDocument/codeAction` and normalize the result. `kind` filters
   *  the server's reply (LSP prefix-match); `"all"` (or omission) lets every
   *  kind through. */
  async requestCodeActions(
    file: string,
    line: number,
    col: number,
    kind?: "quickfix" | "refactor" | "source" | "all",
    signal?: AbortSignal,
  ): Promise<readonly CodeAction[] | null> {
    const uri = await this.ensureOpen(file, signal)
    const filter = codeActionFilterFor(kind)
    const params = {
      textDocument: { uri },
      range: pointRange(line, col),
      context: filter === undefined ? { diagnostics: [] } : { diagnostics: [], only: filter },
    }
    const raw = (await this.callOrNullOnUnsupported("textDocument/codeAction", params, signal)) as
      | RawCodeActionResult
      | undefined
    if (raw === null || raw === undefined) return null
    if (!Array.isArray(raw)) return null
    return raw.map(mapCodeAction)
  }

  /** Send `textDocument/formatting` (no range) or `textDocument/rangeFormatting`
   *  (range given). Returns the server's edit list, mapped to port shape. */
  async requestFormatting(
    file: string,
    range?: FormatRange,
    signal?: AbortSignal,
  ): Promise<readonly FormatTextEdit[] | null> {
    const uri = await this.ensureOpen(file, signal)
    const method = range === undefined ? "textDocument/formatting" : "textDocument/rangeFormatting"
    const baseParams = {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    }
    const params = range === undefined ? baseParams : { ...baseParams, range: toRawRange(range) }
    const raw = (await this.callOrNullOnUnsupported(method, params, signal)) as RawTextEdit[] | null
    if (raw === null || raw === undefined) return null
    if (!Array.isArray(raw)) return null
    return raw.map(toFormatTextEdit)
  }

  /** Send `textDocument/signatureHelp`. Returns the active overload list. */
  async requestSignatureHelp(
    file: string,
    line: number,
    col: number,
    signal?: AbortSignal,
  ): Promise<readonly SignatureInfo[] | null> {
    const uri = await this.ensureOpen(file, signal)
    const raw = (await this.callOrNullOnUnsupported(
      "textDocument/signatureHelp",
      {
        textDocument: { uri },
        position: { line, character: col },
      },
      signal,
    )) as RawSignatureHelpResult | undefined
    if (raw === null || raw === undefined) return null
    if (!Array.isArray(raw.signatures)) return []
    return raw.signatures.map(mapSignature)
  }

  /** Apply a workspace edit via the shared 2-phase temp+rename atomic commit
   *  (ADR-0152). The 3-phase core lives in {@link applyWorkspaceEditAtomic};
   *  this binds the client's `protected` FS seams (so test subclasses still
   *  capture / fail-inject without touching disk) and defaults `sessionId`. */
  async applyWorkspaceEdit(
    edit: CodeActionWorkspaceEdit | RenameWorkspaceEdit,
    sessionId: string = randomBytes(8).toString("hex"),
    signal?: AbortSignal,
  ): Promise<void> {
    await applyWorkspaceEditAtomic(
      {
        readFileText: (p) => this.readFileText(p),
        writeFileText: (p, t) => this.writeFileText(p, t),
        renameFile: (from, to) => this.renameFile(from, to),
        unlinkTmp: (p) => this.unlinkTmp(p),
        listDir: (dir) => this.listDir(dir),
      },
      edit,
      sessionId,
      signal,
    )
  }

  /** On-disk write seam (Bun.file/write). Protected so tests can capture the
   *  call without touching the FS — mirrors {@link readFileText}. */
  protected writeFileText(filePath: string, text: string): Promise<unknown> {
    return Bun.write(filePath, text)
  }

  /** Atomic-rename seam (Phase 2 commit). Protected so tests can capture or
   *  fail-inject without touching the FS. POSIX `rename(2)` is atomic on the
   *  same filesystem; cross-FS surfaces as `EXDEV` which we re-throw. */
  protected renameFile(from: string, to: string): Promise<void> {
    return rename(from, to)
  }

  /** Tmp-unlink seam (Phase 1 rollback + Phase 0 cleanup). Protected for
   *  tests; default delegates to `fs.unlink`. */
  protected unlinkTmp(filePath: string): Promise<void> {
    return unlink(filePath)
  }

  /** Directory-scan seam for Phase 0 cleanup. Returns the basenames in `dir`,
   *  or `[]` if the dir is missing / unreadable (silent — Phase 0 is best-
   *  effort and must not block legitimate edits). */
  protected listDir(dir: string): Promise<string[]> {
    return readdir(dir).catch(() => [])
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.transport.rssWatchdog?.stop()
    this.transport.rssWatchdog = null
    const proc = this.proc

    // Close every doc we lazily opened so the server's per-URI state is freed
    // even if the caller never explicitly closed. Done before shutdown so the
    // server is still alive to accept the notifications.
    for (const uri of this.opened.keys()) {
      this.sendNotification("textDocument/didClose", { textDocument: { uri } })
    }
    this.opened.clear()
    // Drop the per-session URI-keyed caches. `clear()` settles waiters immediately
    // so stop does not wait for the diagnostics timeout (C-F12).
    this.diagnosticsHub.clear()

    if (!proc) return

    try {
      if (!this.exited) {
        await this.sendRequest("shutdown", null).catch(() => undefined)
        this.sendNotification("exit", undefined)
      }
    } finally {
      this.failAllPending(new Error("LSP server stopped"))
      // Kill the whole server process tree before closing stdin. Pyright's
      // launcher is a Python wrapper around a Node langserver; closing/killing
      // only the wrapper can reparent the Node child to init and leave it
      // burning CPU. The injected tree killer is structural so @/lsp stays
      // slice-clean; without it this degrades to Bun's direct-child kill.
      this.signalServerProcess(proc, "SIGTERM")
      try {
        proc.stdin?.end()
      } catch {
        // stdin may already be closed
      }
      const exited = await this.transport.waitForProcessExit(proc, LSP_PROCESS_KILL_GRACE_MS)
      if (!exited) this.signalServerProcess(proc, "SIGKILL")
      await proc.exited.catch(() => undefined)
      await this.transport.readPump?.catch(() => undefined)
      await this.transport.stderrPump?.catch(() => undefined)
      this.proc = null
    }
  }

  // --- internals -----------------------------------------------------------

  private waitForDiagnostics(uri: string): Promise<Diagnostic[]> {
    return this.diagnosticsHub.waitForDiagnostics(uri)
  }

  /** Send a JSON-RPC request and resolve with the server's `result`.
   *
   *  Protected to support an in-process test seam: a subclass can override
   *  this to inject canned responses without spawning a real server. Default
   *  implementation correlates by id, bounds the wait by `requestTimeoutMs`,
   *  and rejects with {@link LspRequestError} when the server returns an
   *  error (so callers can inspect the JSON-RPC code). */
  protected sendRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.correlator.sendRequest(method, params, signal)
  }

  /** Send a JSON-RPC notification. Same test-seam rationale as
   *  {@link sendRequest}: subclasses may override to capture sent messages. */
  protected sendNotification(method: string, params: unknown): void {
    const payload =
      params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params }
    this.send(payload)
  }

  /** Read the on-disk text for a document we're about to `didOpen`. Protected
   *  so tests can inject synthetic contents without touching the filesystem. */
  protected readFileText(filePath: string): Promise<string> {
    return Bun.file(filePath).text()
  }

  /** Idempotent `textDocument/didOpen`. The first open sends `didOpen`; later
   *  calls compare the on-disk text and emit `didChange` only when the buffer
   *  actually diverged. */
  private async ensureOpen(filePath: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal, `LSP didOpen "${filePath}"`)
    const uri = pathToFileURL(filePath).href
    const text = await this.readFileText(filePath)
    throwIfAborted(signal, `LSP didOpen "${filePath}"`)
    return this.syncOpenDocument(filePath, uri, text)
  }

  /** Issue a request and convert "method not supported" errors to a `null`
   *  result. Other errors (timeout, transport, malformed params caught by the
   *  server with a non-unsupported code) are re-thrown. */
  private async callOrNullOnUnsupported(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      return await this.sendRequest(method, params, signal)
    } catch (e) {
      if (isUnsupportedError(e)) return null
      throw e
    }
  }

  /** Shared body for `definition` / `typeDefinition` / `implementation`. All
   *  three return the same wire-level union (`Location | Location[] |
   *  LocationLink[] | null`), normalized here to `Location[] | null`. */
  private async navLocations(
    filePath: string,
    method: string,
    pos: Pos,
    signal?: AbortSignal,
  ): Promise<Location[] | null> {
    const uri = await this.ensureOpen(filePath, signal)
    const raw = (await this.callOrNullOnUnsupported(
      method,
      {
        textDocument: { uri },
        position: pos,
      },
      signal,
    )) as RawDefinitionResult | undefined
    if (raw === null || raw === undefined) return null
    if (Array.isArray(raw)) {
      if (raw.length === 0) return []
      return raw.map(toLocationOrLink)
    }
    return [toLocation(raw)]
  }

  /** Shared two-hop body for `incomingCalls` / `outgoingCalls`. First resolves
   *  the position to call-hierarchy item(s) via `textDocument/prepareCallHierarchy`,
   *  then issues `method` (`callHierarchy/incomingCalls|outgoingCalls`) for each
   *  resolved item and flattens.
   *
   *  Result contract (mirrors the nav RPCs):
   *    - prepare returns `null` (server lacks `callHierarchyProvider`) ⇒ `null`.
   *    - prepare returns `[]` (no callable at this position) ⇒ `[]` — we DID
   *      resolve, there was just nothing to query.
   *    - every prepared item is resolved (handles overloads / ambiguity); a
   *      per-item `null` (unsupported resolve) contributes nothing; results are
   *      flattened in item order. */
  private async callHierarchy(
    filePath: string,
    method: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls",
    pos: Pos,
    signal?: AbortSignal,
  ): Promise<CallHierarchyEntry[] | null> {
    const uri = await this.ensureOpen(filePath, signal)
    const items = (await this.callOrNullOnUnsupported(
      "textDocument/prepareCallHierarchy",
      {
        textDocument: { uri },
        position: pos,
      },
      signal,
    )) as RawCallHierarchyItem[] | null | undefined
    if (items === null || items === undefined) return null
    if (!Array.isArray(items) || items.length === 0) return []
    const out: CallHierarchyEntry[] = []
    for (const item of items) {
      const raw = (await this.callOrNullOnUnsupported(method, { item }, signal)) as
        | RawCallHierarchyResult
        | undefined
      if (raw === null || raw === undefined || !Array.isArray(raw)) continue
      for (const edge of raw) {
        const target = "from" in edge ? edge.from : edge.to
        out.push(toCallEntry(target, edge.fromRanges))
      }
    }
    return out
  }

  private send(payload: unknown): Error | null {
    return this.transport.write(payload)
  }

  private signalServerProcess(
    proc: Subprocess<"pipe", "pipe", "pipe">,
    signal: LspProcessTreeSignal,
  ): void {
    this.transport.signalServerProcess(proc, signal)
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      this.resolvePending(msg)
      return
    }
    if (isRequest(msg)) {
      this.onServerRequest(msg)
      return
    }
    if (isNotification(msg) && msg.method === "textDocument/publishDiagnostics") {
      this.onPublishDiagnostics(msg.params)
    }
  }

  private onServerRequest(msg: { id: number | string; method: string; params?: unknown }): void {
    switch (msg.method) {
      case "workspace/configuration": {
        const items = (msg.params as WorkspaceConfigurationParams | undefined)?.items
        const result = Array.isArray(items)
          ? items.map((item) =>
              resolveWorkspaceConfiguration(this.workspaceConfiguration, item.section),
            )
          : []
        this.sendServerResult(msg.id, result)
        return
      }
      case "workspace/workspaceFolders":
        this.sendServerResult(
          msg.id,
          this.workspaceFolders.length > 0
            ? this.workspaceFolders.map((dir) => toWorkspaceFolder(dir))
            : null,
        )
        return
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
      case "workspace/codeLens/refresh":
      case "workspace/diagnostic/refresh":
      case "workspace/inlayHint/refresh":
      case "workspace/inlineValue/refresh":
      case "workspace/semanticTokens/refresh":
        this.sendServerResult(msg.id, null)
        return
      default:
        logger.debug("lsp: unhandled server request", { method: msg.method })
        this.sendServerError(msg.id, -32601, `unsupported client request "${msg.method}"`)
    }
  }

  private resolvePending(msg: JsonRpcResponse): void {
    this.correlator.resolvePending(msg)
  }

  private onPublishDiagnostics(params: unknown): void {
    this.diagnosticsHub.onPublishDiagnostics(params)
  }

  private syncOpenDocument(filePath: string, uri: string, text: string): string {
    return this.documents.syncOpenDocument(filePath, uri, text)
  }

  private sendServerResult(id: number | string, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result })
  }

  private sendServerError(id: number | string, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } })
  }

  /** Process-exit handler (wired into {@link LspTransport.spawn}). Rejects
   *  in-flight requests, waits for the stderr drain, then classifies the exit
   *  by its status for the log level. */
  private async onProcessExit(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    this.exited = true
    this.transport.rssWatchdog?.stop()
    this.transport.rssWatchdog = null
    // Reject in-flight requests FIRST so callers never hang on a dead server.
    this.failAllPending(new Error("LSP server exited"))
    // Then let the stderr drain finish before logging, so the retained tail
    // holds the server's LAST words (its crash/OOM reason) instead of racing
    // the exit event and logging an empty tail.
    await this.transport.stderrPump?.catch(() => undefined)
    // Classify by the EXIT STATUS, never by `this.stopped`: a crash triggers
    // the pool's reactive teardown (`stopClient → stop()`), which sets
    // `stopped=true` — so gating on it would DOWNGRADE the very crash we want to
    // surface (measured jun-21: a pyright OOM logged at debug, invisible). A
    // clean `exit 0`, or the `SIGTERM` our own stop() sends, is expected →
    // debug. Anything else — a non-zero exit (crash) or a signal we did NOT
    // send (SIGKILL ⇒ the kernel OOM-killer; large repos blow past node's
    // default heap) — is a real death worth a WARN with the stderr tail.
    const expected = proc.exitCode === 0 || proc.signalCode === "SIGTERM"
    const detail = {
      command: this.command[0],
      cwd: this.cwd,
      exitCode: proc.exitCode,
      signal: proc.signalCode,
      stderrTail: this.transport.stderrTail.slice(-2_000),
    }
    if (expected) logger.debug("lsp: server exited", detail)
    else logger.warn("lsp: server exited UNEXPECTEDLY", detail)
  }

  private failAllPending(reason: Error): void {
    this.correlator.failAll(reason)
    // Unblock any diagnostics waiters with an empty result so callers that
    // raced a shutdown resolve instead of hanging forever.
    this.diagnosticsHub.failAll()
  }
}
