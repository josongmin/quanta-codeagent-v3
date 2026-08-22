/**
 * `CodeParserPort` (RFC jun-6-syntax-aware-chunking §4.2).
 *
 * The narrow closed surface a syntactic-view backend honours. ONE parse
 * drives BOTH the index-time chunker (`chunkFileSyntactic`) and the
 * read-time outline (`renderOutline`). Sits behind this port so:
 *
 *   - unit tests inject a `fakeParser` (canned `ParsedFile`) — NO real WASM
 *     in the fast unit suite;
 *   - the WASM runtime + grammar init cost stays OFF the test path and OFF
 *     every session that does not opt in (default-OFF knobs);
 *   - a future LSP-backed or napi-backed impl is a clean swap.
 *
 * NO-THROW contract: a parse error / unknown language is surfaced as a
 * typed `{ ok: false }` outcome so the caller falls back to the pure
 * line-window chunker / raw line-range read. The port NEVER throws past its
 * boundary. Pure for a fixed grammar set + input (no clock, no randomness).
 */

/** Languages with a bundled grammar `.wasm` (Phase 1). Detected by file
 *  extension only — a pure closed table. Unknown extension ⇒ no grammar ⇒
 *  `{ ok:false, reason:"no-grammar" }` ⇒ caller falls back. */
export type ParseLang = "typescript" | "tsx" | "javascript" | "python" | "rust" | "go" | "bash"

/** A declaration node lifted out of the AST. 1-based INCLUSIVE line bounds —
 *  matches `FileChunk` + the editor convention every renderer uses. `kind`
 *  mirrors the LSP `SymbolKind` vocabulary (`src/lsp/types.ts`) so the
 *  outline node type is shared with `lsp_document_symbol` downstream. */
export interface DeclNode {
  readonly kind: "function" | "method" | "class" | "interface" | "type" | "enum" | "const" | "other"
  readonly name: string
  /** 1-based inclusive first line of the declaration (signature/header). */
  readonly startLine: number
  /** 1-based inclusive last line of the declaration (closing brace). */
  readonly endLine: number
  /** Last line of the signature/header; the body starts AFTER this line.
   *  For a body-less decl (`const x = 1`) this equals `endLine`. */
  readonly signatureEndLine: number
  /** Nested decls (methods in a class, etc.). Source order. */
  readonly children: readonly DeclNode[]
}

export interface ParsedFile {
  readonly lang: ParseLang
  /** Top-level declarations, recursively populated. Source order. */
  readonly decls: readonly DeclNode[]
}

export type ParseOutcome =
  | { readonly ok: true; readonly parsed: ParsedFile }
  // ⇒ caller falls back to the line-window chunker / raw read. NO-THROW.
  | { readonly ok: false; readonly reason: "no-grammar" | "parse-error" }

export interface CodeParserPort {
  /** Detect lang by `path` extension, parse `text`, return the declaration
   *  tree — OR a typed `no-grammar`/`parse-error` so the caller falls back.
   *  NEVER throws past this boundary. Deterministic for a fixed grammar set
   *  + input (no clock, no randomness). */
  parse(path: string, text: string): Promise<ParseOutcome>
}
