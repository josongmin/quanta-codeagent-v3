import { realpath } from "node:fs/promises"
import { runShell } from "./shell"
import { isGitRepo, runWorktreeAddWithRetry } from "./worktree"
import { findByExactPath, inspectWorktrees, type WorktreeInspection } from "./worktree-inspect"

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
  // first run through `safeId` / `safeBranch` / `safeRef` so a model/user-
  // provided string cannot inject shell metacharacters. Route through the
  // shared shell runner for env scrubbing + timeout parity with the rest of
  // runtime/.
  return runShell(`git ${args}`, { cwd: repoRoot })
}

/** Slugify an id into a filesystem-safe directory component. `/`, ` `, `;`
 *  etc. collapse to `-`; leading `-`/`.` are stripped so the result can never
 *  be parsed as a CLI flag or a hidden dotfile. Length-capped at 48. */
const safeId = (id: string): string => {
  let cleaned = id.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48)
  // Strip leading "-" (CLI-flag confusion) and "." (hidden-file collision) —
  // defense in depth on top of the `--`-separator additions below.
  cleaned = cleaned.replace(/^[-.]+/, "")
  return cleaned.length > 0 ? cleaned : "x"
}

/** Sanitize a git BRANCH name. Branch names tolerate fewer chars than refs —
 *  notably no `~` / `^` / `:` / spaces. We allow `[A-Za-z0-9._/+-]`, strip
 *  leading `-` (CLI-flag confusion) and leading `.` (hidden-file), length-cap
 *  at 64. Empty input throws — branch names must be deliberate. */
const safeBranch = (s: string): string => {
  const cleaned = s.replace(/[^A-Za-z0-9._/+-]/g, "-").slice(0, 64)
  const stripped = cleaned.replace(/^[-.]+/, "")
  if (stripped.length === 0) {
    throw new WorktreeForkError(
      `empty/invalid branch name after sanitization: ${JSON.stringify(s)}`,
    )
  }
  return stripped
}

/** Sanitize a git REF — more permissive than {@link safeBranch} because refs
 *  legitimately include `/` (`origin/main`), `~` and `^` (`HEAD~3`, `foo^1`),
 *  commit shas, etc. Pattern: `[A-Za-z0-9._/~^-]`. Rejects leading `-`
 *  (CLI-flag confusion), length-caps at 200. Empty / invalid input throws. */
const safeRef = (s: string): string => {
  if (s.length === 0 || s.length > 200) {
    throw new WorktreeForkError(`invalid ref length: ${JSON.stringify(s)}`)
  }
  if (!/^[A-Za-z0-9._/~^-]+$/.test(s)) {
    throw new WorktreeForkError(`ref contains forbidden character: ${JSON.stringify(s)}`)
  }
  if (s.startsWith("-")) {
    throw new WorktreeForkError(`ref must not start with "-": ${JSON.stringify(s)}`)
  }
  return s
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
  // Branches use the stricter `safeBranch`; refs use the more-permissive
  // `safeRef` so `origin/main`, `HEAD~3`, commit shas, etc. survive intact.
  const branch = safeBranch(opts?.branch ?? `fork-${slug}`)
  const baseRef = safeRef(opts?.baseRef ?? "HEAD")
  const worktreePath = `${repoRoot}/.quanta/worktrees/${slug}`

  // `-B` already delimits the branch arg; quoting + `--` after it gives belt-
  // and-braces protection in case a sanitized token still resembles a flag.
  // Bounded retry on TRANSIENT git lock contention only — concurrent
  // `session fork --worktree` calls race for the repo lock and the loser sees
  // a lock error that a moment-later retry clears. A NON-lock failure (bad
  // ref, etc.) is returned by the helper without retry and fails below.
  const add = await runWorktreeAddWithRetry(
    git,
    repoRoot,
    `worktree add --no-track -B "${branch}" -- "${worktreePath}" "${baseRef}"`,
    worktreePath,
  )
  if (add.exitCode !== 0) {
    throw new WorktreeForkError(
      `git worktree add failed for ${slug}`,
      add.stderr.trim() || add.stdout.trim(),
    )
  }

  return { worktreePath, branch }
}

/** RFC-06 §RFC06-1 — typed outcome of a hardened worktree removal. Callers
 *  branch on this instead of a bare boolean so a REFUSAL (dirty/locked) is
 *  distinct from IDEMPOTENT-ABSENCE and from a real REMOVE. `branchDeleted`
 *  reports the separate post-remove branch-delete step; it is never the reason
 *  a removal is called successful. */
