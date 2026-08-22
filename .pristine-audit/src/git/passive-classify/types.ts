/**
 * H6 (jun-3-misc §3) — Structured VCS event types derived from PASSIVE
 * git/gh stdout classification.
 *
 * Sibling concern to `src/git/directive-emit/` (which only reads quanta's OWN
 * emitted `::git-*` lines). This slice models the BLIND SPOT: a raw
 * `git rebase` / `git merge` / `git cherry-pick` / `gh pr create` that the
 * agent (or user) ran through the `bash` tool. The classifier reads the
 * command + stdout + exitCode and derives the same structured shape that an
 * explicit `::git-*` directive would have carried, so turn-diff / PR-state
 * observability comes "for free".
 *
 * Discriminated unions everywhere — adding a new branch action / commit kind
 * is a compile error at every exhaustive consumer.
 */

import type { VcsPrAction } from "./pr-action"

export type { VcsPrAction } from "./pr-action"

/** What kind of commit-producing operation landed. CLOSED enum. */
export type VcsCommitKind =
  | "commit" // plain `git commit` (`[branch sha] msg`)
  | "amend" // `git commit --amend` (rewrote HEAD)
  | "cherry-pick" // `git cherry-pick` landed a commit
  | "merge" // a merge produced a merge commit (`Merge made by`)

/** The action a branch underwent when no NEW commit sha is the salient signal
 *  (history rewrite / integration). CLOSED enum mirroring Claude's `g27`
 *  classifier vocabulary. */
export type VcsBranchAction = "merged" | "rebased" | "amended"

/** A commit observed in the output. `sha` is the short-or-long hash when the
 *  output exposed one (`[branch sha] msg`, `HEAD is now at sha`,
 *  cherry-pick `[branch sha]`); absent when the op succeeded but printed no
 *  sha (e.g. some `--amend` paths under `--quiet`). */
export interface VcsCommit {
  readonly kind: VcsCommitKind
  readonly sha?: string
  /** The branch the commit landed on, read LITERALLY from the leading token of
   *  the matched `[<branch> <sha>]` bracket. Omitted (never guessed) when the
   *  bracket is absent, is a `[detached HEAD <sha>]`, or is otherwise ambiguous.
   *  A `(root-commit)` / `(<n> commits)` parenthetical is stripped. */
  readonly branch?: string
}

/** A push that succeeded. `remote`/`branch` are parsed from the `to..from`
 *  ref line (`<old>..<new>  <local> -> <remote>`) or the
 *  `* [new branch] <local> -> <remote>` line when present. */
export interface VcsPush {
  /** The local ref pushed (left of `->`), when parseable. */
  readonly localRef?: string
  /** The remote ref pushed (right of `->`), when parseable. */
  readonly remoteRef?: string
}

/** A branch-level action (history rewrite or integration). */
export interface VcsBranch {
  readonly action: VcsBranchAction
}

/** A pull-request reference parsed from `gh pr` output (`Pull request #N` or
 *  a `https://github.com/owner/repo/pull/N` URL). */
export interface VcsPr {
  readonly number: number
  /** The PR URL when gh printed one. */
  readonly url?: string
  /** The action the `gh pr <verb>` invocation performed, from the exact argv
   *  command-shape ({@link VcsPrAction} grammar). Emitted ONLY with an
   *  authoritative PR identity (argv number or stdout URL/#N) and exit 0;
   *  omitted for read-only verbs, conflicting flags, and ambiguous argv. */
  readonly action?: VcsPrAction
}

/**
 * The structured VCS event derived from ONE git/gh invocation. Every field is
 * OPTIONAL: a single command can surface several facets at once (a merge prints
 * both a `branch.action:"merged"` AND, for a non-fast-forward merge, a
 * `commit.kind:"merge"`). A command that matched NO pattern produces `null`
 * (see {@link classifyPassiveVcs}) — never an empty `{}`.
 *
 * Shape intentionally mirrors the H6 spec literal:
 *   `{commit:{sha,kind}, push, branch:{action}, pr:{number}}`.
 */
export interface VcsEvent {
  readonly commit?: VcsCommit
  readonly push?: VcsPush
  readonly branch?: VcsBranch
  readonly pr?: VcsPr
}

/** Input to the pure classifier — exactly what the bash post-exec hook has in
 *  hand (the command string it ran + the combined stdout/stderr body + the
 *  process exit code). */
export interface PassiveVcsInput {
  readonly command: string
  /** Combined stdout + stderr. git/gh write progress to stderr and the
   *  `[branch sha]` / `Pull request #N` lines to stdout; the hook passes the
   *  union so a single regex sweep sees both. */
  readonly stdout: string
  readonly exitCode: number
}
