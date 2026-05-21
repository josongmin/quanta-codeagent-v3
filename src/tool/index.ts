import { bashTool } from "./bash"
import { diagnosticsTool, nullDiagnosticsProvider } from "./diagnostics"
import { editTool } from "./edit"
import { globTool } from "./glob"
import { grepTool } from "./grep"
import { localizeTool } from "./localize"
import { readTool } from "./read"
import { scriptedReplaceTool } from "./scripted-replace"
import { testRunnerTool } from "./test-runner"
import type { Tool } from "./types"
import { writeTool } from "./write"

export {
  type DiagnosticItem,
  type DiagnosticsProvider,
  type DiagnosticsSession,
  diagnosticsTool,
  formatDiagnostics,
  nullDiagnosticsProvider,
} from "./diagnostics"
export type {
  GitBlameInput,
  GitBranchSwitchInput,
  GitCommitInput,
  GitDiffInput,
  GitLogInput,
  GitRunner,
  GitRunResult,
  GitStatusInput,
} from "./git"
export {
  defaultGitRunner,
  gitBlameTool,
  gitBranchSwitchTool,
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitStatusTool,
  gitTools,
} from "./git"
export type {
  LspNavProvider,
  LspNavSession,
  NavHover,
  NavLocation,
  NavPos,
  NavRange,
  NavRenamePreview,
  NavSymbolInfo,
  NavSymbolKind,
} from "./lsp_nav"
export {
  lspNavTools,
  nullLspNavProvider,
} from "./lsp_nav"
export { ToolRegistry } from "./registry"
export type {
  BlockerSurface,
  HITLTier,
  Tool,
  ToolContext,
  ToolEvent,
  ToolResult,
  ToolResultEvidence,
  ToolSpec,
  WorkingStateHandle,
  WorkingStatePatch,
  WorkingStateSnapshot,
} from "./types"
export { createUpdateWorkingStateTool } from "./update-working-state"

/**
 * Built-in tool set: Phase 1 six + Phase 2 localize / test_runner + the
 * Phase-3 `diagnostics` tool. `diagnostics` ships with the null provider so it
 * is a clean no-op until the CLI injects a real LSP-backed provider — registry
 * shape and default behavior are otherwise unchanged.
 */
export const defaultTools: Tool[] = [
  readTool as Tool,
  writeTool as Tool,
  editTool as Tool,
  // Phase 4: `scripted_replace` is registered by default — the LLM only routes
  // to it when `edit` surfaces a strategy hint or the prompt calls for bulk
  // substitution. Sessions that never invoke it see byte-identical behavior.
  scriptedReplaceTool as Tool,
  bashTool as Tool,
  grepTool as Tool,
  globTool as Tool,
  localizeTool as Tool,
  testRunnerTool as Tool,
  diagnosticsTool(nullDiagnosticsProvider) as Tool,
]
