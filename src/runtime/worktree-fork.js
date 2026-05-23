import { runShell } from "./shell";
import { isGitRepo, runWorktreeAddWithRetry } from "./worktree";
export class WorktreeForkError extends Error {
    detail;
    constructor(message, detail) {
        super(message);
        this.detail = detail;
        this.name = "WorktreeForkError";
    }
}
const git = async (repoRoot, args) => {
    // `args` is fully controlled by this module — every interpolated token is
    // first run through `safeId` / `safeBranch` / `safeRef` so a model/user-
    // provided string cannot inject shell metacharacters. Route through the
    // shared shell runner for env scrubbing + timeout parity with the rest of
    // runtime/.
    return runShell(`git ${args}`, { cwd: repoRoot });
};
/** Slugify an id into a filesystem-safe directory component. `/`, ` `, `;`
 *  etc. collapse to `-`; leading `-`/`.` are stripped so the result can never
 *  be parsed as a CLI flag or a hidden dotfile. Length-capped at 48. */
const safeId = (id) => {
    let cleaned = id.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48);
    // Strip leading "-" (CLI-flag confusion) and "." (hidden-file collision) —
    // defense in depth on top of the `--`-separator additions below.
    cleaned = cleaned.replace(/^[-.]+/, "");
    return cleaned.length > 0 ? cleaned : "x";
};
/** Sanitize a git BRANCH name. Branch names tolerate fewer chars than refs —
 *  notably no `~` / `^` / `:` / spaces. We allow `[A-Za-z0-9._/+-]`, strip
 *  leading `-` (CLI-flag confusion) and leading `.` (hidden-file), length-cap
 *  at 64. Empty input throws — branch names must be deliberate. */
const safeBranch = (s) => {
    const cleaned = s.replace(/[^A-Za-z0-9._/+-]/g, "-").slice(0, 64);
    const stripped = cleaned.replace(/^[-.]+/, "");
    if (stripped.length === 0) {
        throw new WorktreeForkError(`empty/invalid branch name after sanitization: ${JSON.stringify(s)}`);
    }
    return stripped;
};
/** Sanitize a git REF — more permissive than {@link safeBranch} because refs
 *  legitimately include `/` (`origin/main`), `~` and `^` (`HEAD~3`, `foo^1`),
 *  commit shas, etc. Pattern: `[A-Za-z0-9._/~^-]`. Rejects leading `-`
 *  (CLI-flag confusion), length-caps at 200. Empty / invalid input throws. */
const safeRef = (s) => {
    if (s.length === 0 || s.length > 200) {
        throw new WorktreeForkError(`invalid ref length: ${JSON.stringify(s)}`);
    }
    if (!/^[A-Za-z0-9._/~^-]+$/.test(s)) {
        throw new WorktreeForkError(`ref contains forbidden character: ${JSON.stringify(s)}`);
    }
    if (s.startsWith("-")) {
        throw new WorktreeForkError(`ref must not start with "-": ${JSON.stringify(s)}`);
    }
    return s;
};
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
export const createPersistentWorktree = async (id, repoRoot, opts) => {
    if (!(await isGitRepo(repoRoot))) {
        throw new WorktreeForkError(`Not a git repository (or git unavailable): ${repoRoot}`);
    }
    const slug = safeId(id);
    // Override-or-default — but always re-sanitize so a malicious branch name
    // (e.g. `; rm -rf /`) can't escape the `git` arg string we build below.
    // Branches use the stricter `safeBranch`; refs use the more-permissive
    // `safeRef` so `origin/main`, `HEAD~3`, commit shas, etc. survive intact.
    const branch = safeBranch(opts?.branch ?? `fork-${slug}`);
    const baseRef = safeRef(opts?.baseRef ?? "HEAD");
    const worktreePath = `${repoRoot}/.quanta/worktrees/${slug}`;
    // `-B` already delimits the branch arg; quoting + `--` after it gives belt-
    // and-braces protection in case a sanitized token still resembles a flag.
    // Bounded retry on TRANSIENT git lock contention only — concurrent
    // `session fork --worktree` calls race for the repo lock and the loser sees
    // a lock error that a moment-later retry clears. A NON-lock failure (bad
    // ref, etc.) is returned by the helper without retry and fails below.
    const add = await runWorktreeAddWithRetry(git, repoRoot, `worktree add --no-track -B "${branch}" -- "${worktreePath}" "${baseRef}"`, worktreePath);
    if (add.exitCode !== 0) {
        throw new WorktreeForkError(`git worktree add failed for ${slug}`, add.stderr.trim() || add.stdout.trim());
    }
    return { worktreePath, branch };
};
/** Force-remove a persistent worktree. Returns `true` when the worktree
 *  directory ends up gone — that includes the idempotent case where the
 *  worktree was already removed (`git worktree remove --force` exits non-zero
 *  on a missing worktree, but the caller's invariant — "this path no longer
 *  has a registered worktree" — is satisfied). Branch deletion is best-effort
 *  and does NOT affect the return value. Never throws. */
export const removeWorktree = async (worktreePath, repoRoot, opts) => {
    const rm = await git(repoRoot, `worktree remove --force -- "${worktreePath}"`);
    // Idempotent success: if the worktree directory is already gone (ENOENT in
    // git's error), treat the remove as a no-op success — the desired state has
    // been reached. Detect via stderr signal since `git worktree remove` does
    // not expose a typed exit code for this case.
    let ok = rm.exitCode === 0;
    if (!ok) {
        const err = `${rm.stderr}\n${rm.stdout}`.toLowerCase();
        if (err.includes("is not a working tree") ||
            err.includes("no such file") ||
            err.includes("not a valid working tree") ||
            err.includes("does not exist")) {
            ok = true;
        }
    }
    if (opts?.branch !== undefined && opts.branch !== "") {
        try {
            const branch = safeBranch(opts.branch);
            // `--` separator means even an unexpected leading-`-` slip cannot be
            // parsed as a CLI flag by `git branch`.
            await git(repoRoot, `branch -D -- "${branch}"`);
        }
        catch {
            // best-effort; branch may already be gone, still referenced, or the
            // input failed sanitization — none of those should fail the worktree
            // removal contract (the dir going away is what callers depend on).
        }
    }
    return ok;
};
