import { randomBytes } from "node:crypto"
import { readdir, rename, unlink } from "node:fs/promises"
import { basename, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Subprocess } from "bun"
import { PUMP_DEATH_EXIT_GRACE_MS } from "@/plugin-isolation"
import { errMessage, logger } from "@/shared"
import type { LspPort } from "../ports"
import type {
  CodeAction,
  CodeActionKind,
  CodeActionTextEdit,
  CodeActionWorkspaceEdit,
} from "../ports/code-action-port"
import type { FormatRange, TextEdit as FormatTextEdit } from "../ports/format-port"
import type { RenameWorkspaceEdit } from "../ports/rename-apply-port"
import type { SignatureInfo } from "../ports/signature-help-port"
import type {
  CallHierarchyEntry,
  Diagnostic,
  DiagnosticSeverity,
  Hover,
  Location,
  LspServerInfo,
  Pos,
  Range,
  RenamePreview,
  SymbolInfo,
  SymbolKind,
} from "../types"
import {
  encodeMessage,
  type JsonRpcError,
  type JsonRpcMessage,
  type JsonRpcResponse,
  MessageReader,
} from "./jsonrpc"

/** A JSON-RPC error raised by a server response. Preserves the wire `code`
 *  so call sites can distinguish "method not supported" (-32601) from other
 *  failures without re-parsing the message. */
export class LspRequestError extends Error {
  readonly code: number
  readonly data?: unknown
  constructor(method: string, err: JsonRpcError) {
    super(`LSP error in "${method}": ${err.message}`)
    this.name = "LspRequestError"
    this.code = err.code
    if (err.data !== undefined) this.data = err.data
  }
}

/** LSP `SymbolKind` numeric → our string union. Anything off-spec → "unknown". */
const SYMBOL_KIND: Record<number, SymbolKind> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum_member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type_parameter",
}

const toSymbolKind = (n: number): SymbolKind => SYMBOL_KIND[n] ?? "unknown"

/** Raw LSP shapes consumed by the nav RPC methods. Kept minimal: we narrow
 *  only the fields we actually map (same pattern as the diagnostics path). */
interface RawLocation {
  uri: string
  range: RawRange
}
interface RawLocationLink {
  targetUri: string
  targetRange: RawRange
  targetSelectionRange?: RawRange
}
type RawDefinitionResult = RawLocation | RawLocation[] | RawLocationLink[] | null
/** LSP `CallHierarchyItem` — the resolved callable returned by
 *  `prepareCallHierarchy` and embedded as `from`/`to` in the incoming/outgoing
 *  responses. We narrow only the fields we map. */
interface RawCallHierarchyItem {
  name: string
  kind: number
  uri: string
  range: RawRange
  selectionRange: RawRange
}
interface RawIncomingCall {
  from: RawCallHierarchyItem
  fromRanges?: RawRange[]
}
interface RawOutgoingCall {
  to: RawCallHierarchyItem
  fromRanges?: RawRange[]
}
type RawCallHierarchyResult = RawIncomingCall[] | RawOutgoingCall[] | null
interface RawMarkupContent {
  kind: "plaintext" | "markdown"
  value: string
}
type RawMarkedString = string | { language: string; value: string }
type RawHoverContents = RawMarkupContent | RawMarkedString | RawMarkedString[]
interface RawHover {
  contents: RawHoverContents
  range?: RawRange
}
interface RawDocumentSymbol {
  name: string
  kind: number
  range: RawRange
  selectionRange: RawRange
  children?: RawDocumentSymbol[]
}
interface RawSymbolInformation {
  name: string
  kind: number
  location: { uri: string; range: RawRange }
  containerName?: string
}
interface RawWorkspaceSymbol {
  name: string
  kind: number
  location: { uri: string; range?: RawRange }
  containerName?: string
}
type RawDocumentSymbolResult = RawDocumentSymbol[] | RawSymbolInformation[] | null
type RawWorkspaceSymbolResult = Array<RawSymbolInformation | RawWorkspaceSymbol> | null
interface RawPrepareRenameObject {
  range?: RawRange
  placeholder?: string
  defaultBehavior?: boolean
}
type RawPrepareRenameResult = RawRange | RawPrepareRenameObject | null

/** Raw shapes for the 3 new wire methods (code-action / format / signatureHelp)
 *  + the WorkspaceEdit `applyEdit` consumes. Kept minimal — narrow only fields
 *  we map (same posture as the nav RPC raw types). */
