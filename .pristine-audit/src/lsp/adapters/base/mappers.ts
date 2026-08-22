import type {
  CodeAction,
  CodeActionKind,
  CodeActionTextEdit,
  CodeActionWorkspaceEdit,
} from "../../ports/code-action-port"
import type { FormatRange, TextEdit as FormatTextEdit } from "../../ports/format-port"
import type { RenameWorkspaceEdit } from "../../ports/rename-apply-port"
import type { SignatureInfo } from "../../ports/signature-help-port"
import type {
  CallHierarchyEntry,
  Diagnostic,
  Location,
  Pos,
  Range,
  SymbolInfo,
  SymbolKind,
} from "../../types"
import type { JsonRpcMessage, JsonRpcResponse } from "../jsonrpc"
import {
  type RawCallHierarchyItem,
  type RawCodeAction,
  type RawCodeActionEntry,
  type RawCommand,
  type RawDiagnostic,
  type RawDocumentSymbol,
  type RawHoverContents,
  type RawLocation,
  type RawLocationLink,
  type RawMarkedString,
  type RawMarkupContent,
  type RawPrepareRenameObject,
  type RawRange,
  type RawSignatureInformation,
  type RawSymbolInformation,
  type RawTextEdit,
  type RawWorkspaceEdit,
  type RawWorkspaceSymbol,
  SEVERITY,
} from "./raw-types"

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

export const toSymbolKind = (n: number): SymbolKind => SYMBOL_KIND[n] ?? "unknown"

export const abortError = (context: string): Error => {
  const e = new Error(`${context} aborted`)
  e.name = "AbortError"
  return e
}

export const throwIfAborted = (signal: AbortSignal | undefined, context: string): void => {
  if (signal?.aborted) throw abortError(context)
}

export const toPos = (p: { line: number; character: number }): Pos => ({
  line: p.line,
  character: p.character,
})

export const mapDiagnostic = (uri: string, d: RawDiagnostic): Diagnostic => ({
  uri,
  severity: SEVERITY[d.severity ?? 1] ?? "error",
  message: d.message,
  range: { start: toPos(d.range.start), end: toPos(d.range.end) },
  ...(d.source !== undefined ? { source: d.source } : {}),
  ...(d.code !== undefined ? { code: String(d.code) } : {}),
})

export const toRange = (r: RawRange): Range => ({ start: toPos(r.start), end: toPos(r.end) })

export const toLocation = (l: RawLocation): Location => ({ uri: l.uri, range: toRange(l.range) })

/** Map a single hit from `definition`/`typeDefinition`/`implementation`. The
 *  server may emit either a `Location` (uri+range) or a `LocationLink`
 *  (target* fields). `LocationLink.targetSelectionRange` — when present — is
 *  the tighter "navigate-to" range; we prefer it over `targetRange`. */
export const toLocationOrLink = (l: RawLocation | RawLocationLink): Location => {
  if ("uri" in l) return toLocation(l)
  return { uri: l.targetUri, range: toRange(l.targetSelectionRange ?? l.targetRange) }
}

/** Map a resolved `CallHierarchyItem` + its `fromRanges` to our normalized
 *  {@link CallHierarchyEntry}. Pure — reuses the shared `toRange` + `SYMBOL_KIND`
 *  primitives. Missing `fromRanges` collapses to `[]` (some servers omit it for
 *  a 0-call-site edge). */
export const toCallEntry = (
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

export const toFormatTextEdit = (e: RawTextEdit): FormatTextEdit => ({
  range: toRange(e.range),
  newText: e.newText,
})

/** Normalize the two LSP `WorkspaceEdit` variants into a flat per-document
 *  changes list. `documentChanges` wins when both are present (LSP spec). */
export const toCodeActionWorkspaceEdit = (raw: RawWorkspaceEdit): CodeActionWorkspaceEdit => {
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
export const toRenameWorkspaceEdit = (raw: RawWorkspaceEdit): RenameWorkspaceEdit => {
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

export const mapCodeAction = (e: RawCodeActionEntry): CodeAction => {
  if (isCommandOnly(e)) {
    return { title: e.title, kind: "quickfix" }
  }
  const ca = e as RawCodeAction
  const base: CodeAction = { title: ca.title, kind: toCodeActionKind(ca.kind) }
  if (ca.edit !== undefined) base.edit = toCodeActionWorkspaceEdit(ca.edit)
  return base
}

export const mapSignature = (s: RawSignatureInformation): SignatureInfo => {
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
export const codeActionFilterFor = (
  kind: "quickfix" | "refactor" | "source" | "all" | undefined,
): string[] | undefined => {
  if (kind === undefined || kind === "all") return undefined
  return [kind]
}

/** Half-open zero-width range covering the whole document — sent as the
 *  `range` argument to `textDocument/codeAction` when the caller asked at a
 *  single position. We anchor the range at the requested position (not the
 *  file head) so servers that filter by range respect the cursor. */
export const pointRange = (line: number, col: number): RawRange => ({
  start: { line, character: col },
  end: { line, character: col },
})

/** Convert a Format port `range` (or a `Range` from rangeFormatting wire) to
 *  the raw LSP shape with `character` keys. */
export const toRawRange = (r: FormatRange): RawRange => ({
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
export const applyEditsToText = (
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

export const isRawRange = (v: RawRange | RawPrepareRenameObject): v is RawRange =>
  "start" in v && "end" in v

const flattenMarkedString = (m: RawMarkedString): string => (typeof m === "string" ? m : m.value)

const isMarkupContent = (c: RawHoverContents): c is RawMarkupContent =>
  !Array.isArray(c) && typeof c === "object" && "kind" in c && "value" in c

/** Reduce the union `MarkupContent | MarkedString | MarkedString[]` to a
 *  single string. `MarkedString` arrays are newline-joined; legacy
 *  `{language, value}` entries surface their `value` only (we drop the
 *  language tag since downstream tools render the text untyped). */
export const flattenHoverContents = (c: RawHoverContents): string => {
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.map(flattenMarkedString).join("\n")
  if (isMarkupContent(c)) return c.value
  return flattenMarkedString(c)
}

export const isSymbolInformationList = (
  list: RawDocumentSymbol[] | RawSymbolInformation[],
): list is RawSymbolInformation[] => {
  const first = list[0]
  return first !== undefined && "location" in first
}

/** Map an LSP `SymbolInformation`. The legacy form has no separate
 *  selectionRange, so we mirror `range` into both per the type contract. */
export const mapSymbolInformation = (s: RawSymbolInformation): SymbolInfo => {
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
export const flattenDocumentSymbol = (
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
export const mapWorkspaceSymbolEntry = (
  s: RawSymbolInformation | RawWorkspaceSymbol,
): SymbolInfo => {
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

export const isResponse = (m: JsonRpcMessage): m is JsonRpcResponse => "id" in m && !("method" in m)

export const isRequest = (
  m: JsonRpcMessage,
): m is { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown } =>
  "id" in m && "method" in m

export const isNotification = (
  m: JsonRpcMessage,
): m is { jsonrpc: "2.0"; method: string; params?: unknown } => "method" in m && !("id" in m)
