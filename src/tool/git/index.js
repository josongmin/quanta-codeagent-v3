/** First-class git tool slice. Originally four READ-ONLY tools (Codex
 *  `may-20-codex-signal.md` absorption, ADR-0025); extended with two
 *  MUTATING tools (`git_commit`, `git_branch_switch`) to absorb Claude
 *  Desktop 1.7196.3's `commitWipForBranchSwitch` pattern (ADR-00XX, this
 *  worktree).
 *
 *  Read-only tools (`git_diff`, `git_status`, `git_log`, `git_blame`) remain
 *  CONCURRENCY-SAFE and tier-`none`. Mutating tools opt into the HITL 4-tier
 *  gate via `hitlTier`: `git_commit` defaults to `always-confirm` (regular
 *  commits may be pushed) but `mode='wip'` yields `pre-approval-ok` (session-
 *  boundary checkpoint, reversible); `git_branch_switch` is `pre-approval-ok`
 *  (reversible). The remaining mutating commands (push/reset/restore/checkout)
 *  deliberately stay on `bash` so the HARD_DENY pattern denylist keeps
 *  governing them. */
import { gitBlameTool } from "./blame";
import { gitBlameHeatmapTool } from "./blame-heatmap";
import { gitBranchSwitchTool } from "./branch-switch";
import { gitChurnTool } from "./churn";
import { gitCommitTool } from "./commit";
import { gitDiffTool } from "./diff";
import { gitLogTool } from "./log";
import { defaultGitRunner } from "./runner";
import { gitStatusTool } from "./status";
import { gitUpstreamCheckTool } from "./upstream";
export { gitBlameTool } from "./blame";
export { gitBlameHeatmapTool, rankBlame } from "./blame-heatmap";
export { gitBranchSwitchTool } from "./branch-switch";
export { gitChurnTool, rankChurn } from "./churn";
export { gitCommitTool } from "./commit";
export { gitDiffTool } from "./diff";
export { gitLogTool } from "./log";
export { buildGitEnv, defaultGitRunner } from "./runner";
export { gitStatusTool } from "./status";
// ADR-0105/0107: budget interface + helpers (closed-port; tools opt in).
export { applyBudget, crossedTarget, resolveMaxCommits } from "./_budget";
export { gitUpstreamCheckTool } from "./upstream";
/** Build the git tools wired to a runner. When omitted, the default
 *  Bun.spawn-backed runner is used. Order: read-only first (diff/status/log/
 *  blame), then mutating (commit, branch-switch). */
export const gitTools = (runner = defaultGitRunner) => [
    gitDiffTool(runner),
    gitStatusTool(runner),
    gitLogTool(runner),
    gitBlameTool(runner),
    // Stage-1 fault-localization signals (read-only, concurrency-safe).
    gitChurnTool(runner),
    gitBlameHeatmapTool(runner),
    // Upstream-divergence check (read-only, v0 chat=branch absorption, #5).
    gitUpstreamCheckTool(runner),
    gitCommitTool(runner),
    gitBranchSwitchTool(runner),
];