export type RemoveOutcome =
  /** The exact-registered worktree was cleanly removed (non-force). */
  | { readonly kind: "removed"; readonly branchDeleted: boolean }
  /** No worktree was registered at the exact path — the desired end state
   *  ("this path no longer has a registered worktree") is ALREADY satisfied.
   *  Idempotency is judged by porcelain ABSENCE, never by a stderr substring. */
  | { readonly kind: "absent"; readonly branchDeleted: boolean }
  /** Removal was REFUSED because the worktree is not safely removable
   *  (dirty / locked). NOT assumed removed — the caller reports/quarantines. */
  | { readonly kind: "refused"; readonly reason: RemoveRefusalReason }
  /** Git inspection or the remove command itself errored. Report-only —
   *  the target state is UNKNOWN and must never be assumed removed. */
  | { readonly kind: "error"; readonly error: string }

export type RemoveRefusalReason = "dirty" | "locked" | "remove_failed"

/**
 * Match a target path against the porcelain registry accounting for symlinked
 * path roots. Git reports the REALPATH of a worktree (on macOS `/tmp` →
 * `/private/tmp`), while the caller's persisted `path` may carry the symlink
 * form (whatever `repoRoot` string was passed at create time). We resolve the
 * target's realpath (best-effort — a removed dir has none) and try BOTH the
 * realpath and the raw string against each registered path (itself also
 * realpath-resolved defensively). This is NOT path INFERENCE — it is exact
 * identity under filesystem canonicalization; no substring/prefix/name guess.
 */
const findRegisteredMatch = async (
  worktrees: readonly WorktreeInspection[],
  targetPath: string,
): Promise<WorktreeInspection | undefined> => {
  // Fast path: verbatim match (covers the common non-symlinked case).
  const exact = findByExactPath(worktrees, targetPath)
  if (exact !== undefined) return exact
  const targetReal = await realpath(targetPath).catch(() => undefined)
  const candidates = new Set<string>([targetPath])
  if (targetReal !== undefined) candidates.add(targetReal)
  for (const w of worktrees) {
    if (candidates.has(w.path)) return w
    const wReal = await realpath(w.path).catch(() => undefined)
    if (wReal !== undefined && candidates.has(wReal)) return w
  }
  return undefined
}

/** `git status --porcelain` inside the worktree — non-empty ⇒ dirty
 *  (uncommitted/untracked). Returns `undefined` when git itself errored so the
 *  caller can fail closed rather than treat an error as "clean". */
const worktreeIsDirty = async (worktreePath: string): Promise<boolean | undefined> => {
  const st = await runShell("git status --porcelain", { cwd: worktreePath }).catch(() => undefined)
  if (st === undefined || st.exitCode !== 0) return undefined
  return st.stdout.trim().length > 0
}

/**
 * RFC-06 §RFC06-1 — HARDENED worktree removal. Replaces the prior
 * unconditional-`--force` + stderr-substring-idempotency path.
 *
 * Contract:
 *   1. Read the live porcelain registry and match the EXACT `worktreePath`
 *      (verbatim, no substring/prefix/branch-name inference). Not registered ⇒
 *      `absent` (idempotent success by porcelain ABSENCE, not a stderr guess).
 *   2. A `locked` worktree is REFUSED (git refuses prune/remove without force,
 *      and this path never forces) — surfaced as `refused:"locked"`.
 *   3. A DIRTY worktree (uncommitted/untracked) is REFUSED — `refused:"dirty"`.
 *      A git-status error also fails closed (`refused:"dirty"` is NOT assumed;
 *      we return `error`).
 *   4. Otherwise a DEFAULT (non-force) `git worktree remove` runs. A non-zero
 *      exit is `refused:"remove_failed"` — NEVER coerced to success.
 *   5. Branch deletion is a SEPARATE typed step run ONLY after a successful
 *      remove, against the caller's persisted exact branch. Its failure does
 *      not flip the removal outcome (best-effort), but is reported via
 *      `branchDeleted`.
 *
 * Never throws. `opts.branch` is the persisted exact branch (authority), not a
 * `fork-<segment>` guess.
 */
