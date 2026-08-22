/** ADR-0141 / ADR-0143 — default `CodeActionPort` adapter.
 *
 *  Wires the canonical `CodeActionPort` to a `LspClient` (`./base.ts`) via the
 *  `requestCodeActions` / `applyWorkspaceEdit` wire methods added in ADR-0143.
 *  Plane-clean: imports only `./base` + `../ports/code-action-port`. No agent,
 *  permission, tool, or SDK reach.
 *
 *  The constructor takes a duck-typed `LspClient` interface (the subset of
 *  methods this adapter actually calls) so test fakes can satisfy it without
 *  subclassing the full `LspClient`. The real `LspClient` matches it
 *  structurally — no DI plumbing change at call sites. */

import type {
  CodeAction,
  CodeActionKind,
  CodeActionPort,
  CodeActionWorkspaceEdit,
} from "../ports/code-action-port"

/** Subset of `LspClient` consumed by this adapter. The full `LspClient` from
 *  `./base` matches this shape structurally — fakes only need to implement
 *  these two methods. */
export interface CodeActionLspClient {
  requestCodeActions(
    file: string,
    line: number,
    col: number,
    kind?: "quickfix" | "refactor" | "source" | "all",
    signal?: AbortSignal,
  ): Promise<readonly CodeAction[] | null>
  applyWorkspaceEdit(
    edit: CodeActionWorkspaceEdit,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<void>
}

/** Map a port-level `CodeActionKind` (9-value union, dotted form) to the
 *  `LspClient.requestCodeActions` filter (4-value coarse union — LSP uses
 *  prefix-matching so `"refactor"` covers all `refactor.*` kinds). Anything
 *  else (`"other"`, undefined) returns `undefined` ⇒ no filter. */
const toClientFilter = (
  kind: CodeActionKind | undefined,
): "quickfix" | "refactor" | "source" | "all" | undefined => {
  if (kind === undefined) return undefined
  if (kind === "quickfix") return "quickfix"
  if (kind === "refactor" || kind.startsWith("refactor.")) return "refactor"
  if (kind === "source" || kind.startsWith("source.")) return "source"
  // "other" — let server return everything, the port filter is best-effort.
  return undefined
}

export class DefaultCodeActionAdapter implements CodeActionPort {
  constructor(private readonly client: CodeActionLspClient) {}

  async resolveCodeActions(
    file: string,
    line: number,
    col: number,
    kind?: CodeActionKind,
    signal?: AbortSignal,
  ): Promise<readonly CodeAction[] | null> {
    const filter = toClientFilter(kind)
    const actions =
      filter === undefined
        ? await this.client.requestCodeActions(file, line, col, undefined, signal)
        : await this.client.requestCodeActions(file, line, col, filter, signal)
    if (actions === null) return null
    // When the caller asked for a specific port-level kind, narrow further
    // — the wire filter is prefix-coarse (e.g. `"refactor"` covers
    // `refactor.extract`). We do EXACT match per the port contract.
    if (kind === undefined) return actions
    return actions.filter((a) => a.kind === kind)
  }

  async applyEdit(edit: CodeActionWorkspaceEdit, signal?: AbortSignal): Promise<void> {
    await this.client.applyWorkspaceEdit(edit, undefined, signal)
  }
}
