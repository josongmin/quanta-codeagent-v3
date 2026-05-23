import { z } from "zod";
// --- git_diff ----------------------------------------------------------------
export const gitDiffInputSchema = z.object({
    /** Compare against this revision (e.g. `HEAD`, `main`, `<sha>`). When
     *  absent, compares the working tree against the index/HEAD per `staged`. */
    base: z.string().optional().describe("Revision to diff against (e.g. HEAD)"),
    /** Restrict to these path(s); shown verbatim to `git diff -- <paths…>`. */
    paths: z.array(z.string()).optional().describe("Restrict diff to these paths"),
    /** True ⇒ `git diff --staged` (index vs HEAD). Otherwise working vs index/HEAD. */
    staged: z.boolean().optional().describe("Diff the staging area (index vs HEAD)"),
});
// --- git_status --------------------------------------------------------------
export const gitStatusInputSchema = z.object({});
// --- git_upstream_check ------------------------------------------------------
/** Read-only, no-network upstream-divergence check (absorb #5, v0.dev
 *  chat=branch `upstreamChanges`). Takes no args: it inspects the CURRENT
 *  branch's already-fetched remote-tracking ref. It deliberately does NOT
 *  `git fetch` (network + index mutation stays on `bash`). */
export const gitUpstreamCheckInputSchema = z.object({});
// --- git_log -----------------------------------------------------------------
export const gitLogInputSchema = z.object({
    /** Limit log to commits touching this file. */
    file: z.string().optional().describe("Only show commits touching this file"),
    /** Number of commits to show. Default 10. Capped at 200. */
    n: z.number().int().positive().max(200).optional().describe("Commit count (default 10, max 200)"),
});
// --- git_blame ---------------------------------------------------------------
export const gitBlameInputSchema = z.object({
    file: z.string().describe("File to blame"),
    /** 1-based line number to blame. */
    line: z.number().int().positive().describe("1-based line number to blame"),
});
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
});
// --- git_blame_heatmap -------------------------------------------------------
/** Stage-1 ownership signal: per-file author line distribution. Who owns the
 *  most lines of a file is a weak-but-useful "who to ask / who last touched
 *  this surface" signal (Codex blame ownership). READ-ONLY, CONCURRENCY-SAFE. */
export const gitBlameHeatmapInputSchema = z
    .object({
    file: z.string().describe("File to compute author line-ownership distribution for"),
    /** Max authors to list. Default 10, capped at 50. */
    n: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("Top-N authors (default 10, max 50)"),
    /** 1-based start line to scope ownership to a region (e.g. one function).
     *  Requires `end_line`. Maps to `git blame -L <start>,<end>`. */
    start_line: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("1-based start line (with end_line)"),
    /** 1-based end line (inclusive). Requires `start_line`. */
    end_line: z.number().int().positive().optional().describe("1-based end line (with start_line)"),
})
    .refine((v) => (v.start_line === undefined) === (v.end_line === undefined), {
    message: "start_line and end_line must be provided together",
})
    .refine((v) => v.start_line === undefined || v.end_line === undefined || v.end_line >= v.start_line, {
    message: "end_line must be >= start_line",
});
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
});
// --- git_branch_switch -------------------------------------------------------
/** Branch-name pattern: same alphabet as `safeBranch` in
 *  `@/runtime/worktree-fork` ([A-Za-z0-9._/+-]), forbids leading `-` (CLI-flag
 *  confusion), 64-char cap. Schema-level guard so a malicious branch name
 *  cannot escape the argv we hand to `git`. */
const BRANCH_NAME_RE = /^(?!-)[A-Za-z0-9._/+-]{1,64}$/;
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
});
