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
export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = Object.freeze([
  "main",
  "master",
  "develop",
  "production",
])

export type BranchOnlyVerdict = { allowed: true } | { allowed: false; reason: string }

/** Tokenize a shell command. Conservative: splits on whitespace only — pipes
 *  and `&&` chains are handled by the caller (each clause classified). */
const tokenize = (cmd: string): string[] =>
  cmd
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)

/** Does this token list look like `git <subcmd>` (allowing `-c key=val` flags
 *  between git and the subcommand)? Returns the subcommand name or `null`. */
const gitSubcommand = (toks: readonly string[]): string | null => {
  if (toks.length < 2 || toks[0] !== "git") return null
  let i = 1
  while (i < toks.length) {
    const t = toks[i]
    if (t === "-c" || t === "--git-dir" || t === "--work-tree" || t === "-C") {
      i += 2
      continue
    }
    if (t?.startsWith("--git-dir=") || t?.startsWith("--work-tree=")) {
      i += 1
      continue
    }
    return t ?? null
  }
  return null
}

/** Is `refspec` a (qualified) reference to one of the protected branches?
 *  Handles: `main`, `+main` (force), `refs/heads/main`, `origin/main`,
 *  `foo:main` / `+foo:main` (push spec), `HEAD:main`. */
const targetsProtectedBranch = (refspec: string, protectedBranches: readonly string[]): boolean => {
  // Audit R2 fix: strip the leading `+` force marker FIRST — `+main` is a
  // force-push to main and must be caught the same as `main`.
  const unforced = refspec.startsWith("+") ? refspec.slice(1) : refspec
  // `local:remote` push spec ⇒ check the remote (right) side
  const remote = unforced.includes(":") ? (unforced.split(":")[1] ?? "") : unforced
  // Strip `refs/heads/` or `origin/` prefix
  const branch = remote.replace(/^refs\/heads\//, "").replace(/^[^/]+\//, "")
  return protectedBranches.includes(branch)
}

/** Detect a `-c alias.<name>=<value>` config injection in the token stream.
 *  Audit R2 fix: `git -c alias.x=push x origin main` smuggles a push past
 *  subcommand detection (the visible subcommand is `x`, not `push`). Under
 *  branch-only we cannot resolve what an injected alias expands to, so its
 *  presence is itself a denial. Covers both `-c alias.x=…` and `-calias.x=…`. */
const hasAliasConfigInjection = (toks: readonly string[]): boolean => {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] ?? ""
    if (t === "-c" && /^alias\./i.test(toks[i + 1] ?? "")) return true
    if (/^-c\s*alias\./i.test(t)) return true // -calias.x=… (glued form)
    if (t.startsWith("--config-env=alias.")) return true
  }
  return false
}

/** Verdict constructors. `allow()` stays a factory (not a shared frozen
 *  singleton) so every call site keeps returning a fresh object, exactly as the
 *  inline `return { allowed: true }` statements did. */
const allow = (): BranchOnlyVerdict => ({ allowed: true })
const deny = (reason: string): BranchOnlyVerdict => ({ allowed: false, reason })

/** The `git push` denial cascade, in the order it must run: wholesale-ref
 *  flags, wildcard refspecs, the no-refspec/upstream case, then each explicit
 *  refspec. A unit because these four rules only make sense together — each one
 *  exists to close a hole the previous one leaves open, and the ORDER is the
 *  contract (a wildcard refspec must be rejected as wholesale, not evaluated as
 *  a branch name). `pushToks` = every token after `push`. */
const pushVerdict = (
  pushToks: readonly string[],
  protectedBranches: readonly string[],
  currentBranch: string | undefined,
): BranchOnlyVerdict => {
  // Audit fix: `--all` / `--mirror` / `--tags` push REFS WHOLESALE without
  // any positional refspec, so the positional scan below (which strips all
  // dash-flags) never sees a protected-branch token and would let them slip.
  // `--all` pushes every local branch (incl. main), `--mirror` mirrors every
  // ref (branches+tags+refs/*), `--tags` pushes all tags. Each can clobber a
  // protected branch from a feature branch — deny before positional checks.
  // Mirrors the `isDestructive` flag-scan in the reset block below.
  const isWildcardPush = pushToks.some((t) => t === "--all" || t === "--mirror" || t === "--tags")
  if (isWildcardPush) {
    return deny(
      "git push --all/--mirror/--tags pushes refs wholesale and can clobber a protected branch; denied (gitWrite=branch-only). Push an explicit feature-branch refspec instead.",
    )
  }
  // After `git push`, args are `[remote] [refspec...]` or `--all` flags
  const after = pushToks.filter((t) => !t.startsWith("-"))
  const refspecs = after.slice(1)
  // Audit H3 fix: a WILDCARD/glob refspec (`refs/heads/*:refs/heads/*`,
  // `*:*`, `refs/heads/*`) pushes EVERY matching local branch — incl.
  // main/master — exactly like `--all`, but as a POSITIONAL refspec the
  // `--all` flag-scan above never sees it and `targetsProtectedBranch`
  // (which compares against an explicit branch name) cannot match `*`.
  // An unresolvable glob destination cannot be PROVEN to spare a protected
  // branch, so under branch-only it must fail closed — deny any refspec
  // token containing `*` on EITHER side (src or dest). Mirrors the `--all`
  // denial: wholesale push that can clobber a protected branch.
  for (const ref of refspecs) {
    if (ref.includes("*")) {
      return deny(
        `git push with wildcard refspec '${ref}' pushes refs wholesale and cannot be proven to spare a protected branch; denied (gitWrite=branch-only). Push an explicit feature-branch refspec instead.`,
      )
    }
  }
  // `git push` with no args pushes the current upstream — if HEAD is on a
  // protected branch, that's a violation
  if (after.length <= 1 && currentBranch && protectedBranches.includes(currentBranch)) {
    return deny(
      `git push from protected branch '${currentBranch}' denied (gitWrite=branch-only). Switch to a feature branch first.`,
    )
  }
  // With refspec(s): each one must NOT target protected
  for (const ref of refspecs) {
    if (targetsProtectedBranch(ref, protectedBranches)) {
      return deny(`git push to protected branch (refspec '${ref}') denied (gitWrite=branch-only).`)
    }
  }
  return allow()
}

