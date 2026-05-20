/** LSP-nav tool slice contract (Codex `may-20-codex-lsp.md` absorption
 *  — ADR-0015).
 *
 *  Slice isolation (RFC §3.1, enforced by biome): `@/tool` MUST NOT import
 *  `@/lsp`. So this module owns no LSP knowledge; it talks to an injected
 *  {@link LspNavProvider}. The real provider that knows about pyright /
 *  typescript-language-server is assembled in `src/agent/lsp-bridge.ts` (the
 *  agent slice is the only assembler allowed to cross slices — exactly how
 *  `mcp-bridge.ts` and the diagnostics tool do it). This keeps the tools
 *  unit-testable with a fake provider in the normal gate (no real server
 *  needed). */

/** Zero-based LSP position (mirrors `@/lsp`'s `Pos`, declared here so this
 *  slice is import-free against `@/lsp`). */
export interface NavPos {
  line: number
  character: number
}

/** Half-open zero-based range. */
export interface NavRange {
  start: NavPos
  end: NavPos
}

/** Document location: a range inside a specific document URI. */
export interface NavLocation {
  uri: string
  range: NavRange
}

/** Subset of LSP `SymbolKind` we surface as textual values. Structurally
 *  compatible with `@/lsp`'s `SymbolKind`. */
export type NavSymbolKind =
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

export interface NavSymbolInfo {
  name: string
  kind: NavSymbolKind
  range: NavRange
  selectionRange: NavRange
  uri?: string
  containerName?: string
}

export interface NavHover {
  contents: string
  range?: NavRange
}

export interface NavRenamePreview {
  range: NavRange
  placeholder: string
}

/**
 * Long-lived navigation session for a single language server connection. The
 * concrete provider picks the server by the FILE that opened the session;
 * every method receives the absolute file path so callers can navigate across
 * multiple files within the same language. `null` from any method means the
 * underlying server did not return a payload (unsupported / no answer);
 * `[]` (for list-returning methods) means "ran, no results".
 */
export interface LspNavSession {
  definition(filePath: string, pos: NavPos): Promise<NavLocation[] | null>
  references(
    filePath: string,
    pos: NavPos,
    includeDeclaration: boolean,
  ): Promise<NavLocation[] | null>
  hover(filePath: string, pos: NavPos): Promise<NavHover | null>
  typeDefinition(filePath: string, pos: NavPos): Promise<NavLocation[] | null>
  implementation(filePath: string, pos: NavPos): Promise<NavLocation[] | null>
  documentSymbol(filePath: string): Promise<NavSymbolInfo[] | null>
  workspaceSymbol(query: string): Promise<NavSymbolInfo[] | null>
  prepareRename(filePath: string, pos: NavPos): Promise<NavRenamePreview | null>
  stop(): Promise<void>
}

/**
 * Resolves a navigation session for a file, or `null` when no server can
 * handle it (unsupported extension, or the binary is not installed). Returning
 * `null` is how graceful degradation reaches the tools — they never throw or
 * hang. Mirrors the diagnostics tool's `DiagnosticsProvider` shape exactly.
 */
export interface LspNavProvider {
  /** Human-readable reason used in the no-op result when `open` returns null. */
  unavailableReason(filePath: string): string
  open(filePath: string, cwd: string): Promise<LspNavSession | null>
}
