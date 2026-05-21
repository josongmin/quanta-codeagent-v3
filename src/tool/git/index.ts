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

import type { Tool } from "../types"
import { gitBlameTool } from "./blame"
import { gitBranchSwitchTool } from "./branch-switch"
import { gitCommitTool } from "./commit"
import { gitDiffTool } from "./diff"
import { gitLogTool } from "./log"
import { defaultGitRunner } from "./runner"
import { gitStatusTool } from "./status"
import type { GitRunner } from "./types"

export { gitBlameTool } from "./blame"
export { gitBranchSwitchTool } from "./branch-switch"
export { gitCommitTool } from "./commit"
export { gitDiffTool } from "./diff"
export { gitLogTool } from "./log"
export { defaultGitRunner } from "./runner"
export { gitStatusTool } from "./status"
export type {
  GitBlameInput,
  GitBranchSwitchInput,
  GitCommitInput,
  GitDiffInput,
  GitLogInput,
  GitRunner,
  GitRunResult,
  GitStatusInput,
} from "./types"

/** Build the git tools wired to a runner. When omitted, the default
 *  Bun.spawn-backed runner is used. Order: read-only first (diff/status/log/
 *  blame), then mutating (commit, branch-switch). */
export const gitTools = (runner: GitRunner = defaultGitRunner): Tool[] => [
  gitDiffTool(runner) as Tool,
  gitStatusTool(runner) as Tool,
  gitLogTool(runner) as Tool,
  gitBlameTool(runner) as Tool,
  gitCommitTool(runner) as Tool,
  gitBranchSwitchTool(runner) as Tool,
]
