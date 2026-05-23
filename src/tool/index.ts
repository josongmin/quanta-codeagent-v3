import type { FileSystemPort } from "@/storage"
import { applyPatchTool } from "./apply-patch"
import { bashTool } from "./bash"
import { type DiagnosticsProvider, diagnosticsTool, nullDiagnosticsProvider } from "./diagnostics"
import { editTool, makeEditTool } from "./edit"
import { fileTreeSummaryTool } from "./file-tree-summary"
import { globTool } from "./glob"
import { grepTool } from "./grep"
import { readImageTool } from "./image"
import { localizeTool } from "./localize"
import { parseTestFailureTool } from "./parse-test-failure"
import { makeReadTool, readTool } from "./read"
import { scriptedReplaceTool } from "./scripted-replace"
import { testRunnerTool } from "./test-runner"
import type { Tool } from "./types"
import { makeWriteTool, writeTool } from "./write"

export { applyPatchTool, FsJailViolationError } from "./apply-patch"
export { DeferredResultRegistry, UnknownDeferredHandleError } from "./deferred"
export {
  type DiagnosticItem,
  type DiagnosticsProvider,
  type DiagnosticsSession,
  diagnosticsTool,
  formatDiagnostics,
  nullDiagnosticsProvider,
} from "./diagnostics"
export type { DefineToolSpec, StreamingInputStep } from "./factory"
export {
  defineTool,
  driveStreamingInput,
  enforceOutputSchema,
  renderModelOutput,
  validateToolOutput,
} from "./factory"
export { fileTreeSummaryTool, inferNextAction } from "./file-tree-summary"
export type { GhRunner } from "./gh"
// `read_image` cluster (ADR-0126): tool + composer helper + magic-byte sniffer.
// The composer is caller-wired (dispatch.ts is NOT modified by this slice) —
// when the helper is plumbed, `ToolResult.images` flows into the model's
// tool_result content; absent ⇒ legacy string shape (byte-identical).
export {
  composeToolResultContent,
  MAX_IMAGE_BYTES as READ_IMAGE_MAX_BYTES,
  type ReadImageInput,
  readImageInputSchema,
  readImageTool,
  sniffMediaType,
  SUPPORTED_MEDIA_TYPES as READ_IMAGE_SUPPORTED_MEDIA_TYPES,
  type SupportedMediaType as ReadImageSupportedMediaType,
  type ToolResultContent,
} from "./image"
export { defaultGhRunner, ghTools } from "./gh"
export type {
  GitBlameInput,
  GitBranchSwitchInput,
  GitCommitInput,
  GitDiffInput,
  GitLogInput,
  GitRunner,
  GitRunResult,
  GitStatusInput,
  GitUpstreamCheckInput,
} from "./git"
export {
  defaultGitRunner,
  gitBlameHeatmapTool,
  gitBlameTool,
  gitBranchSwitchTool,
  gitChurnTool,
  gitCommitTool,
  gitConflictInspectTool,
  gitDiffTool,
  gitLogTool,
  gitMovedCodeTool,
  gitStatusTool,
  gitTools,
  gitUpstreamCheckTool,
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
export {
  classifyFrame,
  type FailureFrame,
  type FrameTier,
  parseTestFailure,
  parseTestFailureTool,
} from "./parse-test-failure"
export {
  buildPlanTools,
  createPlanTool,
  removeTodosTool,
  updatePlanTool,
  updateTodosTool,
} from "./plan"
export { planErrorMessage, planFailure } from "./plan/error-mapping"
export { ToolRegistry } from "./registry"
export { requestPlanExitTool } from "./request-plan-exit"
export { requestUserInputTool } from "./request-user-input"
// Shadow-store tools (ADR-0119 + ADR-0122). Built only when the assembly seam
// wires `AgentConfig.shadowOdb`; NOT part of `defaultTools` — see tier1/shadow.ts.
export type {
  ShadowRestorePartialInput,
  ShadowRewindInput,
  ShadowSnapshotsInput,
} from "./shadow"
export {
  shadowRestorePartialInputSchema,
  shadowRestorePartialTool,
  shadowRewindInputSchema,
  shadowRewindTool,
  shadowSnapshotsInputSchema,
  shadowSnapshotsTool,
  shadowTools,
} from "./shadow"
export { composeShellObservers, noopShellObserver } from "./shell-exec-observers"
export type { ShellExecEvent, ShellExecObserver } from "./shell-exec-types"
export type {
  BlockerSurface,
  DeferredHandle,
  DeferredToolResult,
  GitWriteGuard,
  HITLTier,
  NextAction,
  PlanDeltaKind,
  PlanExitRequester,
  PlanExitToolDecision,
  PlanExitToolOutcome,
  PlanMutationErrorCode,
  PlanMutationResult,
  PlanMutator,
  PlanMutatorNewTodo,
  PlanMutatorTodoPatch,
  PlanReadonlyView,
  Tool,
  ToolContext,
  ToolEvent,
  ToolFailure,
  ToolResult,
  ToolResultEvidence,
  ToolSpec,
  UserInputOutcome,
  UserInputRequester,
  WorkingStateHandle,
  WorkingStatePatch,
  WorkingStateSnapshot,
} from "./types"
export { createUpdateWorkingStateTool } from "./update-working-state"

/**
 * STRUCTURAL CONTRACT: composition roots (`src/apps/**`) MUST call
 * `buildDefaultTools(ports)` and NOT import the eager `defaultTools` singleton
 * directly — the singleton is retained ONLY as a test / back-compat default.
 * The factory is the DIP seam: every port flows in here.
 *
 * Injectable ports for the default tool set (DIP). The composition root can
 * substitute any port; every field is OPTIONAL and falls back to the same
 * default the standalone exports use, so `buildDefaultTools()` (no args) is
 * byte-identical — same tool ids, same runtime behavior — to the pre-factory
 * `defaultTools` array literal.
 *
 *   - `fs`: backs `read` / `write` / `edit` (the `make*Tool(fs)` builders).
 *           Defaults to `defaultFileSystemPort` inside each builder.
 *   - `diagnostics`: backs the `diagnostics` tool. Defaults to the
 *           `nullDiagnosticsProvider` (clean no-op) until the CLI injects a
 *           real LSP-backed provider.
 *
 * NOTE: `git` / `lsp_nav` tools are NOT part of the default set; the CLI wires
 * them via `gitTools(runner)` / `lspNavTools(provider)` separately, so they
 * are intentionally absent here.
 */
export interface DefaultToolPorts {
  fs?: FileSystemPort
  diagnostics?: DiagnosticsProvider
}

/**
 * Build the built-in tool set: Phase 1 six + Phase 2 localize / test_runner +
 * the Phase-3 `diagnostics` tool — with INJECTABLE ports (DIP) so the
 * composition root can substitute the filesystem / diagnostics seams instead
 * of relying on the module-load singletons. Called with no args this is
 * identical (ids + behavior) to the historical `defaultTools` literal; the
 * exported `defaultTools` below is exactly `buildDefaultTools()`.
 */
export const buildDefaultTools = (ports: DefaultToolPorts = {}): Tool[] => [
  (ports.fs !== undefined ? makeReadTool(ports.fs) : readTool) as Tool,
  (ports.fs !== undefined ? makeWriteTool(ports.fs) : writeTool) as Tool,
  (ports.fs !== undefined ? makeEditTool(ports.fs) : editTool) as Tool,
  // Phase 4: `scripted_replace` is registered by default — the LLM only routes
  // to it when `edit` surfaces a strategy hint or the prompt calls for bulk
  // substitution. Sessions that never invoke it see byte-identical behavior.
  scriptedReplaceTool as Tool,
  // V4A apply_patch (Wave C): multi-file atomic patch against session cwd via
  // FsJail-confined port. Same mutating posture as edit/write/scripted_replace;
  // sessions that never route to it are byte-identical. Reuses whatever
  // `apply-patch.ts` exports — that file is owned elsewhere and untouched.
  applyPatchTool as Tool,
  bashTool as Tool,
  grepTool as Tool,
  globTool as Tool,
  localizeTool as Tool,
  // ADR-0126: `read_image` — vision-input. Read-only + concurrency-safe;
  // belongs in the always-on default set. Sessions that never call it are
  // byte-identical (the composer helper is caller-wired and absent from
  // dispatch.ts by design — `ToolResult.images` simply rides the OK result
  // until a future PR plumbs it into the tool_result content).
  readImageTool as Tool,
  // Fault-localization aids (Codex signal absorption): file_tree_summary for
  // Stage-1 structure, parse_test_failure for Stage-3 log→file:line. Both
  // read-only + concurrency-safe; sessions that never call them are unchanged.
  fileTreeSummaryTool as Tool,
  parseTestFailureTool as Tool,
  testRunnerTool as Tool,
  diagnosticsTool(ports.diagnostics ?? nullDiagnosticsProvider) as Tool,
]

/**
 * Built-in tool set with default ports. Kept as a stable, eagerly-evaluated
 * export so existing callers (`apps/*`, smoke runner, tests) that import
 * `defaultTools` are unchanged. Equivalent to `buildDefaultTools()`.
 */
export const defaultTools: Tool[] = buildDefaultTools()
