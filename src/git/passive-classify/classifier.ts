/**
 * H6 (jun-3-misc §3) — PURE passive git/gh stdout classifier.
 *
 * Takes `{command, stdout, exitCode}` and derives a structured {@link VcsEvent}
 * (or `null` when nothing matched). NO I/O, NO throw, NO `Date.now`/`Math.random`.
 * Deterministic for a given input — drives a hellgate matrix directly.
 *
 * Reference: Claude Code's `g27` classifier vocabulary (cited per-pattern
 * inline). quanta's `src/git/directive-emit/parser.ts` only reads quanta's OWN
 * emitted `::git-*` lines; this classifier closes the raw-stdout blind spot for
 * git/gh commands the agent (or user) runs through the `bash` tool.
 *
 * Discipline:
 *  - exitCode !== 0  ⇒ NO event (a FAILED git op did not change VCS state; the
 *    `Fast-forward` etc. words could still appear in an error/help dump). This
 *    is the single most important false-positive guard.
 *  - non-git/gh command ⇒ NO event (the command must START with a `git`/`gh`
 *    invocation token — `echo "Fast-forward"` must NOT classify).
 *  - every pattern is anchored to a documented git/gh output line; no fuzzy
 *    "looks git-ish" heuristics.
 */

import type { PassiveVcsInput, VcsBranch, VcsCommit, VcsEvent, VcsPr, VcsPush } from "./types"

/**
 * Does the command actually INVOKE git or gh? We require the binary token to be
 * the command word, tolerating a leading env-var assignment prefix
 * (`GIT_AUTHOR_NAME=x git ...`) and absolute paths (`/usr/bin/git`). This is a
 * COMMAND-SHAPE gate, NOT a stdout heuristic — it exists so `echo "Merge made
 * by recursive"` (a non-git command whose OUTPUT contains a git phrase) cannot
 * produce a phantom event.
 *
 * Pattern: optional `VAR=val ` prefixes, then a path-or-bare `git`/`gh` token
 * followed by whitespace/end. We scan the FIRST simple-command only (up to the
 * first `|`, `;`, `&&`, `||`, newline) so `echo x && git merge` is recognized
 * via the segment containing git — handled by splitting on shell operators.
 */
const GIT_GH_TOKEN = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*\/)?(git|gh)(?:\s|$)/

/** Split the command on top-level shell sequencing operators so we can ask "is
 *  ANY simple-command a git/gh call?" without a full shell parser. We do not
 *  need POSIX-perfect splitting — only enough to reject `echo "git push"`
 *  (single segment, command word `echo`) while accepting `cd x && git merge`. */
const splitSimpleCommands = (command: string): string[] =>
  command.split(/\s*(?:&&|\|\||[;&|\n])\s*/).filter((s) => s.length > 0)

/** A HELP invocation (`git merge --help` / `git merge -h` / `git help merge`)
 *  changes NO VCS state but its stdout (the man page / usage dump) can contain a
 *  line-anchored `Fast-forward` (the FAST-FORWARD man-page section term),
 *  `Successfully rebased`, a `[branch sha]`-shaped example, or a `/pull/<N>`
 *  example URL — every one a false-positive trigger. The exitCode guard does NOT
 *  catch this (a help dump exits 0). We treat ANY git/gh segment carrying a help
 *  flag (or the `help` subcommand) as non-classifiable: it is purely
 *  documentation output, never a state change. Matches `--help` / `-h` /
 *  `--help=…` and a bare `help` subcommand token; scoped to the git/gh segment so
 *  it cannot be fooled by a `--help` elsewhere in an unrelated pipeline member. */
const HELP_FLAG = /(?:^|\s)(?:--help(?:=\S*)?|-h)(?:\s|$)/
const HELP_SUBCOMMAND = /^(?:git|gh)\s+help(?:\s|$)/

