import type {
  CallHierarchyEntry,
  Diagnostic,
  Hover,
  Location,
  Pos,
  RenamePreview,
  SymbolInfo,
} from "./types"

/** Provider-agnostic contract for a language-server client.
 *
 *  Lifecycle: {@link start} brings the server up and completes the LSP
 *  handshake; the per-feature methods open documents lazily and return the
 *  server's response; {@link stop} shuts the server down cleanly and releases
 *  every resource (process, timers, listeners). Implementations must be safe
 *  to {@link stop} even if {@link start} failed or never ran.
 *
 *  Nav methods (Codex `may-20-codex-lsp.md` absorption — ADR-0015):
 *  every nav method returns `null` when the server reports the capability as
 *  unsupported / returns a `null` payload. An empty array (`[]`) means the
 *  feature ran but had no results. This split lets callers distinguish "not
 *  supported here" from "no hits" without leaking LSP wire shapes. */
export interface LspPort {
  start(): Promise<void>
  diagnostics(filePath: string): Promise<Diagnostic[]>
  /** Resolve the symbol at `pos` to its defining location(s). `null` = server
   *  did not return a payload (capability unsupported / no answer). */
  definition(filePath: string, pos: Pos): Promise<Location[] | null>
  /** Find references to the symbol at `pos`. `includeDeclaration` toggles
   *  whether the declaration itself is included. */
  references(filePath: string, pos: Pos, includeDeclaration: boolean): Promise<Location[] | null>
  /** Type/signature summary for the symbol at `pos`. */
  hover(filePath: string, pos: Pos): Promise<Hover | null>
  /** Owner of the *type* of the symbol at `pos` (distinct from `definition`
   *  for typed languages — e.g. the receiver's interface vs its concrete impl). */
  typeDefinition(filePath: string, pos: Pos): Promise<Location[] | null>
  /** Concrete implementation(s) of the symbol at `pos`. */
  implementation(filePath: string, pos: Pos): Promise<Location[] | null>
  /** File outline (top-level + nested symbols). */
  documentSymbol(filePath: string): Promise<SymbolInfo[] | null>
  /** Repo-wide symbol search by name fragment. */
  workspaceSymbol(query: string): Promise<SymbolInfo[] | null>
  /** Probe whether the symbol at `pos` is renameable; returns the suggested
   *  placeholder and selection range, or `null` when the server refuses. */
  prepareRename(filePath: string, pos: Pos): Promise<RenamePreview | null>
  /** Callers of the symbol at `pos` (LSP `callHierarchy/incomingCalls`). Each
   *  entry is one calling function plus the exact call-site ranges inside it.
   *  `null` = server has no `callHierarchyProvider` / returned null. `[]` = no
   *  callers (the symbol resolved but nothing calls it). */
  incomingCalls(
    filePath: string,
    pos: Pos,
    signal?: AbortSignal,
  ): Promise<CallHierarchyEntry[] | null>
  /** Callees invoked by the symbol at `pos` (`callHierarchy/outgoingCalls`).
   *  `null` / `[]` carry the same meaning as {@link incomingCalls}. */
  outgoingCalls(
    filePath: string,
    pos: Pos,
    signal?: AbortSignal,
  ): Promise<CallHierarchyEntry[] | null>
  stop(): Promise<void>
}
