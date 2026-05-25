/** ADR-0141 — `CodeActionPort`. Provider-agnostic contract for resolving the
 *  LSP `textDocument/codeAction` list at a position and applying the chosen
 *  workspace edit. Kept in its OWN file (`src/lsp/ports/`) so the existing
 *  `src/lsp/ports.ts` (= `LspPort`, ADR-0015) stays untouched — additive
 *  expansion, no churn on the in-flight nav contract.
 *
 *  Shape mirrors how the hellgate tests' in-memory fakes drive the tool:
 *
 *    interface CodeActionPort {
 *      resolveCodeActions(file, line, col, kind?): Promise<readonly CodeAction[] | null>
 *      applyEdit(edit): Promise<void>
 *    }
 *
 *  `null` from {@link resolveCodeActions} = server returned no payload (capability
 *  unsupported or no answer). `[]` = ran cleanly, no actions available.
 *
 *  Plane-clean: this file imports NOTHING from `@/agent`, `@/permission`, or the
 *  SDK; it lives next to its sibling ports under `@/lsp/ports/`. */

/** Zero-based LSP position (mirrors `Pos` from `../types.ts`, re-declared here
 *  so the new ports directory is self-contained and can ship before the rest of
 *  the slice converges on a single location). */
export interface CodeActionPos {
  line: number
  character: number
}

/** Half-open zero-based range. */
export interface CodeActionRange {
  start: CodeActionPos
  end: CodeActionPos
}

/** A single text edit inside one document (file URI). Multiple edits in the
 *  same document are applied as a unit. */
export interface CodeActionTextEdit {
  range: CodeActionRange
  newText: string
}

/** Per-document edit bundle inside a {@link CodeActionWorkspaceEdit}. The
 *  document URI is the canonical `file://` form. */
export interface CodeActionDocumentEdit {
  uri: string
  edits: readonly CodeActionTextEdit[]
}

/** A workspace edit — the wire shape `applyEdit` consumes. Today only `changes`
 *  (per-document edits) is modeled; rename/create/delete file operations are an
 *  intentional follow-up (LSP `WorkspaceEdit.documentChanges`). */
export interface CodeActionWorkspaceEdit {
  changes: readonly CodeActionDocumentEdit[]
}

/** A subset of LSP `CodeActionKind` we surface. We intentionally model only the
 *  most common buckets — anything off-list is mapped to `"other"` rather than
 *  leaking raw strings. */
export type CodeActionKind =
  | "quickfix"
  | "refactor"
  | "refactor.extract"
  | "refactor.inline"
  | "refactor.rewrite"
  | "source"
  | "source.organizeImports"
  | "source.fixAll"
  | "other"

/** A single code-action option, as surfaced by the model. `edit` is OPTIONAL
 *  because some actions resolve their edit lazily (LSP `codeAction/resolve`);
 *  v1 of our port REQUIRES the adapter to have resolved the edit before
 *  returning so the model sees actionable content. */
export interface CodeAction {
  title: string
  kind: CodeActionKind
  edit?: CodeActionWorkspaceEdit
}

/** Provider-agnostic contract for the `lsp_code_action` tool. */
export interface CodeActionPort {
  /** Resolve all code actions the server offers at `file:line:col`. When
   *  `kind` is provided, the result is filtered to actions whose kind matches
   *  (exact match — kind-prefix filtering is the server's job).
   *
   *  Returns `null` when the server has no `textDocument/codeAction` capability
   *  (or returned a null payload). Returns `[]` when the server ran cleanly but
   *  offered no actions at that position. */
  resolveCodeActions(
    file: string,
    line: number,
    col: number,
    kind?: CodeActionKind,
    signal?: AbortSignal,
  ): Promise<readonly CodeAction[] | null>
  /** Apply a previously-resolved workspace edit. Throws on failure — the tool
   *  catches and converts to a typed `ok:false` result. */
  applyEdit(edit: CodeActionWorkspaceEdit, signal?: AbortSignal): Promise<void>
}
