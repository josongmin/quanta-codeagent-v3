import { runShell } from "./shell";
export class WorktreeError extends Error {
    detail;
    constructor(message, detail) {
        super(message);
        this.detail = detail;
        this.name = "WorktreeError";
    }
}
const git = async (repoRoot, args) => {
    // `args` is fully controlled by this module (ids are sanitized); no
    // user/model string is interpolated. Run through the shared shell runner so
    // env scrubbing + timeout behavior match the rest of the runtime.
    return runShell(`git ${args}`, { cwd: repoRoot });
};
/** Bounded number of attempts for `git worktree add` when it loses the repo
 *  lock race against a concurrent worktree operation. Small on purpose — the
 *  contention window is brief, so a handful of tries with backoff converges. */
export const MAX_WORKTREE_LOCK_RETRIES = 5;
/** Base backoff between `git worktree add` retries. Multiplied by the attempt
 *  index for a light linear backoff so concurrent forks de-stagger. */
export const WORKTREE_LOCK_BACKOFF_MS = 50;
/** True only for TRANSIENT git LOCK-contention failures — a concurrent
 *  `git worktree add` / index write briefly held a repo lock. These are the
 *  ONLY failures we retry; any other non-zero exit (bad ref, branch exists for
 *  a different worktree, disk full, …) is a real error and must fail
 *  immediately, NOT be retried. Matches the stderr/stdout git emits for the
 *  lock race: `index.lock`, `worktrees/<name>/locked`, "already locked",
 *  "Unable to create '...lock'". */
export const isTransientWorktreeLockError = (stderr) => /index\.lock|worktrees?\/[^\s]*\/locked|already locked|unable to create.*\.lock|cannot lock ref/i.test(stderr);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
 * @param git           the module's `git(repoRoot, args)` runner.
 * @param repoRoot      repo to run git in.
 * @param addArgs       the full `worktree add ...` arg string.
 * @param worktreePath  the dir the add targets (for leftover cleanup).
 * @returns the final {@link ShellResult}-shaped result (success, or the last
 *          failure if retries are exhausted / the failure was non-transient).
 */
export const runWorktreeAddWithRetry = async (git, repoRoot, addArgs, worktreePath) => {
    let result = await git(repoRoot, addArgs);
    for (let attempt = 1; attempt < MAX_WORKTREE_LOCK_RETRIES && result.exitCode !== 0; attempt++) {
        const stderr = `${result.stderr}\n${result.stdout}`;
        // Non-lock failure ⇒ a genuine error; fail immediately, do not retry.
        if (!isTransientWorktreeLockError(stderr))
            return result;
        await sleep(WORKTREE_LOCK_BACKOFF_MS * attempt);
        // Idempotency: a lock-aborted attempt can leave a half-created worktree dir
        // and/or a stale registration behind, which would make the next add fail
        // with "already exists" instead of retrying the lock cleanly. Best-effort
        // remove the leftover dir, then prune git's stale-worktree records, so this
        // retry starts from a clean slate. Both are no-ops when nothing was left.
        await git(repoRoot, `worktree remove --force -- "${worktreePath}"`).catch(() => undefined);
        await git(repoRoot, "worktree prune").catch(() => undefined);
        result = await git(repoRoot, addArgs);
    }
    return result;
};
/** Slugify an id into the `/`-segment charset git worktree names allow. */
const safeId = (id) => {
    const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48);
    return cleaned.length > 0 ? cleaned : "x";
};
/** True when `repoRoot` is inside a git work tree and git is on PATH. */
export const isGitRepo = async (repoRoot) => {
    try {
        const r = await git(repoRoot, "rev-parse --is-inside-work-tree");
        return r.exitCode === 0 && r.stdout.trim() === "true";
    }
    catch {
        return false;
    }
};
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
export const withWorktree = async (id, repoRoot, fn) => {
    if (!(await isGitRepo(repoRoot))) {
        throw new WorktreeError(`Not a git repository (or git unavailable): ${repoRoot}`);
    }
    const slug = safeId(id);
    const name = `agent-${slug}`;
    const branch = `worktree-${slug}`;
    const worktreePath = `${repoRoot}/.claude/worktrees/${name}`;
    // Bounded retry on TRANSIENT git lock contention only (concurrent worktree
    // ops racing for the repo lock); a non-lock failure fails immediately.
    const add = await runWorktreeAddWithRetry(git, repoRoot, `worktree add --no-track -B ${branch} "${worktreePath}" HEAD`, worktreePath);
    if (add.exitCode !== 0) {
        throw new WorktreeError(`git worktree add failed for ${name}`, add.stderr.trim() || add.stdout.trim());
    }
    const forceRemove = async () => {
        try {
            await git(repoRoot, `worktree remove --force "${worktreePath}"`);
            await git(repoRoot, `branch -D ${branch}`);
        }
        catch {
            // best-effort cleanup; nothing actionable on failure
        }
    };
    let value;
    try {
        value = await fn(worktreePath);
    }
    catch (e) {
        await forceRemove();
        throw e;
    }
    // Clean ⇒ no tracked diff AND no untracked files.
    const status = await git(worktreePath, "status --porcelain");
    const dirty = status.exitCode !== 0 || status.stdout.trim().length > 0;
    let removed = false;
    if (!dirty) {
        const rm = await git(repoRoot, `worktree remove --force "${worktreePath}"`);
        if (rm.exitCode === 0) {
            await git(repoRoot, `branch -D ${branch}`);
            removed = true;
        }
    }
    return { value, info: { worktreePath, branch, removed } };
};
