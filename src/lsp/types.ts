/** Domain types for the LSP slice.
 *
 *  Positions follow the Language Server Protocol convention: both `line` and
 *  `character` are ZERO-BASED. Line 0 is the first line of the file; character
 *  0 is the position before the first code unit on that line. Callers that
 *  want 1-based display coordinates must add 1 themselves. */
export interface Pos {
  /** Zero-based line number (LSP convention). */
  line: number
  /** Zero-based UTF-16 character offset within the line (LSP convention). */
  character: number
}

/** Half-open zero-based range. Identical to LSP `Range`. */
export interface Range {
  start: Pos
  end: Pos
}

/** Document location: a range inside a specific document URI. */
export interface Location {
  uri: string
  range: Range
}

/** A subset of LSP `SymbolKind` we surface. We map unknowns to `"unknown"`
 *  instead of leaking raw numeric kinds — consumers stay textual. */
export type SymbolKind =
  | "file"
  | "module"
  | "namespace"
  | "package"
  | "class"
  | "method"
  | "property"
  | "field"
  | "constructor"
  | "enum"
  | "interface"
  | "function"
  | "variable"
  | "constant"
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "key"
  | "null"
  | "enum_member"
  | "struct"
  | "event"
  | "operator"
  | "type_parameter"
  | "unknown"

/** A document symbol (document outline) or workspace symbol (cross-file).
 *  For document symbols, `containerName`/`uri` may be omitted; for workspace
 *  symbols, `uri` is always present and identifies the owning file. */
export interface SymbolInfo {
  name: string
  kind: SymbolKind
  /** Full enclosing range of the symbol (declaration + body). */
  range: Range
  /** The identifier-only range, used for navigation/selection. */
  selectionRange: Range
  /** Owning file URI. Always set for workspace symbols; may be set for
   *  document symbols (we always populate it). */
  uri?: string
  /** Enclosing symbol name (e.g. class for a method). */
  containerName?: string
}

/** Hover content. `contents` is the rendered markdown/plaintext the server
 *  emitted (we flatten LSP `MarkupContent`/`MarkedString` arrays into one
 *  string). `range` covers the token the hover applies to, when supplied. */
export interface Hover {
  contents: string
  range?: Range
}

/** Outcome of a `prepareRename` request. `placeholder` is the suggested new
 *  name initial value (often the current identifier). `null` from the server
 *  means rename is not supported at this position; we surface that as the
 *  enclosing function returning `null`. */
export interface RenamePreview {
  range: Range
  placeholder: string
}

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint"

/** A single language-server diagnostic, normalized away from raw LSP wire
 *  shapes so consumers never depend on protocol details. */
export interface Diagnostic {
  /** Document URI the diagnostic applies to (e.g. `file:///abs/path.py`). */
  uri: string
  severity: DiagnosticSeverity
  message: string
  /** Half-open range using zero-based {@link Pos} coordinates. */
  range: Range
  /** Originating sub-system inside the server (e.g. `Pyright`). */
  source?: string
  /** Server-defined rule/diagnostic code, stringified for stability. */
  code?: string
}

/** Identifying metadata reported by a language server during `initialize`. */
export interface LspServerInfo {
  name: string
  version?: string
}
