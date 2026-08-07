import { errMessage } from "@/shared"
import { runShell } from "./shell"
import type { ShellResult } from "./types"

/**
 * RFC-06 §RFC06-1 — typed `git worktree list --porcelain` reader (aug-02
 * absorption).
 *
 * This is a READ ADAPTER ONLY: it converts machine-readable Git facts into a
 * typed {@link WorktreeInspection} read model. It has NO ownership/state/remove
 * authority — the persisted `SessionMeta.workspaceOwnership` decides ownership
 * and the runtime mutation owner (`removeWorktree`) decides removal. The
 * mutation callers consult this reader BEFORE any destructive action so they
 * match against exact registered facts instead of stderr substrings or path/
 * branch-name inference.
 *
 * Porcelain format (git-worktree(1), stable since git 2.7): each worktree is a
 * group of `<label> [value]` lines terminated by a blank line —
 *
 *     worktree /abs/path
 *     HEAD <sha>
 *     branch refs/heads/<name>      (OR a bare `detached` line)
 *     locked [<reason>]             (optional)
 *     prunable [<reason>]           (optional)
 *     bare                          (optional; the main bare repo)
 *
 * We parse ONLY these documented labels; an unrecognized label is ignored (it
 * cannot upgrade a worktree to "removable"). A group missing its `worktree`
 * header is impossible in git's output but is defensively skipped.
 */

/** One worktree's machine-readable facts. `branch` is the short name
 *  (`refs/heads/foo` → `foo`); absent when the worktree is detached. `locked`/
 *  `prunable` carry git's optional reason string (empty string when the marker
 *  was present with no reason). */
export interface WorktreeInspection {
  /** Absolute registered worktree path (git's `worktree` line). */
  readonly path: string
  /** Checked-out HEAD sha, or `undefined` if git omitted it. */
  readonly head?: string
  /** Short branch name, or `undefined` when detached. */
  readonly branch?: string
  /** True when git reports the worktree as detached HEAD. */
  readonly detached: boolean
  /** True when the worktree is locked (git refuses prune/remove without force). */
  readonly locked: boolean
  /** Lock reason (may be empty). Absent when not locked. */
  readonly lockedReason?: string
  /** True when git reports the worktree as prunable (its dir is gone/invalid). */
  readonly prunable: boolean
  /** True for the main/bare repo entry (never a user worktree target). */
  readonly bare: boolean
}

/** A running group being assembled from consecutive porcelain lines. */
interface PartialGroup {
  path?: string
  head?: string
  branch?: string
  detached: boolean
  locked: boolean
  lockedReason?: string
  prunable: boolean
  bare: boolean
}

const freshGroup = (): PartialGroup => ({
  detached: false,
  locked: false,
  prunable: false,
  bare: false,
})

/** Convert a completed partial group to a typed inspection, or `undefined`
 *  when it has no `worktree` header (defensive — git always emits one). */
const finalizeGroup = (g: PartialGroup): WorktreeInspection | undefined => {
  if (g.path === undefined || g.path.length === 0) return undefined
  return {
    path: g.path,
    ...(g.head !== undefined ? { head: g.head } : {}),
    ...(g.branch !== undefined ? { branch: g.branch } : {}),
    detached: g.detached,
    locked: g.locked,
    ...(g.locked ? { lockedReason: g.lockedReason ?? "" } : {}),
    prunable: g.prunable,
    bare: g.bare,
  }
}

/** Strip a leading `refs/heads/` from a porcelain `branch` value; leave any
 *  other ref namespace intact (git only emits `refs/heads/` for worktrees but
 *  we do not assume it). */
const shortBranch = (ref: string): string =>
  ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref

/** Apply ONE porcelain content line (non-blank, non-`worktree`-header) to the
 *  in-progress group. An unrecognized label is ignored (it can never upgrade a
 *  worktree to removable). Extracted from the loop so the parser body stays
 *  below the cognitive-complexity ceiling. */
