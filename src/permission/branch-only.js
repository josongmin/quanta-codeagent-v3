/**
 * Branch-only git write guard — RFC may-22 ci-bot mode.
 *
 * Propositional check on a shell command: is this operation forbidden by the
 * `gitWrite: { kind: "branch-only"; protectedBranches: string[] }` lever?
 *
 * Forbidden operations (in ci-bot mode):
 *   1. Any `git push` whose REFSPEC targets a protected branch
 *   2. Any `git commit` while HEAD is on a protected branch
 *   3. Any `git merge` / `git rebase` onto a protected branch
 *   4. Any `git reset --hard` to a protected-branch ref
 *
 * Default protected branches: `main`, `master`, `develop`, `production`.
 *
 * Signal: command-string properties (split + token match). No counts, no
 * thresholds. Returns `{allowed: true} | {allowed: false, reason}`.
 */
/** Canonical protected-branch list for ci-bot. Operator can override per
 *  mode policy. */
export const DEFAULT_PROTECTED_BRANCHES = Object.freeze([
    "main",
    "master",
    "develop",
    "production",
]);
/** Tokenize a shell command. Conservative: splits on whitespace only — pipes
 *  and `&&` chains are handled by the caller (each clause classified). */
const tokenize = (cmd) => cmd
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
/** Does this token list look like `git <subcmd>` (allowing `-c key=val` flags
 *  between git and the subcommand)? Returns the subcommand name or `null`. */
const gitSubcommand = (toks) => {
    if (toks.length < 2 || toks[0] !== "git")
        return null;
    let i = 1;
    while (i < toks.length) {
        const t = toks[i];
        if (t === "-c" || t === "--git-dir" || t === "--work-tree" || t === "-C") {
            i += 2;
            continue;
        }
        if (t?.startsWith("--git-dir=") || t?.startsWith("--work-tree=")) {
            i += 1;
            continue;
        }
        return t ?? null;
    }
    return null;
};
/** Is `refspec` a (qualified) reference to one of the protected branches?
 *  Handles: `main`, `+main` (force), `refs/heads/main`, `origin/main`,
 *  `foo:main` / `+foo:main` (push spec), `HEAD:main`. */
const targetsProtectedBranch = (refspec, protectedBranches) => {
    // Audit R2 fix: strip the leading `+` force marker FIRST — `+main` is a
    // force-push to main and must be caught the same as `main`.
    const unforced = refspec.startsWith("+") ? refspec.slice(1) : refspec;
    // `local:remote` push spec ⇒ check the remote (right) side
    const remote = unforced.includes(":") ? (unforced.split(":")[1] ?? "") : unforced;
    // Strip `refs/heads/` or `origin/` prefix
    const branch = remote.replace(/^refs\/heads\//, "").replace(/^[^/]+\//, "");
    return protectedBranches.includes(branch);
};
/** Detect a `-c alias.<name>=<value>` config injection in the token stream.
 *  Audit R2 fix: `git -c alias.x=push x origin main` smuggles a push past
 *  subcommand detection (the visible subcommand is `x`, not `push`). Under
 *  branch-only we cannot resolve what an injected alias expands to, so its
 *  presence is itself a denial. Covers both `-c alias.x=…` and `-calias.x=…`. */
const hasAliasConfigInjection = (toks) => {
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i] ?? "";
        if (t === "-c" && /^alias\./i.test(toks[i + 1] ?? ""))
            return true;
        if (/^-c\s*alias\./i.test(t))
            return true; // -calias.x=… (glued form)
        if (t.startsWith("--config-env=alias."))
            return true;
    }
    return false;
};
/** Decide for ONE shell command. Caller is responsible for splitting `&&`/`;`
 *  pipelines if it wants per-clause precision (recommended). */
export const decideBranchOnly = (command, protectedBranches = DEFAULT_PROTECTED_BRANCHES, currentBranch) => {
    const toks = tokenize(command);
    // Audit R2 fix: a `-c alias.*=` config injection can smuggle a push behind
    // an arbitrary subcommand name. We cannot resolve the alias, so deny.
    if (hasAliasConfigInjection(toks)) {
        return {
            allowed: false,
            reason: "git -c alias.* config injection is not permitted under gitWrite=branch-only (can hide a protected-branch push).",
        };
    }
    const sub = gitSubcommand(toks);
    if (sub === null)
        return { allowed: true };
    // push: scan refspec args
    if (sub === "push") {
        // After `git push`, args are `[remote] [refspec...]` or `--all` flags
        const after = toks.slice(toks.indexOf(sub) + 1).filter((t) => !t.startsWith("-"));
        // `git push` with no args pushes the current upstream — if HEAD is on a
        // protected branch, that's a violation
        if (after.length <= 1 && currentBranch && protectedBranches.includes(currentBranch)) {
            return {
                allowed: false,
                reason: `git push from protected branch '${currentBranch}' denied (gitWrite=branch-only). Switch to a feature branch first.`,
            };
        }
        // With refspec(s): each one must NOT target protected
        for (const ref of after.slice(1)) {
            if (targetsProtectedBranch(ref, protectedBranches)) {
                return {
                    allowed: false,
                    reason: `git push to protected branch (refspec '${ref}') denied (gitWrite=branch-only).`,
                };
            }
        }
        return { allowed: true };
    }
    // commit / merge / rebase / reset on a protected current branch
    if (sub === "commit" || sub === "merge" || sub === "rebase") {
        if (currentBranch && protectedBranches.includes(currentBranch)) {
            return {
                allowed: false,
                reason: `git ${sub} on protected branch '${currentBranch}' denied (gitWrite=branch-only). Create a feature branch first.`,
            };
        }
        return { allowed: true };
    }
    if (sub === "reset") {
        // `git reset --hard origin/main` etc.
        const after = toks.slice(toks.indexOf(sub) + 1).filter((t) => !t.startsWith("-"));
        for (const ref of after) {
            if (targetsProtectedBranch(ref, protectedBranches)) {
                return {
                    allowed: false,
                    reason: `git reset to protected branch ref '${ref}' denied (gitWrite=branch-only).`,
                };
            }
        }
        return { allowed: true };
    }
    return { allowed: true };
};