/** True when the git/gh-invoking segment is a HELP/usage request (no state
 *  change, documentation output only). Scanned over the SAME simple-command
 *  segments as {@link invokesGitOrGh} so only the actual git/gh segment is
 *  inspected. */
const isHelpInvocation = (command: string): boolean => {
  for (const raw of splitSimpleCommands(command)) {
    const seg = raw.trimStart()
    // Only inspect the actual git/gh segment (`.exec` returns null on no match —
    // NOT undefined — so a `null` check would let a `--help` on a NON-git segment
    // like `echo --help` falsely suppress a real git op in a later segment).
    if (GIT_GH_TOKEN.exec(seg) === null) continue
    if (HELP_SUBCOMMAND.test(seg) || HELP_FLAG.test(seg)) return true
  }
  return false
}

/** True when at least one simple-command segment invokes git or gh. */
const invokesGitOrGh = (command: string): "git" | "gh" | undefined => {
  for (const seg of splitSimpleCommands(command)) {
    const m = GIT_GH_TOKEN.exec(seg.trimStart())
    if (m) return m[1] as "git" | "gh"
  }
  return undefined
}

// ── stdout/command pattern probes (each cites its g27 reference) ──────────────

/** g27: `Fast-forward` OR `Merge made by` ⇒ a merge integrated history. The
 *  former is a fast-forward (no merge commit); the latter created a merge
 *  commit. Both map to `branch.action:"merged"`. */
const MERGE_LINE = /^(?:Fast-forward\b|Merge made by\b)/m
/** A true (non-fast-forward) merge prints `Merge made by the '<strategy>'
 *  strategy.` AND advances HEAD with a merge commit. */
const MERGE_COMMIT_LINE = /^Merge made by\b/m

/** g27: `Successfully rebased` ⇒ a rebase rewrote the branch. git prints
 *  `Successfully rebased and updated <ref>.` on success. */
const REBASE_LINE = /^Successfully rebased\b/m

/** g27: `--amend` ⇒ the commit rewrote HEAD. This is a COMMAND-shape signal
 *  (git's amend output is otherwise indistinguishable from a normal commit:
 *  `[branch sha] msg`). We anchor on the flag in the command, not stdout. */
const AMEND_FLAG = /(?:^|\s)--amend(?:\s|=|$)/

/** g27: cherry-pick. The COMMAND shape (`git cherry-pick ...`) plus a landed
 *  commit line (`[branch sha] msg`) identifies a successful pick. We anchor the
 *  KIND on the command (a cherry-pick that lands prints the same `[branch sha]`
 *  line as a normal commit) and the sha on the commit line. */
const CHERRY_PICK_CMD = /(?:^|\s)cherry-pick(?:\s|$)/

/** A landed commit prints `[<branch> <sha>] <subject>` (also `[<branch>
 *  (root-commit) <sha>] ...` for the first commit, and detached-HEAD
 *  `[detached HEAD <sha>] ...`). We capture the sha — the LAST token inside
 *  the bracket pair before `]`, which is the abbreviated hash. */
const COMMIT_BRACKET = /^\[[^\]]*?\b([0-9a-f]{7,40})\][^\n]*/m

/** `git reset --hard` / post-rebase prints `HEAD is now at <sha> <subject>`.
 *  Used as a secondary sha source (and as the amend/rebase sha when no
 *  `[branch sha]` line is present). */
const HEAD_NOW_AT = /^HEAD is now at ([0-9a-f]{7,40})\b/m

/** g27 push: a successful `git push` prints a ref-update line. Two shapes:
 *   - existing branch:   `   <old>..<new>  <local> -> <remote>`
 *   - new branch:        ` * [new branch]      <local> -> <remote>`
 *   - new tag:           ` * [new tag]         <local> -> <remote>`
 *  We capture `<local>` and `<remote>` around the ` -> ` arrow. The
 *  `Everything up-to-date` line is NOT a state change ⇒ excluded by requiring
 *  the arrow. */
