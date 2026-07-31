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

import type { LLMPort } from "@/llm"
import type { GitDirectiveEmitter } from "../../agent/git-directives"
import type { Tool } from "../types"
import { type GitBudget, withBudget } from "./_budget"
import { gitBlameTool } from "./blame"
import { gitBlameHeatmapTool } from "./blame-heatmap"
import { gitBranchSwitchTool } from "./branch-switch"
import { gitChurnTool } from "./churn"
import { gitCoChangeTool } from "./co-change"
import { gitCommitTool } from "./commit"
import { gitComposeCommitTool, gitComposePrTool } from "./compose"
import { gitConflictInspectTool } from "./conflict-inspect"
import { gitDiffTool } from "./diff"
import { gitLogTool } from "./log"
import { gitMovedCodeTool } from "./moved-code-tool"
import { gitReviewDiffTool } from "./review-diff"
import { defaultGitRunner } from "./runner"
import { gitStatusTool } from "./status"
import type { GitRunner } from "./types"
import { gitUpstreamCheckTool } from "./upstream"

/** ADR-0220 wire — opt-in tool factory options. When `gitDirectiveEmitter`
 *  is set, the mutating git tools (`git_commit`, `git_branch_switch`) emit
 *  typed directives after every confirmed successful mutation. Absent ⇒
 *  byte-identical legacy (no rev-parse, no allocation). */
export interface GitToolsOpts {
  readonly gitDirectiveEmitter?: GitDirectiveEmitter
  /** Diff→prose AUTHORING seam (Codex `yeet` / Cursor compose). When supplied,
   *  `git_compose_commit` + `git_compose_pr` are registered, wired to this
   *  one-shot author LLM (typically a cheap model). Absent ⇒ the two tools are
   *  NOT constructed and NOT in the registry — byte-identical legacy. The
   *  composition root sources this from `config.composeAuthoring`. */
  readonly authorLLM?: LLMPort
  /** §7.2 long-tail — when `true`, register the `git_co_change` related-files
   *  tool (co-occurrence matrix from git history). Default-OFF: absent/false ⇒
   *  the tool is NOT constructed and NOT in the registry, byte-identical legacy.
   *  The composition root flips this on the `QUANTA_GIT_CO_CHANGE` gate. */
  readonly coChange?: boolean
  /** ADR-0107 — GitBudget applied to read-only walk tools (log/churn/blame/
   *  upstream). When supplied, `withBudget` wraps the runner; absent ⇒ the raw
   *  runner is used, byte-identical to the pre-budget path. */
  readonly budget?: GitBudget
}

// ADR-0105/0107: budget interface + helpers (closed-port; tools opt in).
export {
  applyBudget,
  crossedTarget,
  type GitBudget,
  resolveGitBudget,
  resolveMaxCommits,
  withBudget,
} from "./_budget"
export { gitBlameTool } from "./blame"
export { gitBlameHeatmapTool, rankBlame } from "./blame-heatmap"
export { type GitBranchSwitchToolOpts, gitBranchSwitchTool } from "./branch-switch"
export { gitChurnTool, rankChurn } from "./churn"
export {
  type CoChangePair,
  type CoChangeRow,
  gitCoChangeTool,
  parseCommitGroups,
  rankCoChange,
  rankCoChangePairs,
} from "./co-change"
export { type GitCommitToolOpts, gitCommitTool } from "./commit"
export {
  buildCommitAuthorPrompt,
  buildPrAuthorPrompt,
  COMMIT_AUTHOR_SYSTEM,
  gitComposeCommitTool,
  gitComposePrTool,
  type ParsedCommitMessage,
  type ParsedPrMessage,
  PR_AUTHOR_SYSTEM,
  parseConventionalCommit,
  parsePrAuthored,
} from "./compose"
export {
  type GitConflictInspectInput,
  gitConflictInspectInputSchema,
  gitConflictInspectTool,
} from "./conflict-inspect"
export { gitDiffTool } from "./diff"
export { gitLogTool } from "./log"
export {
  type GitMovedCodeInput,
  gitMovedCodeInputSchema,
  gitMovedCodeTool,
} from "./moved-code-tool"
export { type GitPushToolOpts, gitPushTool } from "./push"
export {
  type GitReviewDiffInput,
  gitReviewDiffInputSchema,
  gitReviewDiffTool,
  type ReviewFinding,
  type ReviewReport,
} from "./review-diff"
export { buildGitEnv, defaultGitRunner } from "./runner"
export { type GitStageToolOpts, gitStageTool } from "./stage"
export { gitStatusTool } from "./status"
export type {
  GitBlameHeatmapInput,
  GitBlameInput,
  GitBranchSwitchInput,
  GitChurnInput,
  GitCommitInput,
  GitComposeCommitInput,
  GitComposePrInput,
  GitDiffInput,
  GitLogInput,
  GitRunner,
  GitRunResult,
  GitStatusInput,
  GitUpstreamCheckInput,
} from "./types"
export { gitUpstreamCheckTool } from "./upstream"

