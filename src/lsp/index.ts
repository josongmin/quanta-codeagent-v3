export {
  LspClient,
  type LspClientOptions,
  type LspClientSpec,
  LspRequestError,
} from "./adapters/base"
export type { ClangdAdapterOptions } from "./adapters/clangd"
export { ClangdAdapter } from "./adapters/clangd"
// ── ADR-0141 expansion (sibling ports + default adapters) ─────────────────
export { DefaultCodeActionAdapter } from "./adapters/default-code-action"
export { DefaultFormatAdapter } from "./adapters/default-format"
export { DefaultRenameApplyAdapter } from "./adapters/default-rename-apply"
export { DefaultSignatureHelpAdapter } from "./adapters/default-signature-help"
export type { GoplsAdapterOptions } from "./adapters/gopls"
export { GoplsAdapter } from "./adapters/gopls"
export type { PyrightAdapterOptions } from "./adapters/pyright"
export { PyrightAdapter } from "./adapters/pyright"
export type { RustAnalyzerAdapterOptions } from "./adapters/rust-analyzer"
export { RustAnalyzerAdapter } from "./adapters/rust-analyzer"
export type { TypescriptAdapterOptions } from "./adapters/typescript"
export { languageIdFor, TypescriptAdapter } from "./adapters/typescript"
export type { LspPort } from "./ports"
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
export {
  anyLspServerOnPath,
  CLANGD_BIN,
  GOPLS_BIN,
  LSP_SERVER_BINS,
  LSP_SERVER_REGISTRY,
  type LspServerRegistryEntry,
  lspExtensionToServerBin,
  lspServerBinForExtension,
  lspServerBinForFile,
  PYRIGHT_LANGSERVER_BIN,
  RUST_ANALYZER_BIN,
  TYPESCRIPT_LANGUAGE_SERVER_BIN,
} from "./server-registry"
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
