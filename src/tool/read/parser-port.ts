/** Structural syntax tree consumed by the read-outline renderer. */
export interface ReadOutlineDecl {
  readonly startLine: number
  readonly endLine: number
  readonly signatureEndLine: number
  readonly children: readonly ReadOutlineDecl[]
}

/** Minimal parser result shape needed by `read`; concrete AST ownership stays host-side. */
export interface ReadOutlineParsedFile {
  /** Optional parser language tag retained for compatibility; the renderer does not inspect it. */
  readonly lang?: string
  readonly decls: readonly ReadOutlineDecl[]
}

export type ReadOutlineParseFailure =
  | "unsupported-language"
  | "missing-grammar"
  | "no-grammar"
  | "parse-error"

export type ReadOutlineParseOutcome =
  | { readonly ok: true; readonly parsed: ReadOutlineParsedFile }
  | { readonly ok: false; readonly reason: ReadOutlineParseFailure }

/** Host-injected parser port. `@/tool` remains independent of `@/retrieval`. */
export interface ReadOutlineParserPort {
  parse(path: string, text: string): Promise<ReadOutlineParseOutcome>
}
