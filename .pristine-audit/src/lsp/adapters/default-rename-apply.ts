/** ADR-0404 (S2) — default `RenameApplyPort` adapter.
 *
 *  Wires the canonical `RenameApplyPort` (`../ports/rename-apply-port`) to a
 *  `LspClient` (`./base.ts`) via two wire methods:
 *    - `computeRename` → `LspClient.computeRename` (the `textDocument/rename`
 *      RPC added in ADR-0404), returning the proposed {@link RenameWorkspaceEdit}.
 *    - `applyEdit`     → `LspClient.applyWorkspaceEdit` (the 2-phase temp+rename
 *      atomic commit completed in ADR-0152) — reused verbatim, never re-implemented.
 *
 *  Two-step (compute THEN apply) so the consuming `lsp_rename_apply` tool can
 *  stream a deterministic preview on its `progress` event and the HITL gate can
 *  clear BEFORE any file is mutated.
 *
 *  Plane-clean: imports only `./base` (type) + `../ports/rename-apply-port`. No
 *  agent / permission / tool / SDK reach. The constructor takes a duck-typed
 *  subset of `LspClient` so test fakes satisfy it without subclassing — the
 *  real `LspClient` matches structurally (no DI plumbing change at call sites),
 *  exactly mirroring {@link DefaultCodeActionAdapter}. */

import type { RenameApplyPort, RenameWorkspaceEdit } from "../ports/rename-apply-port"

/** Subset of `LspClient` consumed by this adapter. The full `LspClient` from
 *  `./base` matches this shape structurally — fakes only need these two methods. */
export interface RenameApplyLspClient {
  computeRename(
    filePath: string,
    pos: { line: number; character: number },
    newName: string,
    signal?: AbortSignal,
  ): Promise<RenameWorkspaceEdit | null>
  applyWorkspaceEdit(
    edit: RenameWorkspaceEdit,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<void>
}

export class DefaultRenameApplyAdapter implements RenameApplyPort {
  constructor(private readonly client: RenameApplyLspClient) {}

  async computeRename(
    file: string,
    line: number,
    col: number,
    newName: string,
    signal?: AbortSignal,
  ): Promise<RenameWorkspaceEdit | null> {
    return this.client.computeRename(file, { line, character: col }, newName, signal)
  }

  async applyEdit(edit: RenameWorkspaceEdit, signal?: AbortSignal): Promise<void> {
    await this.client.applyWorkspaceEdit(edit, undefined, signal)
  }
}