const PUSH_REFLINE =
  /(?:^|\n)\s*(?:[0-9a-f]+\.\.[0-9a-f]+|\*\s*\[new [^\]]+\])\s+(\S+)\s*->\s*(\S+)/

/** gh PR: `gh pr create` / `gh pr view` print a PR URL
 *  (`https://github.com/<owner>/<repo>/pull/<N>`). `gh pr merge` and some hub
 *  flows print `Pull request #N`. We accept BOTH and capture N. */
const PR_URL = /https?:\/\/[^\s]*\/pull\/(\d+)\b/
const PR_HASH = /\bPull request #(\d+)\b/

// ── derivation helpers ───────────────────────────────────────────────────────

const firstSha = (stdout: string): string | undefined => {
  const bracket = COMMIT_BRACKET.exec(stdout)
  if (bracket) return bracket[1]
  const head = HEAD_NOW_AT.exec(stdout)
  if (head) return head[1]
  return undefined
}

const deriveCommit = (input: PassiveVcsInput): VcsCommit | undefined => {
  const { command, stdout } = input
  const sha = firstSha(stdout)

  // Cherry-pick is the most specific command-shape ⇒ check first.
  if (CHERRY_PICK_CMD.test(command)) {
    // A cherry-pick that landed a commit prints `[branch sha]`; a no-op /
    // empty pick (`--allow-empty` aside) does not. Require the sha so an
    // `--abort` / `--continue` with no landed commit produces no commit facet.
    if (sha !== undefined) return { kind: "cherry-pick", sha }
    return undefined
  }

  // Amend is a command-shape signal (stdout is identical to a normal commit).
  if (AMEND_FLAG.test(command)) {
    return sha !== undefined ? { kind: "amend", sha } : { kind: "amend" }
  }

  // A non-fast-forward merge created a merge commit.
  if (MERGE_COMMIT_LINE.test(stdout)) {
    return sha !== undefined ? { kind: "merge", sha } : { kind: "merge" }
  }

  // A plain commit prints `[branch sha] subject`.
  if (sha !== undefined && COMMIT_BRACKET.test(stdout)) {
    return { kind: "commit", sha }
  }

  return undefined
}

const deriveBranch = (input: PassiveVcsInput): VcsBranch | undefined => {
  const { command, stdout } = input
  // `--amend` rewrote the branch tip ⇒ amended.
  if (AMEND_FLAG.test(command)) return { action: "amended" }
  // `Successfully rebased` ⇒ rebased.
  if (REBASE_LINE.test(stdout)) return { action: "rebased" }
  // `Fast-forward` / `Merge made by` ⇒ merged.
  if (MERGE_LINE.test(stdout)) return { action: "merged" }
  return undefined
}

/** `git push --dry-run` / `-n` exits 0 and prints a ref-update line
 *  BYTE-IDENTICAL to a real push (`<old>..<new>  <local> -> <remote>`) even
 *  though NOTHING was pushed. The exitCode guard cannot catch it (a dry-run
 *  succeeds). The only signal that no state changed is the COMMAND flag, so we
 *  suppress the push facet on a dry-run — same command-shape discipline the
 *  `--amend` path uses. `-n` is git-push's documented short alias of
 *  `--dry-run`. We scope the flag scan to the git PUSH simple-command segment
 *  (the segment whose first non-flag token after `git` is `push`) so a chained
 *  `git commit -n && git push origin main` (where `-n` is commit's
 *  `--no-verify`) does NOT falsely suppress the REAL push in the next segment. */
const PUSH_SUBCOMMAND =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*\/)?git\s+(?:-\S+\s+)*push(?:\s|$)/
const PUSH_DRY_RUN_FLAG = /(?:^|\s)(?:--dry-run|-n)(?:\s|$)/

