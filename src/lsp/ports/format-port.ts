/** ADR-0141 — `FormatPort`. Provider-agnostic contract for
 *  `textDocument/formatting` (whole file) and `textDocument/rangeFormatting`
 *  (selection). The port returns a list of {@link TextEdit}s — the tool is
 *  responsible for applying or surfacing them.
 *
 *  Plane-clean: imports nothing from `@/agent`, `@/permission`, or the SDK. */

/** Zero-based LSP position (kept local for self-containment, matches
 *  `CodeActionPos` / `Pos` from sibling ports / `../types.ts`). */
export interface FormatPos {
  line: number
  character: number
}

/** Half-open zero-based range. */
export interface FormatRange {
  start: FormatPos
  end: FormatPos
}

/** Single text edit returned by `format`. The tool surfaces both the textual
 *  diff and (when the adapter supports it) applies them in place; the port
 *  itself just returns the edits — composition stays in the tool. */
export interface TextEdit {
  range: FormatRange
  newText: string
}

/** Provider-agnostic format contract. `range` absent ⇒ whole-file formatting
 *  (LSP `textDocument/formatting`). Returns `null` when the server has no
 *  formatting capability — `[]` means "ran cleanly, file already formatted /
 *  no changes". */
export interface FormatPort {
  format(file: string, range?: FormatRange): Promise<readonly TextEdit[] | null>
}
