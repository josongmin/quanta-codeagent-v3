import { z } from "zod"

/** Git first-class tool contract (Codex `may-20-codex-signal.md`
 *  absorption — ADR-0016).
 *
 *  Slice isolation: `@/tool/git` shells to `git` directly via an injected
 *  {@link GitRunner}. The default runner uses `Bun.spawn` and is built when
 *  the tools are instantiated; tests pass a fake runner to assert behavior
 *  without a real git repo (and the integration suite uses tmpdir + `git
 *  init` to assert against real git).
 *
 *  All four tools are READ-ONLY and CONCURRENCY-SAFE. Mutating git commands
 *  (commit / restore / checkout / push) deliberately stay on `bash` so the
 *  permission/HARD_DENY/HITL layer governs them as before. */

export interface GitRunResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface GitRunner {
  run(args: readonly string[], cwd: string): Promise<GitRunResult>
}

// --- git_diff ----------------------------------------------------------------

export const gitDiffInputSchema = z.object({
  /** Compare against this revision (e.g. `HEAD`, `main`, `<sha>`). When
   *  absent, compares the working tree against the index/HEAD per `staged`. */
  base: z.string().optional().describe("Revision to diff against (e.g. HEAD)"),
  /** Restrict to these path(s); shown verbatim to `git diff -- <paths…>`. */
  paths: z.array(z.string()).optional().describe("Restrict diff to these paths"),
  /** True ⇒ `git diff --staged` (index vs HEAD). Otherwise working vs index/HEAD. */
  staged: z.boolean().optional().describe("Diff the staging area (index vs HEAD)"),
})
export type GitDiffInput = z.infer<typeof gitDiffInputSchema>

// --- git_status --------------------------------------------------------------

export const gitStatusInputSchema = z.object({})
export type GitStatusInput = z.infer<typeof gitStatusInputSchema>

// --- git_log -----------------------------------------------------------------

export const gitLogInputSchema = z.object({
  /** Limit log to commits touching this file. */
  file: z.string().optional().describe("Only show commits touching this file"),
  /** Number of commits to show. Default 10. Capped at 200. */
  n: z.number().int().positive().max(200).optional().describe("Commit count (default 10, max 200)"),
})
export type GitLogInput = z.infer<typeof gitLogInputSchema>

// --- git_blame ---------------------------------------------------------------

export const gitBlameInputSchema = z.object({
  file: z.string().describe("File to blame"),
  /** 1-based line number to blame. */
  line: z.number().int().positive().describe("1-based line number to blame"),
})
export type GitBlameInput = z.infer<typeof gitBlameInputSchema>

// --- git_churn ---------------------------------------------------------------

/** Stage-1 fault-localization aid (Codex "file topology" + recency signal).
 *  Ranks files by how often they changed in a recent window — churn hotspots
 *  are disproportionately where bugs live. READ-ONLY, CONCURRENCY-SAFE. */
export const gitChurnInputSchema = z.object({
  /** Git revision range / since-expression (e.g. "30.days", "HEAD~50"). When
   *  absent, defaults to the last 200 commits. */
  since: z.string().optional().describe('Window, e.g. "30.days" or "HEAD~50" (default last 200)'),
  /** Restrict churn to files under this path. */
  path: z.string().optional().describe("Restrict churn ranking to this path"),
  /** Max ranked files to return. Default 20, capped at 100. */
  n: z.number().int().positive().max(100).optional().describe("Top-N files (default 20, max 100)"),
})
export type GitChurnInput = z.infer<typeof gitChurnInputSchema>

// --- git_blame_heatmap -------------------------------------------------------

/** Stage-1 ownership signal: per-file author line distribution. Who owns the
 *  most lines of a file is a weak-but-useful "who to ask / who last touched
 *  this surface" signal (Codex blame ownership). READ-ONLY, CONCURRENCY-SAFE. */
export const gitBlameHeatmapInputSchema = z.object({
  file: z.string().describe("File to compute author line-ownership distribution for"),
  /** Max authors to list. Default 10, capped at 50. */
  n: z.number().int().positive().max(50).optional().describe("Top-N authors (default 10, max 50)"),
})
export type GitBlameHeatmapInput = z.infer<typeof gitBlameHeatmapInputSchema>

// --- git_commit --------------------------------------------------------------

/** Claude Desktop 1.7196.3 `commitWipForBranchSwitch` absorption: a session-
 *  boundary git checkpoint that is reversible and trust-eligible (mode="wip"),
 *  plus a regular commit path that still routes through `always-confirm`
 *  because it may be pushed (permanent). */
export const gitCommitInputSchema = z.object({
  /** Commit message. Optional in `wip` mode (a default is generated); required
   *  for `regular` mode (validated at runtime). */
  message: z.string().min(1).optional().describe("Commit message (required for regular mode)"),
  /** "regular" (default) = `git add . && git commit`. "wip" = ephemeral
   *  checkpoint, auto-message when `message` omitted, pre-approval-eligible. */
  mode: z.enum(["wip", "regular"]).optional().describe("Commit mode: wip | regular"),
  /** Restrict staging to these paths. Default = stage all (`.`). */
  paths: z.array(z.string()).optional().describe("Paths to stage (default: all)"),
})
export type GitCommitInput = z.infer<typeof gitCommitInputSchema>

// --- git_branch_switch -------------------------------------------------------

/** Branch-name pattern: same alphabet as `safeBranch` in
 *  `@/runtime/worktree-fork` ([A-Za-z0-9._/+-]), forbids leading `-` (CLI-flag
 *  confusion), 64-char cap. Schema-level guard so a malicious branch name
 *  cannot escape the argv we hand to `git`. */
const BRANCH_NAME_RE = /^(?!-)[A-Za-z0-9._/+-]{1,64}$/

export const gitBranchSwitchInputSchema = z.object({
  branch: z
    .string()
    .min(1)
    .max(64)
    .regex(BRANCH_NAME_RE, "branch must match [A-Za-z0-9._/+-] (no leading '-')")
    .describe("Branch to switch to"),
  /** True ⇒ when working tree is dirty, auto-create a wip commit first. */
  autoWip: z.boolean().optional().describe("Auto-commit dirty tree as wip before switching"),
  /** True ⇒ create the branch (`git switch -c <branch>`). */
  create: z.boolean().optional().describe("Create the branch (-c)"),
})
export type GitBranchSwitchInput = z.infer<typeof gitBranchSwitchInputSchema>
