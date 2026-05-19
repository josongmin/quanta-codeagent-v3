import { runShell } from "./shell"

/** Outcome of a {@link withWorktree} run handed back to the caller. */
export interface WorktreeInfo {
  /** Absolute path of the temporary worktree the body ran in. */
  worktreePath: string
  /** Branch the worktree was checked out on (`worktree-<id>`). */
  branch: string
  /** True ⇒ the worktree had no diff/untracked changes and was auto-removed.
   *  False ⇒ changes were detected and the worktree was kept on disk. */
  removed: boolean
}

/** Result the body returns plus the worktree bookkeeping that produced it. */
export interface WorktreeRun<T> {
  value: T
  info: WorktreeInfo
}

export class WorktreeError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message)
    this.name = "WorktreeError"
  }
}

const git = async (repoRoot: string, args: string) => {
  // `args` is fully controlled by this module (ids are sanitized); no
  // user/model string is interpolated. Run through the shared shell runner so
  // env scrubbing + timeout behavior match the rest of the runtime.
  return runShell(`git ${args}`, { cwd: repoRoot })
}

/** Slugify an id into the `/`-segment charset git worktree names allow. */
const safeId = (id: string): string => {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48)
  return cleaned.length > 0 ? cleaned : "x"
}

/** True when `repoRoot` is inside a git work tree and git is on PATH. */
export const isGitRepo = async (repoRoot: string): Promise<boolean> => {
  try {
    const r = await git(repoRoot, "rev-parse --is-inside-work-tree")
    return r.exitCode === 0 && r.stdout.trim() === "true"
  } catch {
    return false
  }
}

/**
 * Run `fn` inside a throwaway git worktree at
 * `<repoRoot>/.claude/worktrees/agent-<id>` on branch `worktree-<id>`.
 *
 * After `fn` resolves: if the worktree has NO diff and NO untracked files the
 * worktree + branch are removed (clean run, nothing worth keeping). If there
 * ARE changes the worktree is left in place so a caller can inspect/merge it,
 * and `info.removed` is false. On a throw from `fn` the worktree is force-
 * removed (best-effort) and the original error is re-thrown.
 *
 * Mirrors v2's `Jf_` / `qJH("agent_tool")` flow (worktree-system.md): create
 * with `git worktree add`, keep-on-dirty, remove-on-clean.
 */
export const withWorktree = async <T>(
  id: string,
  repoRoot: string,
  fn: (worktreePath: string) => Promise<T>,
): Promise<WorktreeRun<T>> => {
  if (!(await isGitRepo(repoRoot))) {
    throw new WorktreeError(`Not a git repository (or git unavailable): ${repoRoot}`)
  }

  const slug = safeId(id)
  const name = `agent-${slug}`
  const branch = `worktree-${slug}`
  const worktreePath = `${repoRoot}/.claude/worktrees/${name}`

  const add = await git(repoRoot, `worktree add --no-track -B ${branch} "${worktreePath}" HEAD`)
  if (add.exitCode !== 0) {
    throw new WorktreeError(
      `git worktree add failed for ${name}`,
      add.stderr.trim() || add.stdout.trim(),
    )
  }

  const forceRemove = async () => {
    try {
      await git(repoRoot, `worktree remove --force "${worktreePath}"`)
      await git(repoRoot, `branch -D ${branch}`)
    } catch {
      // best-effort cleanup; nothing actionable on failure
    }
  }

  let value: T
  try {
    value = await fn(worktreePath)
  } catch (e) {
    await forceRemove()
    throw e
  }

  // Clean ⇒ no tracked diff AND no untracked files.
  const status = await git(worktreePath, "status --porcelain")
  const dirty = status.exitCode !== 0 || status.stdout.trim().length > 0

  let removed = false
  if (!dirty) {
    const rm = await git(repoRoot, `worktree remove --force "${worktreePath}"`)
    if (rm.exitCode === 0) {
      await git(repoRoot, `branch -D ${branch}`)
      removed = true
    }
  }

  return { value, info: { worktreePath, branch, removed } }
}
