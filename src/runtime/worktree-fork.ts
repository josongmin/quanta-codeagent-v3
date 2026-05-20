import { runShell } from "./shell"
import { isGitRepo } from "./worktree"

/** A persistent (not auto-removed) git worktree spun up for top-level
 *  conversation fork. Unlike {@link withWorktree}, this does NOT clean up on
 *  exit — the caller (CLI session-fork) owns lifecycle and removes via
 *  {@link removeWorktree} or by manual `git worktree remove`. */
export interface PersistentWorktree {
  worktreePath: string
  branch: string
}

export class WorktreeForkError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message)
    this.name = "WorktreeForkError"
  }
}

const git = async (repoRoot: string, args: string) => {
  // `args` is fully controlled by this module — every interpolated token is
  // first run through `safeId` so a model/user-provided string cannot inject
  // shell metacharacters. Route through the shared shell runner for env
  // scrubbing + timeout parity with the rest of runtime/.
  return runShell(`git ${args}`, { cwd: repoRoot })
}

/** Slugify an id into the `/`-segment charset git worktree/branch names allow.
 *  Mirrors the sanitizer in `worktree.ts` so the two helpers agree on what's
 *  a valid id and so weird inputs (e.g. `;`, `/`, spaces) collapse to `-`. */
const safeId = (id: string): string => {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48)
  return cleaned.length > 0 ? cleaned : "x"
}

/** Create a persistent worktree at `<repoRoot>/.quanta/worktrees/<safeId>`
 *  on branch `fork-<safeId>` (overridable via `opts.branch`). Base ref
 *  defaults to `HEAD`; pass `opts.baseRef` to fork from a different commit.
 *
 *  Unlike {@link withWorktree}, this helper does NOT auto-remove — the
 *  worktree persists so the caller (top-level CLI thread-fork) can switch
 *  the user into it. Cleanup is the caller's responsibility via
 *  {@link removeWorktree}.
 *
 *  Throws {@link WorktreeForkError} when `repoRoot` is not a git repo or the
 *  underlying `git worktree add` fails. */
export const createPersistentWorktree = async (
  id: string,
  repoRoot: string,
  opts?: { branch?: string; baseRef?: string },
): Promise<PersistentWorktree> => {
  if (!(await isGitRepo(repoRoot))) {
    throw new WorktreeForkError(`Not a git repository (or git unavailable): ${repoRoot}`)
  }

  const slug = safeId(id)
  // Override-or-default — but always re-sanitize so a malicious branch name
  // (e.g. `; rm -rf /`) can't escape the `git` arg string we build below.
  const branch = safeId(opts?.branch ?? `fork-${slug}`)
  const baseRef = safeId(opts?.baseRef ?? "HEAD")
  const worktreePath = `${repoRoot}/.quanta/worktrees/${slug}`

  const add = await git(
    repoRoot,
    `worktree add --no-track -B ${branch} "${worktreePath}" ${baseRef}`,
  )
  if (add.exitCode !== 0) {
    throw new WorktreeForkError(
      `git worktree add failed for ${slug}`,
      add.stderr.trim() || add.stdout.trim(),
    )
  }

  return { worktreePath, branch }
}

/** Force-remove a persistent worktree. Returns `true` iff the underlying
 *  `git worktree remove --force` succeeded; the follow-up branch delete is
 *  best-effort and does NOT affect the return value. Idempotent on a
 *  missing/already-removed worktree (returns `false`, never throws). */
export const removeWorktree = async (
  worktreePath: string,
  repoRoot: string,
  opts?: { branch?: string },
): Promise<boolean> => {
  const rm = await git(repoRoot, `worktree remove --force "${worktreePath}"`)
  const ok = rm.exitCode === 0
  if (opts?.branch) {
    const branch = safeId(opts.branch)
    try {
      await git(repoRoot, `branch -D ${branch}`)
    } catch {
      // best-effort; branch may already be gone or still referenced
    }
  }
  return ok
}
