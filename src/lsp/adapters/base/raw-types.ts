import type { Diagnostic } from "../../types"

/** Raw LSP shapes we read off the wire. Kept minimal: we narrow only the
 *  fields we consume (same pattern as the LLM adapters). */
export interface RawRange {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

export interface RawDiagnostic {
  range: RawRange
  severity?: number
  message: string
  source?: string
  code?: string | number
}

export interface PublishDiagnosticsParams {
  uri: string
  diagnostics: RawDiagnostic[]
}

export interface InitializeResult {
  serverInfo?: { name: string; version?: string }
}

export interface WorkspaceFolder {
  uri: string
  name: string
}

export interface WorkspaceConfigurationParams {
  items?: Array<{ section?: string }>
}

export interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
  detachAbort?: () => void
}

/** Raw LSP shapes consumed by the nav RPC methods. Kept minimal: we narrow
 *  only the fields we actually map (same pattern as the diagnostics path). */
export interface RawLocation {
  uri: string
  range: RawRange
}
export interface RawLocationLink {
  targetUri: string
  targetRange: RawRange
  targetSelectionRange?: RawRange
}
export type RawDefinitionResult = RawLocation | RawLocation[] | RawLocationLink[] | null
/** LSP `CallHierarchyItem` — the resolved callable returned by
 *  `prepareCallHierarchy` and embedded as `from`/`to` in the incoming/outgoing
 *  responses. We narrow only the fields we map. */
export interface RawCallHierarchyItem {
  name: string
  kind: number
  uri: string
  range: RawRange
  selectionRange: RawRange
}
export interface RawIncomingCall {
  from: RawCallHierarchyItem
  fromRanges?: RawRange[]
}
export interface RawOutgoingCall {
  to: RawCallHierarchyItem
  fromRanges?: RawRange[]
}
export type RawCallHierarchyResult = RawIncomingCall[] | RawOutgoingCall[] | null
export interface RawMarkupContent {
  kind: "plaintext" | "markdown"
  value: string
}
export type RawMarkedString = string | { language: string; value: string }
export type RawHoverContents = RawMarkupContent | RawMarkedString | RawMarkedString[]
export interface RawHover {
  contents: RawHoverContents
  range?: RawRange
}
export interface RawDocumentSymbol {
  name: string
  kind: number
  range: RawRange
  selectionRange: RawRange
  children?: RawDocumentSymbol[]
}
export interface RawSymbolInformation {
  name: string
  kind: number
  location: { uri: string; range: RawRange }
  containerName?: string
}
export interface RawWorkspaceSymbol {
  name: string
  kind: number
  location: { uri: string; range?: RawRange }
  containerName?: string
}
export type RawDocumentSymbolResult = RawDocumentSymbol[] | RawSymbolInformation[] | null
export type RawWorkspaceSymbolResult = Array<RawSymbolInformation | RawWorkspaceSymbol> | null
export interface RawPrepareRenameObject {
  range?: RawRange
  placeholder?: string
  defaultBehavior?: boolean
}
export type RawPrepareRenameResult = RawRange | RawPrepareRenameObject | null

/** Raw shapes for the 3 new wire methods (code-action / format / signatureHelp)
 *  + the WorkspaceEdit `applyEdit` consumes. Kept minimal — narrow only fields
 *  we map (same posture as the nav RPC raw types). */
export interface RawTextEdit {
  range: RawRange
  newText: string
}
export interface RawCodeAction {
  title: string
  kind?: string
  edit?: RawWorkspaceEdit
}
/** Servers may answer `textDocument/codeAction` with the legacy `Command`
 *  shape (no `edit`). We treat those as `quickfix` with no edit — the model
 *  surfaces the title but cannot apply automatically. */
export interface RawCommand {
  title: string
  command: string
}
export type RawCodeActionEntry = RawCodeAction | RawCommand
export type RawCodeActionResult = RawCodeActionEntry[] | null

/** LSP `WorkspaceEdit`. v1 reads both `changes` (legacy: map of uri → edits)
 *  AND `documentChanges` (newer: array of {textDocument, edits}). Resource ops
 *  (create/rename/delete file) are not surfaced — we ignore them. */
export interface RawWorkspaceEdit {
  changes?: Record<string, RawTextEdit[]>
  documentChanges?: RawTextDocumentEdit[]
}
export interface RawTextDocumentEdit {
  textDocument: { uri: string; version?: number | null }
  edits?: RawTextEdit[]
}
export interface RawParameterInformation {
  label: string | [number, number]
  documentation?: string | RawMarkupContent
}
export interface RawSignatureInformation {
  label: string
  documentation?: string | RawMarkupContent
  parameters?: RawParameterInformation[]
  activeParameter?: number | null
}
export interface RawSignatureHelp {
  signatures?: RawSignatureInformation[]
  activeSignature?: number | null
  activeParameter?: number | null
}
export type RawSignatureHelpResult = RawSignatureHelp | null

/** Severity number → our string union. */
export const SEVERITY: Record<number, Diagnostic["severity"]> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
}
