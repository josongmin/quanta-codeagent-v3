import { runShell } from "./shell"
import type { RunShellEvent, ShellResult } from "./types"

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

const git = async (
  repoRoot: string,
  args: string,
  // RFC-04 D2 — OPTIONAL typed output observer. When supplied, git's own
  // stderr (e.g. checkout progress) streams through the existing
  // `runShell.onShellEvent` seam so a caller can surface a REAL checkout ratio.
  // Absent ⇒ `runShell` is byte-identical to the pre-D2 path (its own
  // documented contract: no observer ⇒ no events, no extra branching).
  onShellEvent?: (event: RunShellEvent) => void,
) => {
  // `args` is fully controlled by this module (ids are sanitized); no
  // user/model string is interpolated. Run through the shared shell runner so
  // env scrubbing + timeout behavior match the rest of the runtime. When no
  // observer is supplied the options bag is exactly `{ cwd }` — byte-identical
  // to the pre-D2 legacy call (no `onShellEvent` key at all).
  return runShell(
    `git ${args}`,
    onShellEvent === undefined ? { cwd: repoRoot } : { cwd: repoRoot, onShellEvent },
  )
}

/** Bounded number of attempts for `git worktree add` when it loses the repo
 *  lock race against a concurrent worktree operation. Small on purpose — the
 *  contention window is brief, so a handful of tries with backoff converges. */
export const MAX_WORKTREE_LOCK_RETRIES = 5
/** Base backoff between `git worktree add` retries. Multiplied by the attempt
 *  index for a light linear backoff so concurrent forks de-stagger. */
export const WORKTREE_LOCK_BACKOFF_MS = 50

/** True only for TRANSIENT git LOCK-contention failures — a concurrent
 *  `git worktree add` / index write briefly held a repo lock. These are the
 *  ONLY failures we retry; any other non-zero exit (bad ref, branch exists for
 *  a different worktree, disk full, …) is a real error and must fail
 *  immediately, NOT be retried. Matches the stderr/stdout git emits for the
 *  lock race: `index.lock`, `worktrees/<name>/locked`, "already locked",
 *  "Unable to create '...lock'". */
export const isTransientWorktreeLockError = (stderr: string): boolean =>
  /index\.lock|worktrees?\/[^\s]*\/locked|already locked|unable to create.*\.lock|cannot lock ref/i.test(
    stderr,
  )

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Run a `git worktree add ...` invocation with a bounded retry on TRANSIENT
 * lock contention ONLY (see {@link isTransientWorktreeLockError}). Concurrent
 * `session fork --worktree` calls race for the repo-level lock; the loser gets
 * a lock error even though a retry moments later succeeds. A NON-lock failure
 * is returned immediately and is NOT retried.
 *
 * IDEMPOTENCY: a prior aborted attempt can leave a half-created worktree dir
 * behind, which would make the next `worktree add` fail with "already exists".
 * Before each retry we prune git's stale-worktree registrations
 * (`git worktree prune`) and best-effort remove a leftover directory so the
 * retry starts from a clean slate rather than erroring on the leftover.
 *
 * @param git           the module's `git(repoRoot, args, onShellEvent?)` runner.
 * @param repoRoot      repo to run git in.
 * @param addArgs       the full `worktree add ...` arg string. RFC-04 D2:
 *                      this string is NEVER mutated by the observer path (no
 *                      `--progress` is smuggled in — that flag is invalid for
 *                      `git worktree add` on every git; see worktree-progress
 *                      doc). Observer-present and observer-absent runs issue a
 *                      byte-identical add command.
 * @param worktreePath  the dir the add targets (for leftover cleanup).
 * @param onShellEvent  RFC-04 D2 — OPTIONAL observer threaded ONLY to the
 *                      `worktree add` invocations (not the prune/remove
 *                      idempotency cleanup) so a caller can stream git's own
 *                      checkout output. Absent ⇒ byte-identical legacy path.
 * @returns the final {@link ShellResult}-shaped result (success, or the last
 *          failure if retries are exhausted / the failure was non-transient).
 */
export const runWorktreeAddWithRetry = async (
  git: (
    repoRoot: string,
    args: string,
    onShellEvent?: (event: RunShellEvent) => void,
  ) => Promise<ShellResult>,
  repoRoot: string,
  addArgs: string,
  worktreePath: string,
  onShellEvent?: (event: RunShellEvent) => void,
): Promise<ShellResult> => {
  let result = await git(repoRoot, addArgs, onShellEvent)
  for (let attempt = 1; attempt < MAX_WORKTREE_LOCK_RETRIES && result.exitCode !== 0; attempt++) {
    const stderr = `${result.stderr}\n${result.stdout}`
    // Non-lock failure ⇒ a genuine error; fail immediately, do not retry.
    if (!isTransientWorktreeLockError(stderr)) return result
    await sleep(WORKTREE_LOCK_BACKOFF_MS * attempt)
    // Idempotency: a lock-aborted attempt can leave a half-created worktree dir
    // and/or a stale registration behind, which would make the next add fail
    // with "already exists" instead of retrying the lock cleanly. Best-effort
    // remove the leftover dir, then prune git's stale-worktree records, so this
    // retry starts from a clean slate. Both are no-ops when nothing was left.
    await git(repoRoot, `worktree remove --force -- "${worktreePath}"`).catch(() => undefined)
    await git(repoRoot, "worktree prune").catch(() => undefined)
    result = await git(repoRoot, addArgs, onShellEvent)
  }
  return result
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
  // RFC-04 D2 — OPTIONAL observer forwarded to the `git worktree add` step so a
  // caller can stream git's own checkout output (parse via
  // `@/runtime/worktree-progress`). Absent ⇒ byte-identical legacy behavior.
  onShellEvent?: (event: RunShellEvent) => void,
): Promise<WorktreeRun<T>> => {
  if (!(await isGitRepo(repoRoot))) {
    throw new WorktreeError(`Not a git repository (or git unavailable): ${repoRoot}`)
  }

  const slug = safeId(id)
  const name = `agent-${slug}`
  const branch = `worktree-${slug}`
  const worktreePath = `${repoRoot}/.claude/worktrees/${name}`

  // Bounded retry on TRANSIENT git lock contention only (concurrent worktree
  // ops racing for the repo lock); a non-lock failure fails immediately.
  const add = await runWorktreeAddWithRetry(
    git,
    repoRoot,
    `worktree add --no-track -B ${branch} "${worktreePath}" HEAD`,
    worktreePath,
    onShellEvent,
  )
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
