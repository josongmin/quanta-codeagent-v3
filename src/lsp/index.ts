export { LspClient, type LspClientOptions, type LspClientSpec } from "./adapters/base"
export type { PyrightAdapterOptions } from "./adapters/pyright"
export { PyrightAdapter } from "./adapters/pyright"
export type { TypescriptAdapterOptions } from "./adapters/typescript"
export { languageIdFor, TypescriptAdapter } from "./adapters/typescript"
export type { LspPort } from "./ports"
// ── ADR-0141 expansion (sibling ports + default adapters) ─────────────────
export { DefaultCodeActionAdapter } from "./adapters/default-code-action"
export { DefaultFormatAdapter } from "./adapters/default-format"
export { DefaultSignatureHelpAdapter } from "./adapters/default-signature-help"
export type {
  CodeAction,
  CodeActionDocumentEdit,
  CodeActionKind,
  CodeActionPort,
  CodeActionPos,
  CodeActionRange,
  CodeActionTextEdit,
  CodeActionWorkspaceEdit,
} from "./ports/code-action-port"
export type {
  FormatPort,
  FormatPos,
  FormatRange,
  TextEdit,
} from "./ports/format-port"
export type {
  RenameApplyPort,
  RenameDocumentEdit,
  RenamePos,
  RenameRange,
  RenameTextEdit,
  RenameWorkspaceEdit,
} from "./ports/rename-apply-port"
export type {
  SignatureHelpPort,
  SignatureInfo,
  SignatureParameter,
} from "./ports/signature-help-port"
export type {
  Diagnostic,
  DiagnosticSeverity,
  Hover,
  Location,
  LspServerInfo,
  Pos,
  Range,
  RenamePreview,
  SymbolInfo,
  SymbolKind,
} from "./types"
