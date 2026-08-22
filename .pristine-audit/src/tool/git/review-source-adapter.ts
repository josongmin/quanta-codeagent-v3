/** RFC-02 B2 — review-source tool adapter.
 *
 *  The ONLY place that (a) converts a resolved `GitDiffOperation` to `git diff`
 *  argv and (b) binds the existing {@link GitRunner} as the pure resolver's
 *  {@link GitReadPort}. `@/git/review-source` stays pure; this adapter is the
 *  upper consumer that owns the process seam.
 *
 *  No new diff engine and no second finding schema: the argv this produces is
 *  fed straight into the existing `extractDiff` → isolated-reviewer path in
 *  `review-diff.ts`. */

import type { GeneratedAttributePort, GitDiffOperation, GitReadPort } from "@/git"
import { safeRun } from "./_shared"
import type { GitRunner } from "./types"

/** Map a RESOLVED operation to `git diff` argv. This is the single conversion
 *  point; the resolver never builds argv and the tool never re-derives it. */
export const operationToArgs = (op: GitDiffOperation): string[] => {
  switch (op.kind) {
    case "branch-merge-base":
      // Three-dot merge-base; refs kept symbolic ⇒ byte-identical default.
      return ["diff", `${op.base}...${op.head}`]
    case "commit-first-parent":
      // Two-dot patch of one commit vs its (resolved) first parent / empty tree.
      return ["diff", `${op.base}..${op.commit}`]
    case "tree-range":
      // Explicit two-endpoint tree diff (NOT merge-base).
      return ["diff", `${op.from}..${op.to}`]
    default:
      return assertNever(op)
  }
}

const assertNever = (x: never): never => {
  throw new Error(`unhandled GitDiffOperation: ${JSON.stringify(x)}`)
}

/** Bind a {@link GitRunner} as the resolver's {@link GitReadPort}. `resolveCommit`
 *  peels via `git rev-parse --verify --quiet <rev>^{commit}`: exit 0 ⇒ the single
 *  trimmed oid; any non-zero exit (missing / ambiguous / non-commit / spawn
 *  error) ⇒ `null` so the resolver fails closed. */
export const gitRunnerReadPort = (
  runner: GitRunner,
  cwd: string,
  signal?: AbortSignal,
): GitReadPort => ({
  async resolveCommit(rev: string): Promise<string | null> {
    const out = await safeRun(
      runner,
      ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`],
      cwd,
      "git rev-parse",
      signal,
    )
    if (out.kind === "spawn-error") return null
    if (out.result.exitCode !== 0) return null
    const oid = out.result.stdout.trim()
    return oid.length > 0 ? oid : null
  },
})

/** Bind a {@link GitRunner} as the generated-file filter's
 *  {@link GeneratedAttributePort}. Paths are passed after `--` so a leading-`-`
 *  filename can never be read as a git option; `-z` yields NUL-delimited
 *  triplets the pure parser consumes. */
export const gitRunnerAttributePort = (
  runner: GitRunner,
  cwd: string,
  signal?: AbortSignal,
): GeneratedAttributePort => ({
  async checkAttr(attribute, paths) {
    if (paths.length === 0) return { ok: true, stdout: "" }
    const out = await safeRun(
      runner,
      ["check-attr", "-z", attribute, "--", ...paths],
      cwd,
      "git check-attr",
      signal,
    )
    if (out.kind === "spawn-error") return { ok: false, message: out.message }
    if (out.result.exitCode !== 0) {
      return {
        ok: false,
        message: out.result.stderr.trim() || `git check-attr exited ${out.result.exitCode}`,
      }
    }
    return { ok: true, stdout: out.result.stdout }
  },
})
