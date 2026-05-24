/** ADR-0141 — `RenameApplyPort`. The existing `LspPort.prepareRename` (ADR-0015)
 *  only PROBES whether the cursor is on a renameable identifier and returns the
 *  placeholder + selection range. This sibling port issues the actual
 *  `textDocument/rename` request, returning the {@link RenameWorkspaceEdit}
 *  the server proposes, AND applies it.
 *
 *  Two-step (compute then apply) so the tool can stream a deterministic preview
 *  on its `progress` event before mutating the workspace — the operator HITL
 *  gate sits between, by the time `applyEdit` fires the action is approved.
 *
 *  Plane-clean: imports nothing from `@/agent`, `@/permission`, or the SDK. */

/** Zero-based LSP position (mirrors `Pos`, kept local for self-containment). */
export interface RenamePos {
  line: number
  character: number
}

/** Half-open zero-based range. */
export interface RenameRange {
  start: RenamePos
  end: RenamePos
}

/** A single text edit inside one document. */
export interface RenameTextEdit {
  range: RenameRange
  newText: string
}

/** Per-document bundle inside a workspace edit. */
export interface RenameDocumentEdit {
  uri: string
  edits: readonly RenameTextEdit[]
}

/** Workspace-wide rename edit. Today only `changes` is modeled (per-document
 *  edits); resource-level ops are an intentional follow-up. */
export interface RenameWorkspaceEdit {
  changes: readonly RenameDocumentEdit[]
}

/** Provider-agnostic rename-apply contract. */
export interface RenameApplyPort {
  /** Compute the workspace edit the rename would produce, without applying it.
   *  Returns `null` when the server has no `textDocument/rename` capability
   *  (or returned no payload). Returns an empty `changes` array when the
   *  rename is a no-op (rare; usually means the symbol is unused). */
  computeRename(
    file: string,
    line: number,
    col: number,
    newName: string,
  ): Promise<RenameWorkspaceEdit | null>
  /** Apply a previously-computed workspace edit. Throws on failure — the tool
   *  catches and converts to a typed `ok:false` result. */
  applyEdit(edit: RenameWorkspaceEdit): Promise<void>
}