/** commit / merge / rebase: one rule — the operation writes HEAD's own branch,
 *  so it is forbidden exactly when HEAD is protected. A unit because all three
 *  subcommands share this single rule and its message. */
const headWriteVerdict = (
  sub: string,
  protectedBranches: readonly string[],
  currentBranch: string | undefined,
): BranchOnlyVerdict => {
  if (currentBranch && protectedBranches.includes(currentBranch)) {
    return deny(
      `git ${sub} on protected branch '${currentBranch}' denied (gitWrite=branch-only). Create a feature branch first.`,
    )
  }
  return allow()
}

/** `git reset`: two independent rules — a destructive reset ON a protected
 *  branch (regardless of target ref), and any reset whose target ref IS a
 *  protected branch. A unit because the two together are what "reset is safe"
 *  means; splitting them invites re-introducing the L8 H1 hole. `allToks` =
 *  every token after `reset`, flags included. */
const resetVerdict = (
  allToks: readonly string[],
  protectedBranches: readonly string[],
  currentBranch: string | undefined,
): BranchOnlyVerdict => {
  const after = allToks.filter((t) => !t.startsWith("-"))
  // Audit L8 H1 fix: a DESTRUCTIVE reset (`--hard`/`--merge`/`--keep`) while
  // HEAD is on a protected branch moves/discards the PROTECTED branch's own
  // history — even when no explicit ref is named (`git reset --hard`,
  // `git reset --hard HEAD~1`, `git reset --hard @{u}`). The prior code only
  // denied when an explicit protected-branch REF was the target, so a
  // working-on-main `git reset --hard origin/main`→ caught, but a bare
  // `git reset --hard HEAD~3` on main → fell through to allow and rewrote
  // the protected branch. Deny any destructive reset on a protected current
  // branch, regardless of (or absent) the target ref.
  const isDestructive = allToks.some((t) => t === "--hard" || t === "--merge" || t === "--keep")
  if (isDestructive && currentBranch && protectedBranches.includes(currentBranch)) {
    return deny(
      `destructive git reset on protected branch '${currentBranch}' denied (gitWrite=branch-only). It rewrites the protected branch — switch to a feature branch first.`,
    )
  }
  // `git reset --hard origin/main` etc. — explicit protected-branch target.
  for (const ref of after) {
    if (targetsProtectedBranch(ref, protectedBranches)) {
      return deny(`git reset to protected branch ref '${ref}' denied (gitWrite=branch-only).`)
    }
  }
  return allow()
}

/** Decide for ONE shell command. Caller is responsible for splitting `&&`/`;`
 *  pipelines if it wants per-clause precision (recommended). */
export const decideBranchOnly = (
  command: string,
  protectedBranches: readonly string[] = DEFAULT_PROTECTED_BRANCHES,
  currentBranch?: string,
): BranchOnlyVerdict => {
  const toks = tokenize(command)
  // Audit R2 fix: a `-c alias.*=` config injection can smuggle a push behind
  // an arbitrary subcommand name. We cannot resolve the alias, so deny.
  if (hasAliasConfigInjection(toks)) {
    return deny(
      "git -c alias.* config injection is not permitted under gitWrite=branch-only (can hide a protected-branch push).",
    )
  }
  const sub = gitSubcommand(toks)
  if (sub === null) return allow()
  const rest = toks.slice(toks.indexOf(sub) + 1)
  if (sub === "push") return pushVerdict(rest, protectedBranches, currentBranch)
  if (sub === "commit" || sub === "merge" || sub === "rebase") {
    return headWriteVerdict(sub, protectedBranches, currentBranch)
  }
  if (sub === "reset") return resetVerdict(rest, protectedBranches, currentBranch)
  return allow()
}