/** Build the git tools wired to a runner. When omitted, the default
 *  Bun.spawn-backed runner is used. Order: read-only first (diff/status/log/
 *  blame), then mutating (commit, branch-switch).
 *
 *  ADR-0220 wire — `opts.gitDirectiveEmitter` flows ONLY to the mutating
 *  tools (commit, branch-switch). Read-only tools never emit (no closed
 *  directive kind exists for read-only ops). Absent ⇒ byte-identical. */
export const gitTools = (runner: GitRunner = defaultGitRunner, opts: GitToolsOpts = {}): Tool[] => {
  // ADR-0107 §wire — budget-constrained runner for read-only walk tools.
  // When budget is absent or has no enforceable knob, withBudget returns the
  // same runner reference (byte-identical: no extra allocation).
  const walkedRunner = withBudget(runner, opts.budget)
  return [
    gitDiffTool(runner) as Tool,
    // Diff→prose AUTHORING (Codex `yeet` / Cursor compose). Read-only, tier
    // "none" — these author a commit message / PR body but never mutate. Default-
    // OFF: registered ONLY when an author LLM is wired (`opts.authorLLM`). Absent
    // ⇒ omitted entirely (byte-identical legacy registry).
    ...(opts.authorLLM !== undefined
      ? [
          gitComposeCommitTool(runner, opts.authorLLM) as Tool,
          gitComposePrTool(runner, opts.authorLLM) as Tool,
        ]
      : []),
    gitStatusTool(runner) as Tool,
    gitLogTool(walkedRunner) as Tool,
    gitBlameTool(walkedRunner) as Tool,
    // Stage-1 fault-localization signals (read-only, concurrency-safe).
    gitChurnTool(walkedRunner) as Tool,
    gitBlameHeatmapTool(walkedRunner) as Tool,
    // Upstream-divergence check (read-only, v0 chat=branch absorption, #5).
    gitUpstreamCheckTool(walkedRunner) as Tool,
    // Isolated diff reviewer (read-only, Claude Desktop `reviewDiff` absorption,
    // ADR-0111). Sub-agent runner is host-injected via ctx.reviewerAgent.
    gitReviewDiffTool(runner) as Tool,
    // Moved-code classifier (ADR-0109) + conflict inspector (ADR-0111). Both
    // read-only + concurrency-safe; expose existing pure cores as first-class
    // tools so `pr-review-canvas` and `fix-merge-conflicts` skills have a typed
    // surface to call instead of shelling raw git in the prompt.
    gitMovedCodeTool(runner) as Tool,
    gitConflictInspectTool(runner) as Tool,
    gitCommitTool(
      runner,
      opts.gitDirectiveEmitter !== undefined
        ? { gitDirectiveEmitter: opts.gitDirectiveEmitter }
        : {},
    ) as Tool,
    gitBranchSwitchTool(
      runner,
      opts.gitDirectiveEmitter !== undefined
        ? { gitDirectiveEmitter: opts.gitDirectiveEmitter }
        : {},
    ) as Tool,
    // §7.2 long-tail — co-change / related-files tool (read-only, concurrency-
    // safe). Default-OFF: registered ONLY when `opts.coChange` is true
    // (QUANTA_GIT_CO_CHANGE gate). Absent/false ⇒ omitted (byte-identical legacy
    // 12-tool registry). Appended LAST so the legacy ordering is untouched.
    ...(opts.coChange === true ? [gitCoChangeTool(walkedRunner) as Tool] : []),
  ]
}