interface RawTextEdit {
  range: RawRange
  newText: string
}
interface RawCodeAction {
  title: string
  kind?: string
  edit?: RawWorkspaceEdit
}
/** Servers may answer `textDocument/codeAction` with the legacy `Command`
 *  shape (no `edit`). We treat those as `quickfix` with no edit — the model
 *  surfaces the title but cannot apply automatically. */
interface RawCommand {
  title: string
  command: string
}
type RawCodeActionEntry = RawCodeAction | RawCommand
type RawCodeActionResult = RawCodeActionEntry[] | null

/** LSP `WorkspaceEdit`. v1 reads both `changes` (legacy: map of uri → edits)
 *  AND `documentChanges` (newer: array of {textDocument, edits}). Resource ops
 *  (create/rename/delete file) are not surfaced — we ignore them. */
interface RawWorkspaceEdit {
  changes?: Record<string, RawTextEdit[]>
  documentChanges?: RawTextDocumentEdit[]
}
interface RawTextDocumentEdit {
  textDocument: { uri: string; version?: number | null }
  edits?: RawTextEdit[]
}
interface RawParameterInformation {
  label: string | [number, number]
  documentation?: string | RawMarkupContent
}
interface RawSignatureInformation {
  label: string
  documentation?: string | RawMarkupContent
  parameters?: RawParameterInformation[]
  activeParameter?: number | null
}
interface RawSignatureHelp {
  signatures?: RawSignatureInformation[]
  activeSignature?: number | null
  activeParameter?: number | null
}
type RawSignatureHelpResult = RawSignatureHelp | null

/** Detect a "method not supported" JSON-RPC error so the nav RPCs can surface
 *  `null` (capability missing) instead of throwing — per the LspPort contract. */
const isUnsupportedError = (e: unknown): boolean => {
  if (!(e instanceof LspRequestError)) return false
  if (e.code === -32601 || e.code === -32602) return true
  const m = e.message.toLowerCase()
  return m.includes("not supported") || m.includes("unsupported")
}

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
  /** Optional workspace roots advertised during `initialize`. */
  workspaceFolders?: readonly string[]
  /** Client-side config surfaced via `workspace/configuration` requests. */
  workspaceConfiguration?: Readonly<Record<string, unknown>>
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

interface WorkspaceFolder {
  uri: string
  name: string
}

interface WorkspaceConfigurationParams {
  items?: Array<{ section?: string }>
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
  detachAbort?: () => void
}

const SEVERITY: Record<number, DiagnosticSeverity> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
}

const abortError = (context: string): Error => {
  const e = new Error(`${context} aborted`)
  e.name = "AbortError"
  return e
}

