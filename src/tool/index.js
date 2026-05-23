import { applyPatchTool } from "./apply-patch";
import { bashTool } from "./bash";
import { diagnosticsTool, nullDiagnosticsProvider } from "./diagnostics";
import { editTool, makeEditTool } from "./edit";
import { fileTreeSummaryTool } from "./file-tree-summary";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { localizeTool } from "./localize";
import { parseTestFailureTool } from "./parse-test-failure";
import { makeReadTool, readTool } from "./read";
import { scriptedReplaceTool } from "./scripted-replace";
import { testRunnerTool } from "./test-runner";
import { makeWriteTool, writeTool } from "./write";
export { applyPatchTool, FsJailViolationError } from "./apply-patch";
export { DeferredResultRegistry, UnknownDeferredHandleError } from "./deferred";
export { diagnosticsTool, formatDiagnostics, nullDiagnosticsProvider, } from "./diagnostics";
export { defineTool, driveStreamingInput, enforceOutputSchema, renderModelOutput, validateToolOutput, } from "./factory";
export { fileTreeSummaryTool } from "./file-tree-summary";
export { defaultGhRunner, ghTools } from "./gh";
export { defaultGitRunner, gitBlameHeatmapTool, gitBlameTool, gitBranchSwitchTool, gitChurnTool, gitCommitTool, gitDiffTool, gitLogTool, gitStatusTool, gitTools, gitUpstreamCheckTool, rankBlame, rankChurn, } from "./git";
export { lspNavTools, nullLspNavProvider, } from "./lsp_nav";
export { classifyFrame, parseTestFailure, parseTestFailureTool, } from "./parse-test-failure";
export { buildPlanTools, createPlanTool, removeTodosTool, updatePlanTool, updateTodosTool, } from "./plan";
export { planErrorMessage, planFailure } from "./plan/error-mapping";
export { ToolRegistry } from "./registry";
export { requestPlanExitTool } from "./request-plan-exit";
export { requestUserInputTool } from "./request-user-input";
export { composeShellObservers, noopShellObserver } from "./shell-exec-observers";
export { createUpdateWorkingStateTool } from "./update-working-state";
/**
 * Build the built-in tool set: Phase 1 six + Phase 2 localize / test_runner +
 * the Phase-3 `diagnostics` tool — with INJECTABLE ports (DIP) so the
 * composition root can substitute the filesystem / diagnostics seams instead
 * of relying on the module-load singletons. Called with no args this is
 * identical (ids + behavior) to the historical `defaultTools` literal; the
 * exported `defaultTools` below is exactly `buildDefaultTools()`.
 */
export const buildDefaultTools = (ports = {}) => [
    (ports.fs !== undefined ? makeReadTool(ports.fs) : readTool),
    (ports.fs !== undefined ? makeWriteTool(ports.fs) : writeTool),
    (ports.fs !== undefined ? makeEditTool(ports.fs) : editTool),
    // Phase 4: `scripted_replace` is registered by default — the LLM only routes
    // to it when `edit` surfaces a strategy hint or the prompt calls for bulk
    // substitution. Sessions that never invoke it see byte-identical behavior.
    scriptedReplaceTool,
    // V4A apply_patch (Wave C): multi-file atomic patch against session cwd via
    // FsJail-confined port. Same mutating posture as edit/write/scripted_replace;
    // sessions that never route to it are byte-identical. Reuses whatever
    // `apply-patch.ts` exports — that file is owned elsewhere and untouched.
    applyPatchTool,
    bashTool,
    grepTool,
    globTool,
    localizeTool,
    // Fault-localization aids (Codex signal absorption): file_tree_summary for
    // Stage-1 structure, parse_test_failure for Stage-3 log→file:line. Both
    // read-only + concurrency-safe; sessions that never call them are unchanged.
    fileTreeSummaryTool,
    parseTestFailureTool,
    testRunnerTool,
    diagnosticsTool(ports.diagnostics ?? nullDiagnosticsProvider),
];
/**
 * Built-in tool set with default ports. Kept as a stable, eagerly-evaluated
 * export so existing callers (`apps/*`, smoke runner, tests) that import
 * `defaultTools` are unchanged. Equivalent to `buildDefaultTools()`.
 */
export const defaultTools = buildDefaultTools();