export const removeWorktree = async (
  worktreePath: string,
  repoRoot: string,
  opts?: { branch?: string },
): Promise<RemoveOutcome> => {
  const inspected = await inspectWorktrees(repoRoot)
  if (!inspected.ok) return { kind: "error", error: inspected.error }

  const match = await findRegisteredMatch(inspected.worktrees, worktreePath)
  const deleteBranch = async (): Promise<boolean> => {
    if (opts?.branch === undefined || opts.branch === "") return false
    try {
      const branch = safeBranch(opts.branch)
      // `--` separator means even an unexpected leading-`-` slip cannot be
      // parsed as a CLI flag by `git branch`.
      const del = await git(repoRoot, `branch -D -- "${branch}"`)
      return del.exitCode === 0
    } catch {
      // best-effort; branch may already be gone, still referenced, or the
      // input failed sanitization — none of those flip the removal outcome.
      return false
    }
  }

  // (1) Not registered ⇒ idempotent absence. Still attempt the persisted
  // branch delete so a half-torn-down (dir gone, branch left) state converges.
  if (match === undefined) {
    const branchDeleted = await deleteBranch()
    return { kind: "absent", branchDeleted }
  }

  // (2) Locked ⇒ refuse (never force).
  if (match.locked) return { kind: "refused", reason: "locked" }

  // (3) Dirty ⇒ refuse; git-status error ⇒ fail closed (report error).
  const dirty = await worktreeIsDirty(worktreePath)
  if (dirty === undefined) {
    return { kind: "error", error: "git status failed in worktree (clean state unknown)" }
  }
  if (dirty) return { kind: "refused", reason: "dirty" }

  // (4) DEFAULT (non-force) remove. Non-zero exit ⇒ refused, never coerced.
  const rm = await git(repoRoot, `worktree remove -- "${worktreePath}"`)
  if (rm.exitCode !== 0) return { kind: "refused", reason: "remove_failed" }

  // (5) Separate branch-delete step, only after a successful remove.
  const branchDeleted = await deleteBranch()
  return { kind: "removed", branchDeleted }
}

/** `true` iff a {@link RemoveOutcome} reached the desired end state — the
 *  worktree is no longer registered (either just removed or already absent).
 *  A `refused`/`error` outcome is NOT success. Convenience for callers whose
 *  only invariant is "the path is gone" (e.g. create-failure rollback). */
export const removalReachedAbsence = (outcome: RemoveOutcome): boolean =>
  outcome.kind === "removed" || outcome.kind === "absent"

/**
 * FORCE-remove a THROWAWAY worktree — the eval/agent-tool lifecycle owner
 * (`@/tool/worktree`, `@/agent/shadow-verify-adapters/scratch-worktree`). This
 * is deliberately DESTRUCTIVE (`git worktree remove --force`): those callers
 * own a deterministic per-slot path, run their OWN dirty-guard, and INTEND to
 * discard a dirty eval tree (they even capture the discarded-file list first).
 *
 * This is NOT the user-session path — {@link removeWorktree} is the hardened
 * non-force, porcelain-exact, persisted-ownership remover. The RFC-06 single-
 * owner matrix keeps these two lifecycles distinct: user GC must NEVER reuse
 * this force cleanup, and this throwaway path must NEVER gain persisted-
 * ownership authority. Returns `true` when the directory ends up gone
 * (including the idempotent already-gone case). Never throws. */
export const forceRemoveWorktree = async (
  worktreePath: string,
  repoRoot: string,
  opts?: { branch?: string },
): Promise<boolean> => {
  const rm = await git(repoRoot, `worktree remove --force -- "${worktreePath}"`)
  // Idempotent success: if the worktree directory is already gone treat the
  // remove as a no-op success — the desired state has been reached. Detect via
  // stderr signal since `git worktree remove` does not expose a typed exit code
  // for this case.
  let ok = rm.exitCode === 0
  if (!ok) {
    const err = `${rm.stderr}\n${rm.stdout}`.toLowerCase()
    if (
      err.includes("is not a working tree") ||
      err.includes("no such file") ||
      err.includes("not a valid working tree") ||
      err.includes("does not exist")
    ) {
      ok = true
    }
  }
  if (opts?.branch !== undefined && opts.branch !== "") {
    try {
      const branch = safeBranch(opts.branch)
      await git(repoRoot, `branch -D -- "${branch}"`)
    } catch {
      // best-effort; branch may already be gone, still referenced, or the input
      // failed sanitization — none of those should fail the removal contract.
    }
  }
  return ok
}
