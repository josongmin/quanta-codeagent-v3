import { applyPatchTool } from "./apply-patch"
import { bashTool } from "./bash"
import { diagnosticsTool, nullDiagnosticsProvider } from "./diagnostics"
import { editTool } from "./edit"
import { fileTreeSummaryTool } from "./file-tree-summary"
import { globTool } from "./glob"
import { grepTool } from "./grep"
import { localizeTool } from "./localize"
import { parseTestFailureTool } from "./parse-test-failure"
import { readTool } from "./read"
import { scriptedReplaceTool } from "./scripted-replace"
import { testRunnerTool } from "./test-runner"
import type { Tool } from "./types"
import { writeTool } from "./write"

export { applyPatchTool, FsJailViolationError } from "./apply-patch"
export {
  type DiagnosticItem,
  type DiagnosticsProvider,
  type DiagnosticsSession,
  diagnosticsTool,
  formatDiagnostics,
  nullDiagnosticsProvider,
} from "./diagnostics"
export { fileTreeSummaryTool } from "./file-tree-summary"
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
  gitBlameHeatmapTool,
  gitBlameTool,
  gitBranchSwitchTool,
  gitChurnTool,
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitStatusTool,
  gitTools,
  rankBlame,
  rankChurn,
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
export { type FailureFrame, parseTestFailure, parseTestFailureTool } from "./parse-test-failure"
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
  // V4A apply_patch (Wave C): multi-file atomic patch against session cwd via
  // FsJail-confined port. Same mutating posture as edit/write/scripted_replace;
  // sessions that never route to it are byte-identical.
  applyPatchTool as Tool,
  bashTool as Tool,
  grepTool as Tool,
  globTool as Tool,
  localizeTool as Tool,
  // Fault-localization aids (Codex signal absorption): file_tree_summary for
  // Stage-1 structure, parse_test_failure for Stage-3 log→file:line. Both
  // read-only + concurrency-safe; sessions that never call them are unchanged.
  fileTreeSummaryTool as Tool,
  parseTestFailureTool as Tool,
  testRunnerTool as Tool,
  diagnosticsTool(nullDiagnosticsProvider) as Tool,
]