const throwIfAborted = (signal: AbortSignal | undefined, context: string): void => {
  if (signal?.aborted) throw abortError(context)
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

const toRange = (r: RawRange): Range => ({ start: toPos(r.start), end: toPos(r.end) })

const toLocation = (l: RawLocation): Location => ({ uri: l.uri, range: toRange(l.range) })

/** Map a single hit from `definition`/`typeDefinition`/`implementation`. The
 *  server may emit either a `Location` (uri+range) or a `LocationLink`
 *  (target* fields). `LocationLink.targetSelectionRange` — when present — is
 *  the tighter "navigate-to" range; we prefer it over `targetRange`. */
const toLocationOrLink = (l: RawLocation | RawLocationLink): Location => {
  if ("uri" in l) return toLocation(l)
  return { uri: l.targetUri, range: toRange(l.targetSelectionRange ?? l.targetRange) }
}

/** Map a resolved `CallHierarchyItem` + its `fromRanges` to our normalized
 *  {@link CallHierarchyEntry}. Pure — reuses the shared `toRange` + `SYMBOL_KIND`
 *  primitives. Missing `fromRanges` collapses to `[]` (some servers omit it for
 *  a 0-call-site edge). */
const toCallEntry = (
  item: RawCallHierarchyItem,
  fromRanges: RawRange[] | undefined,
): CallHierarchyEntry => ({
  name: item.name,
  kind: toSymbolKind(item.kind),
  uri: item.uri,
  range: toRange(item.range),
  selectionRange: toRange(item.selectionRange),
  fromRanges: (fromRanges ?? []).map(toRange),
})

/** Closed set of `CodeActionKind` strings we surface. Anything off-list is
 *  collapsed to `"other"` (same posture as `SymbolKind`'s `"unknown"`). */
const KNOWN_CODE_ACTION_KINDS = new Set<string>([
  "quickfix",
  "refactor",
  "refactor.extract",
  "refactor.inline",
  "refactor.rewrite",
  "source",
  "source.organizeImports",
  "source.fixAll",
])

const toCodeActionKind = (k: string | undefined): CodeActionKind => {
  if (k === undefined) return "quickfix"
  return KNOWN_CODE_ACTION_KINDS.has(k) ? (k as CodeActionKind) : "other"
}

/** Type-narrow guard: a `RawCodeAction` carries (at minimum) a `title` and
 *  may carry an `edit`/`kind`. A `RawCommand` has a `command` string. */
const isCommandOnly = (e: RawCodeActionEntry): e is RawCommand =>
  "command" in e && typeof (e as RawCommand).command === "string" && !("edit" in e)

const flattenParameterLabel = (label: string | [number, number], signature: string): string => {
  if (typeof label === "string") return label
  // [start, end] offset into the signature's `label` (UTF-16 code units per LSP).
  return signature.slice(label[0], label[1])
}

const flattenParameterDoc = (d: string | RawMarkupContent | undefined): string | undefined => {
  if (d === undefined) return undefined
  if (typeof d === "string") return d
  return d.value
}

const toCodeActionTextEdit = (e: RawTextEdit): CodeActionTextEdit => ({
  range: toRange(e.range),
  newText: e.newText,
})

const toFormatTextEdit = (e: RawTextEdit): FormatTextEdit => ({
  range: toRange(e.range),
  newText: e.newText,
})

/** Normalize the two LSP `WorkspaceEdit` variants into a flat per-document
 *  changes list. `documentChanges` wins when both are present (LSP spec). */
const toCodeActionWorkspaceEdit = (raw: RawWorkspaceEdit): CodeActionWorkspaceEdit => {
  if (raw.documentChanges) {
    return {
      changes: raw.documentChanges.map((d) => ({
        uri: d.textDocument.uri,
        edits: (d.edits ?? []).map(toCodeActionTextEdit),
      })),
    }
  }
  if (raw.changes) {
    return {
      changes: Object.entries(raw.changes).map(([uri, edits]) => ({
        uri,
        edits: edits.map(toCodeActionTextEdit),
      })),
    }
  }
  return { changes: [] }
}

/** Normalize the two LSP `WorkspaceEdit` variants into the `RenameWorkspaceEdit`
 *  port shape. Structurally identical to {@link toCodeActionWorkspaceEdit} but
 *  typed to the rename port so `computeRename` returns the exact contract the
 *  `RenameApplyPort` expects (no `as`-cast across the two families). */
const toRenameWorkspaceEdit = (raw: RawWorkspaceEdit): RenameWorkspaceEdit => {
  if (raw.documentChanges) {
    return {
      changes: raw.documentChanges.map((d) => ({
        uri: d.textDocument.uri,
        edits: (d.edits ?? []).map(toCodeActionTextEdit),
      })),
    }
  }
  if (raw.changes) {
    return {
      changes: Object.entries(raw.changes).map(([uri, edits]) => ({
        uri,
        edits: edits.map(toCodeActionTextEdit),
      })),
    }
  }
  return { changes: [] }
}

const mapCodeAction = (e: RawCodeActionEntry): CodeAction => {
  if (isCommandOnly(e)) {
    return { title: e.title, kind: "quickfix" }
  }
  const ca = e as RawCodeAction
  const base: CodeAction = { title: ca.title, kind: toCodeActionKind(ca.kind) }
  if (ca.edit !== undefined) base.edit = toCodeActionWorkspaceEdit(ca.edit)
  return base
}

const mapSignature = (s: RawSignatureInformation): SignatureInfo => {
  const params = (s.parameters ?? []).map((p) => {
    const out: { label: string; documentation?: string } = {
      label: flattenParameterLabel(p.label, s.label),
    }
    const doc = flattenParameterDoc(p.documentation)
    if (doc !== undefined) out.documentation = doc
    return out
  })
  const out: SignatureInfo = {
    label: s.label,
    parameters: params,
  }
  const doc = flattenParameterDoc(s.documentation)
  if (doc !== undefined) out.documentation = doc
  if (s.activeParameter !== undefined) out.activeParameter = s.activeParameter
  return out
}

/** LSP `CodeActionKind` filter mapping for `textDocument/codeAction` params.
 *  "all" omits the filter entirely (server returns every kind). The other
 *  values are passed as-is (prefix-match per LSP spec). */
const codeActionFilterFor = (
  kind: "quickfix" | "refactor" | "source" | "all" | undefined,
): string[] | undefined => {
  if (kind === undefined || kind === "all") return undefined
  return [kind]
}

/** Half-open zero-width range covering the whole document — sent as the
 *  `range` argument to `textDocument/codeAction` when the caller asked at a
 *  single position. We anchor the range at the requested position (not the
 *  file head) so servers that filter by range respect the cursor. */
const pointRange = (line: number, col: number): RawRange => ({
  start: { line, character: col },
  end: { line, character: col },
})

/** Convert a Format port `range` (or a `Range` from rangeFormatting wire) to
 *  the raw LSP shape with `character` keys. */
const toRawRange = (r: FormatRange): RawRange => ({
  start: { line: r.start.line, character: r.start.character },
  end: { line: r.end.line, character: r.end.character },
})

/** Convert a zero-based (line, character) position to a UTF-16 offset in
 *  `text`. Handles `\n` only (LSP positions are line+character, no separator
 *  variant). Character offsets past EOL clamp to the line length — same
 *  behaviour as VS Code's `TextDocument.offsetAt`. */
const positionToOffset = (text: string, line: number, character: number): number => {
  let offset = 0
  let currentLine = 0
  for (let i = 0; i < text.length; i++) {
    if (currentLine === line) {
      const lineEnd = text.indexOf("\n", i)
      const max = lineEnd === -1 ? text.length - i : lineEnd - i
      return offset + Math.min(character, max)
    }
    if (text.charCodeAt(i) === 0x0a) {
      currentLine++
    }
    offset++
  }
  // Past EOF — clamp to file end.
  return text.length
}

/** Apply a list of LSP `TextEdit`s to `text`, returning the patched string.
 *  Edits MUST NOT overlap (LSP spec); we apply them in reverse start-offset
 *  order so earlier edits don't shift later ones' offsets. Stable for ties
 *  (preserves caller-supplied order among edits at the same start position). */
const applyEditsToText = (
  text: string,
  edits: readonly { range: { start: Pos; end: Pos }; newText: string }[],
): string => {
  if (edits.length === 0) return text
  const indexed = edits.map((e, i) => ({
    e,
    i,
    startOff: positionToOffset(text, e.range.start.line, e.range.start.character),
    endOff: positionToOffset(text, e.range.end.line, e.range.end.character),
  }))
  // Sort by start desc; for ties keep the higher original index later (which
  // we apply first since we're walking the sorted array forward and slicing
  // from the back — `[...].sort` is stable in V8/JSC).
  indexed.sort((a, b) => b.startOff - a.startOff || b.i - a.i)
  let out = text
  for (const { startOff, endOff, e } of indexed) {
    out = out.slice(0, startOff) + e.newText + out.slice(endOff)
  }
  return out
}

const isRawRange = (v: RawRange | RawPrepareRenameObject): v is RawRange =>
  "start" in v && "end" in v

const flattenMarkedString = (m: RawMarkedString): string => (typeof m === "string" ? m : m.value)

const isMarkupContent = (c: RawHoverContents): c is RawMarkupContent =>
  !Array.isArray(c) && typeof c === "object" && "kind" in c && "value" in c

/** Reduce the union `MarkupContent | MarkedString | MarkedString[]` to a
 *  single string. `MarkedString` arrays are newline-joined; legacy
 *  `{language, value}` entries surface their `value` only (we drop the
 *  language tag since downstream tools render the text untyped). */
const flattenHoverContents = (c: RawHoverContents): string => {
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.map(flattenMarkedString).join("\n")
  if (isMarkupContent(c)) return c.value
  return flattenMarkedString(c)
}

const isSymbolInformationList = (
  list: RawDocumentSymbol[] | RawSymbolInformation[],
): list is RawSymbolInformation[] => {
  const first = list[0]
  return first !== undefined && "location" in first
}

/** Map an LSP `SymbolInformation`. The legacy form has no separate
 *  selectionRange, so we mirror `range` into both per the type contract. */
const mapSymbolInformation = (s: RawSymbolInformation): SymbolInfo => {
  const range = toRange(s.location.range)
  return {
    name: s.name,
    kind: toSymbolKind(s.kind),
    range,
    selectionRange: range,
    uri: s.location.uri,
    ...(s.containerName !== undefined ? { containerName: s.containerName } : {}),
  }
}

/** Recursive walk of nested `DocumentSymbol` trees into a flat list.
 *  `containerName` is propagated to children as their parent's name; the
 *  owning file URI is stamped on every entry. */
const flattenDocumentSymbol = (
  s: RawDocumentSymbol,
  uri: string,
  parentName: string | undefined,
  out: SymbolInfo[],
): void => {
  out.push({
    name: s.name,
    kind: toSymbolKind(s.kind),
    range: toRange(s.range),
    selectionRange: toRange(s.selectionRange),
    uri,
    ...(parentName !== undefined ? { containerName: parentName } : {}),
  })
  if (s.children) {
    for (const child of s.children) flattenDocumentSymbol(child, uri, s.name, out)
  }
}

/** Map either form of workspace symbol entry into our normalized shape.
 *  `WorkspaceSymbol` is the newer (>=3.17) form that may omit `range`; in
 *  that case we use a zero-width range at the document origin since we have
 *  no better signal without resolving the symbol. */
const mapWorkspaceSymbolEntry = (s: RawSymbolInformation | RawWorkspaceSymbol): SymbolInfo => {
  const rawRange = s.location.range
  const range: Range = rawRange
    ? toRange(rawRange)
    : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
  return {
    name: s.name,
    kind: toSymbolKind(s.kind),
    range,
    selectionRange: range,
    uri: s.location.uri,
    ...(s.containerName !== undefined ? { containerName: s.containerName } : {}),
  }
}

const isResponse = (m: JsonRpcMessage): m is JsonRpcResponse => "id" in m && !("method" in m)

const isRequest = (
  m: JsonRpcMessage,
): m is { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown } =>
  "id" in m && "method" in m

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
  private readonly workspaceFolders: readonly string[]
  private readonly workspaceConfiguration: Readonly<Record<string, unknown>>
  private readonly spec: LspClientSpec

  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null
  private reader = new MessageReader()
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly diagnosticsByUri = new Map<string, Diagnostic[]>()
  private readonly diagnosticsWaiters = new Map<string, Array<(d: Diagnostic[]) => void>>()
  /** Open-document cache for long-lived sessions. Tracks the last synced text
   *  and LSP version so a reused client emits `didChange` instead of serving
   *  stale buffers after an on-disk edit. */
  private readonly opened = new Map<string, { version: number; text: string }>()
  private readPump: Promise<void> | null = null
  private stderrPump: Promise<void> | null = null
  private stopped = false
  private exited = false
  serverInfo: LspServerInfo | null = null

  constructor(spec: LspClientSpec, options: LspClientOptions = {}) {
    this.spec = spec
    this.command = options.command ?? spec.defaultCommand
    this.cwd = options.cwd ?? process.cwd()
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.workspaceFolders = options.workspaceFolders ?? []
    this.workspaceConfiguration = options.workspaceConfiguration ?? {}
  }

  async start(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, "LSP start")
    if (this.proc) return
    this.proc = Bun.spawn(this.command, {
      cwd: this.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.readPump = this.pumpStdout()
    // Drain stderr to completion so a verbose language server (tsserver /
    // Pyright debug output) can never fill the OS stderr pipe (~64KB) and block
    // its own next stderr write — which would stall the stdout JSON-RPC channel
    // and hang every pending request to its `requestTimeoutMs`. Bytes are
    // discarded; this is purely a deadlock guard. Mirrors the stdout pump.
    this.stderrPump = this.drainStderr()
    this.watchExit()

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
            ? { workspaceFolders: this.workspaceFolders.map((dir) => this.toWorkspaceFolder(dir)) }
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

  /** Apply a workspace edit using 2-phase temp+rename atomic commit (ADR-0152,
   *  upgrade of ADR-0143 per-file sequential write).
   *
   *  Phases (per call):
   *    0. **Cleanup** — best-effort scan of each target dir for leftover
   *       `<original>.quanta-tmp-<sessionId>-*` files from prior failed runs;
   *       silently unlinked. Scoped by `sessionId`, so concurrent sessions
   *       don't clobber each other.
   *    1. **Prepare** — for every doc, compute patched text and write to a
   *       sibling tmp file `<original>.quanta-tmp-<sessionId>-<rand>`
   *       (`<rand>` = 4 hex bytes, prevents same-session same-file collisions).
   *       If ANY prepare fails, all already-written tmps are unlinked and the
   *       originating error re-thrown. Originals are NEVER touched in Phase 1.
   *    2. **Commit** — `fs.rename(tmp, target)` per doc. POSIX rename is atomic
   *       on the same filesystem (Linux/macOS); same-FS is the steady-state
   *       assumption (LSP edits hit workspace files which live with their tmps).
   *
   *  Failure model:
   *    - Phase 1 fails ⇒ NO original modified, NO tmp remains.
   *    - Phase 2 fails on file K of N ⇒ files 1..K-1 are committed, file K's
   *      tmp + remaining unrenamed tmps stay on disk under `.quanta-tmp-…`
   *      suffix. Caller can recover via dir scan; we surface a typed error
   *      naming the failed path. Cross-FS rename (EXDEV) is the most likely
   *      Phase 2 cause — that's a follow-up (copy+delete fallback).
   *
   *  Concurrency: the random hex suffix means two parallel calls editing the
   *  same file under the same `sessionId` get distinct tmps; neither clobbers
   *  the other's prepare buffer. Default `sessionId` is per-call random, so
   *  callers that don't pass one are naturally isolated. */
  async applyWorkspaceEdit(
    edit: CodeActionWorkspaceEdit | RenameWorkspaceEdit,
    sessionId: string = randomBytes(8).toString("hex"),
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal, "LSP applyWorkspaceEdit")
    // Resolve URIs to paths once; reuse across all 3 phases.
    const resolved = edit.changes.map((doc) => ({
      path: fileURLToPath(doc.uri),
      edits: doc.edits,
    }))

    // --- Phase 0 — best-effort cleanup of leftover tmps from prior runs ---
    // Scoped by sessionId so a concurrent session's in-flight tmps survive.
    // Errors here are intentionally swallowed: a stale-tmp scan must NEVER
    // block a legitimate edit (e.g. dir missing → caller will fail in Phase 1
    // with a clearer error than "couldn't list dir for cleanup").
    const cleanupDirs = new Set(resolved.map((d) => dirname(d.path)))
    for (const dir of cleanupDirs) {
      throwIfAborted(signal, "LSP applyWorkspaceEdit")
      await this.cleanupStaleTmps(dir, sessionId)
    }

    // --- Phase 1 — prepare: write all tmps before touching any original. ---
    const prepared: { tmp: string; target: string }[] = []
    try {
      for (const { path, edits } of resolved) {
        throwIfAborted(signal, "LSP applyWorkspaceEdit")
        const original = await this.readFileText(path)
        const patched = applyEditsToText(original, edits)
        const tmp = `${path}.quanta-tmp-${sessionId}-${randomBytes(4).toString("hex")}`
        await this.writeFileText(tmp, patched)
        prepared.push({ tmp, target: path })
      }
    } catch (e) {
      // Phase 1 failure ⇒ unlink every tmp we wrote so far; no original touched.
      for (const { tmp } of prepared) {
        await this.unlinkTmp(tmp).catch(() => undefined)
      }
      throw e
    }

    // --- Phase 2 — commit: atomic rename per file (same-FS POSIX). ---
    // If rename K fails: files 1..K-1 are committed; K and later tmps remain
    // on disk under `.quanta-tmp-<sessionId>-*`. Caller can scan + recover.
    for (let i = 0; i < prepared.length; i++) {
      const entry = prepared[i]
      if (!entry) continue
      throwIfAborted(signal, "LSP applyWorkspaceEdit")
      try {
        await this.renameFile(entry.tmp, entry.target)
      } catch (e) {
        const remaining = prepared.length - i
        const err = new Error(
          `LSP applyWorkspaceEdit Phase 2 (commit) failed on "${entry.target}" ` +
            `(${i}/${prepared.length} files renamed, ${remaining} tmp file(s) remain): ${errMessage(
              e,
            )}`,
        )
        throw err
      }
    }
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

  /** Best-effort sweep of `<dir>` for leftover tmps from prior `sessionId`
   *  runs. Pattern: any entry matching `*.quanta-tmp-<sessionId>-*` is
   *  unlinked. Errors per-entry are swallowed (file may already be gone or
   *  owned by another process). */
  private async cleanupStaleTmps(dir: string, sessionId: string): Promise<void> {
    const entries = await this.listDir(dir)
    const marker = `.quanta-tmp-${sessionId}-`
    for (const name of entries) {
      // Match the marker anywhere after the original-filename portion. The
      // suffix is always `<original>.quanta-tmp-<sessionId>-<hex>` so we look
      // for the marker substring; presence ⇒ this is our tmp.
      if (!name.includes(marker)) continue
      const full = `${dir}/${basename(name)}`
      await this.unlinkTmp(full).catch(() => undefined)
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    const proc = this.proc

    // Close every doc we lazily opened so the server's per-URI state is freed
    // even if the caller never explicitly closed. Done before shutdown so the
    // server is still alive to accept the notifications.
    for (const uri of this.opened.keys()) {
      this.sendNotification("textDocument/didClose", { textDocument: { uri } })
    }
    this.opened.clear()

    if (!proc) return

    try {
      if (!this.exited) {
        await this.sendRequest("shutdown", null).catch(() => undefined)
        this.sendNotification("exit", undefined)
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
      await this.stderrPump?.catch(() => undefined)
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

  /** Send a JSON-RPC request and resolve with the server's `result`.
   *
   *  Protected to support an in-process test seam: a subclass can override
   *  this to inject canned responses without spawning a real server. Default
   *  implementation correlates by id, bounds the wait by `requestTimeoutMs`,
   *  and rejects with {@link LspRequestError} when the server returns an
   *  error (so callers can inspect the JSON-RPC code). */
  protected sendRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++
    const payload =
      params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params }
    return new Promise<unknown>((resolve, reject) => {
      // Lifecycle guard: if the server has already exited or we've stopped,
      // reject immediately instead of registering a pending entry whose
      // `send()` would silently no-op (stdin gone) and only fail on timeout —
      // a needless `requestTimeoutMs` hang. Mirrors McpClient.request().
      // `shutdown` is exempt: stop() issues it after setting `stopped`.
      if ((this.exited || this.stopped) && method !== "shutdown") {
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
        reject(new Error(`LSP request "${method}" timed out after ${this.requestTimeoutMs}ms`))
      }, this.requestTimeoutMs)
      const entry: PendingRequest = { resolve, reject, timer, method }
      if (signal) {
        const onAbort = () => {
          if (!this.takePending(id)) return
          this.sendNotification("$/cancelRequest", { id })
          reject(abortError(`LSP request "${method}"`))
        }
        signal.addEventListener("abort", onAbort, { once: true })
        entry.detachAbort = () => signal.removeEventListener("abort", onAbort)
      }
      this.pending.set(id, entry)
      const sendError = this.send(payload)
      if (sendError) {
        const pending = this.takePending(id)
        if (!pending) return
        pending.reject(sendError)
      }
    })
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
    const stdin = this.proc?.stdin
    if (!stdin) {
      const err = new Error("LSP transport unavailable: stdin closed")
      logger.warn("lsp: failed to write to server stdin", { error: err.message })
      return err
    }
    try {
      stdin.write(encodeMessage(payload))
      return null
    } catch (e) {
      const err = e instanceof Error ? e : new Error(errMessage(e))
      logger.warn("lsp: failed to write to server stdin", { error: err.message })
      return new Error(`LSP transport write failed: ${err.message}`)
    }
  }

  private async pumpStdout(): Promise<void> {
    const proc = this.proc
    const stdout = proc?.stdout
    if (!proc || !stdout) return
    let pumpError: unknown = null
    try {
      for await (const chunk of stdout) {
        for (const msg of this.reader.push(chunk)) {
          this.dispatch(msg)
        }
      }
    } catch (e) {
      pumpError = e
    }
    const detail = pumpError === null ? "stdout closed (EOF)" : errMessage(pumpError)
    // A natural server exit closes stdout (settling this pump) BEFORE Bun sets
    // `proc.exitCode` and fans out `proc.exited` — by MORE than one microtask
    // (EOF can beat the exit by a full macrotask hop). Judging liveness with no
    // yield therefore misfires the "stdout pump died" warn on EVERY normal
    // shutdown. Run the SAME bounded exit-settlement race the Bun spawner and
    // the MCP stdio transport use (shared {@link PUMP_DEATH_EXIT_GRACE_MS})
    // before judging: a natural/killed exit wins in sub-millisecond and stays
    // quiet; a genuine wedge (stdout closed, server alive forever) times out
    // and still warns.
    if (typeof proc.exitCode !== "number" && !proc.killed) {
      await Promise.race([
        proc.exited.catch(() => undefined),
        new Promise<void>((r) => {
          setTimeout(r, PUMP_DEATH_EXIT_GRACE_MS).unref?.()
        }),
      ])
    }
    // A pump that ends during a deliberate stop() or after process death is
    // routine — stop()/watchExit() already fail the pending set. Otherwise the
    // read channel died while the server process still LIVES: the client is
    // half-dead and every pending + future request would silently burn its full
    // `requestTimeoutMs`. Mirror send()'s warn and propagate the same
    // exit/fail-pending the process-death path takes. A clean early EOF and a
    // stream error are the same defect from the caller's view — both land here.
    if (this.stopped || this.exited || proc.exitCode !== null || proc.killed) {
      logger.debug("lsp: stdout pump ended", { error: detail })
      return
    }
    logger.warn("lsp: stdout pump died while the server process is alive", { error: detail })
    this.exited = true
    this.failAllPending(new Error(`LSP transport read channel closed: ${detail}`))
  }

  /** Background drain of the server's stderr. A verbose server (tsserver /
   *  Pyright debug logs) that fills the OS stderr pipe would block on its next
   *  stderr write, stop answering stdout JSON-RPC, and hang every pending
   *  request to timeout. Reading to completion keeps the pipe empty; bytes are
   *  discarded (deadlock guard, not a diagnostics sink). Tolerant of a test
   *  subclass whose `proc` has no stderr (same guard as {@link pumpStdout}). */
  private async drainStderr(): Promise<void> {
    const stderr = this.proc?.stderr
    if (!stderr || typeof stderr === "number") return
    try {
      for await (const _ of stderr) {
        // discard — purpose is to keep the pipe empty so the server never blocks
      }
    } catch (e) {
      logger.debug("lsp: stderr drain ended", { error: errMessage(e) })
    }
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

  private onServerRequest(msg: {
    id: number | string
    method: string
    params?: unknown
  }): void {
    switch (msg.method) {
      case "workspace/configuration": {
        const items = (msg.params as WorkspaceConfigurationParams | undefined)?.items
        const result = Array.isArray(items)
          ? items.map((item) => this.resolveWorkspaceConfiguration(item.section))
          : []
        this.sendServerResult(msg.id, result)
        return
      }
      case "workspace/workspaceFolders":
        this.sendServerResult(
          msg.id,
          this.workspaceFolders.length > 0
            ? this.workspaceFolders.map((dir) => this.toWorkspaceFolder(dir))
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
    const id = typeof msg.id === "number" ? msg.id : Number(msg.id)
    const entry = this.takePending(id)
    if (!entry) return
    if (msg.error) {
      entry.reject(new LspRequestError(entry.method, msg.error))
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

  private syncOpenDocument(filePath: string, uri: string, text: string): string {
    const existing = this.opened.get(uri)
    if (!existing) {
      this.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: this.spec.languageIdFor(filePath), version: 1, text },
      })
      this.opened.set(uri, { version: 1, text })
      return uri
    }
    if (existing.text === text) return uri
    const version = existing.version + 1
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    })
    this.opened.set(uri, { version, text })
    return uri
  }

  private resolveWorkspaceConfiguration(section: string | undefined): unknown {
    if (!section || section.length === 0) return this.workspaceConfiguration
    let cur: unknown = this.workspaceConfiguration
    for (const part of section.split(".")) {
      if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return null
      cur = (cur as Record<string, unknown>)[part]
    }
    return cur ?? null
  }

  private toWorkspaceFolder(dir: string): WorkspaceFolder {
    const name = basename(dir)
    return { uri: pathToFileURL(dir).href, name: name.length > 0 ? name : dir }
  }

  private sendServerResult(id: number | string, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result })
  }

  private sendServerError(id: number | string, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } })
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
      entry.detachAbort?.()
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

  private takePending(id: number): PendingRequest | undefined {
    const entry = this.pending.get(id)
    if (!entry) return undefined
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.detachAbort?.()
    return entry
  }
}