/** True when a `git push` invocation in `command` carries `--dry-run`/`-n`. The
 *  flag is matched only WITHIN the push segment so an unrelated `-n` elsewhere
 *  in a pipeline cannot suppress a real push. */
const isDryRunPush = (command: string): boolean => {
  for (const raw of splitSimpleCommands(command)) {
    const seg = raw.trimStart()
    if (!PUSH_SUBCOMMAND.test(seg)) continue
    if (PUSH_DRY_RUN_FLAG.test(seg)) return true
  }
  return false
}

const derivePush = (input: PassiveVcsInput): VcsPush | undefined => {
  // A dry-run pushed nothing — its ref-line is indistinguishable from a real
  // push in stdout, so we gate on the command flag (scoped to the push segment).
  if (isDryRunPush(input.command)) return undefined
  const m = PUSH_REFLINE.exec(input.stdout)
  if (!m) return undefined
  const localRef = m[1]
  const remoteRef = m[2]
  const out: { localRef?: string; remoteRef?: string } = {}
  if (localRef !== undefined) out.localRef = localRef
  if (remoteRef !== undefined) out.remoteRef = remoteRef
  return out
}

const derivePr = (input: PassiveVcsInput): VcsPr | undefined => {
  const url = PR_URL.exec(input.stdout)
  if (url?.[1] !== undefined) {
    const n = Number.parseInt(url[1], 10)
    return Number.isInteger(n) ? { number: n, url: url[0] } : undefined
  }
  const hash = PR_HASH.exec(input.stdout)
  if (hash?.[1] !== undefined) {
    const n = Number.parseInt(hash[1], 10)
    return Number.isInteger(n) ? { number: n } : undefined
  }
  return undefined
}

/**
 * Classify ONE git/gh invocation into a structured {@link VcsEvent}.
 *
 * Returns `null` when:
 *  - `exitCode !== 0` (the op failed — no state change to observe).
 *  - the command did NOT invoke git/gh (non-VCS command — no phantom events).
 *  - NO pattern matched (a benign git op like `git status`).
 *
 * NEVER throws. The function is pure and total over the input domain.
 */
export const classifyPassiveVcs = (input: PassiveVcsInput): VcsEvent | null => {
  // Guard 1: a FAILED command changed nothing observable. The `Fast-forward` /
  // `Merge made by` words can appear in a `git merge --help` dump or an error
  // ("Automatic merge failed; ... Merge made by" is NOT a thing, but defense in
  // depth) — gating on exitCode===0 is the authoritative false-positive cut.
  if (input.exitCode !== 0) return null

  // Guard 2: the command must actually invoke git or gh. `echo "git push ..."`
  // (command word `echo`) is rejected here even though its stdout contains a
  // push ref-line.
  if (invokesGitOrGh(input.command) === undefined) return null

  // Guard 3: a HELP/usage invocation (`git merge --help`, `git merge -h`,
  // `git help merge`) exits 0 but changes NO state — its man-page/usage stdout
  // can contain a line-anchored `Fast-forward` / `Successfully rebased` / a
  // `[branch sha]` example / a `/pull/N` example URL, each a false-positive
  // trigger the exitCode guard cannot catch. Documentation output never
  // classifies.
  if (isHelpInvocation(input.command)) return null

  const commit = deriveCommit(input)
  const branch = deriveBranch(input)
  const push = derivePush(input)
  const pr = derivePr(input)

  // No facet matched ⇒ null (NOT an empty object). The bash hook treats null as
  // "emit nothing".
  if (commit === undefined && branch === undefined && push === undefined && pr === undefined) {
    return null
  }

  const event: {
    commit?: VcsCommit
    branch?: VcsBranch
    push?: VcsPush
    pr?: VcsPr
  } = {}
  if (commit !== undefined) event.commit = commit
  if (branch !== undefined) event.branch = branch
  if (push !== undefined) event.push = push
  if (pr !== undefined) event.pr = pr
  return event
}
