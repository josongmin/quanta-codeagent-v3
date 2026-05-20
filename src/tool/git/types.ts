import { z } from "zod"

/** Git first-class tool contract (SOTA++ Codex `may-20-codex-signal.md`
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
