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

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint"

/** A single language-server diagnostic, normalized away from raw LSP wire
 *  shapes so consumers never depend on protocol details. */
export interface Diagnostic {
  /** Document URI the diagnostic applies to (e.g. `file:///abs/path.py`). */
  uri: string
  severity: DiagnosticSeverity
  message: string
  /** Half-open range using zero-based {@link Pos} coordinates. */
  range: { start: Pos; end: Pos }
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