const applyPorcelainLine = (group: PartialGroup, line: string): void => {
  if (line.startsWith("HEAD ")) {
    group.head = line.slice("HEAD ".length).trim()
    return
  }
  if (line.startsWith("branch ")) {
    group.branch = shortBranch(line.slice("branch ".length).trim())
    return
  }
  if (line === "detached") {
    group.detached = true
    return
  }
  if (line === "locked" || line.startsWith("locked ")) {
    group.locked = true
    group.lockedReason = line === "locked" ? "" : line.slice("locked ".length)
    return
  }
  if (line === "prunable" || line.startsWith("prunable ")) {
    group.prunable = true
    return
  }
  if (line === "bare") {
    group.bare = true
  }
  // Unknown label — ignore.
}

/**
 * PURE parser for `git worktree list --porcelain` stdout. Exported for direct
 * unit testing (no git subprocess needed). Splits on blank-line group
 * boundaries and reads the documented labels. Malformed/blank input ⇒ `[]`.
 */
export const parseWorktreePorcelain = (stdout: string): readonly WorktreeInspection[] => {
  const out: WorktreeInspection[] = []
  let group = freshGroup()
  let sawAny = false

  const flush = () => {
    if (sawAny) {
      const done = finalizeGroup(group)
      if (done !== undefined) out.push(done)
    }
    group = freshGroup()
    sawAny = false
  }

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    if (line.trim() === "") {
      flush()
      continue
    }
    sawAny = true
    // `worktree <path>` begins a NEW group — if a prior group was mid-assembly
    // without its terminating blank line (final group, no trailing newline),
    // flush it first.
    if (line.startsWith("worktree ")) {
      if (group.path !== undefined) flush()
      sawAny = true
      group.path = line.slice("worktree ".length)
      continue
    }
    applyPorcelainLine(group, line)
  }
  flush()
  return out
}

/** The `git` runner shape this reader consumes — the SAME
 *  `(repoRoot, args) => Promise<ShellResult>` the worktree modules use. Injected
 *  so tests can drive the parser without a real subprocess. */
export type GitRunner = (repoRoot: string, args: string) => Promise<ShellResult>

const defaultGit: GitRunner = (repoRoot, args) => runShell(`git ${args}`, { cwd: repoRoot })

/** Typed outcome of a live inspection. On a git failure the reader returns an
 *  explicit error (NOT an empty list, which a caller might misread as "no
 *  worktrees ⇒ safe to treat as removed"). */
export type InspectResult =
  | { readonly ok: true; readonly worktrees: readonly WorktreeInspection[] }
  | { readonly ok: false; readonly error: string }

/**
 * Read the live worktree registry for `repoRoot`. Returns typed facts or an
 * explicit error — a git non-zero exit is NOT coerced to an empty list, so a
 * caller can distinguish "git failed" from "no worktrees registered". Never
 * throws.
 */
export const inspectWorktrees = async (
  repoRoot: string,
  git: GitRunner = defaultGit,
): Promise<InspectResult> => {
  let r: ShellResult
  try {
    r = await git(repoRoot, "worktree list --porcelain")
  } catch (e) {
    return { ok: false, error: errMessage(e) }
  }
  if (r.exitCode !== 0) {
    return { ok: false, error: r.stderr.trim() || r.stdout.trim() || "git worktree list failed" }
  }
  return { ok: true, worktrees: parseWorktreePorcelain(r.stdout) }
}

/**
 * Find the inspection for an EXACT registered path. Returns `undefined` when no
 * worktree with that exact `path` is registered — the authoritative "is this
 * worktree still registered?" check. NO substring/prefix matching: the target
 * must equal git's registered path verbatim (the persisted ownership path).
 */
export const findByExactPath = (
  worktrees: readonly WorktreeInspection[],
  path: string,
): WorktreeInspection | undefined => worktrees.find((w) => w.path === path)
