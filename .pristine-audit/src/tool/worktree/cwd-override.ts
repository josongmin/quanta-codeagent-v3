/**
 * ticket-11 (P8 git-worktree agent tools) — the cwd-override / edit-fence logic
 * shared by the `bash` and `edit` tools when a session worktree is active.
 *
 * THE INVARIANT (the security-critical part): a worktree is a RELATIVE-cwd
 * override, NOT a trust-boundary redefinition.
 *
 *   - A RELATIVE path resolves against the WORKTREE directory (so a relative
 *     write/command lands inside the worktree the agent entered).
 *   - An ABSOLUTE path STILL jails to the SESSION jail root (`ctx.cwd`), exactly
 *     as it would with no worktree active. The worktree NEVER widens or narrows
 *     the absolute-path trust boundary.
 *
 * Why this needs a dedicated helper (and not just `cwd = worktreePath`):
 * `@/storage`'s `resolvePath(path, base)` does `resolve(base, path)` and then
 * JAILS the result to `base`. If we naively passed the worktree as `base`, an
 * absolute path would be jailed to the WORKTREE (the worktree is a SUBDIR of the
 * session jail, so a perfectly-legal absolute write into the session tree but
 * OUTSIDE the worktree would be wrongly rejected — a trust-boundary
 * redefinition). Conversely, passing the session cwd as `base` would make a
 * RELATIVE path resolve against the session root, not the worktree.
 *
 * {@link resolveEditBase} threads the needle: it returns the path string + the
 * jail base to hand the storage port so that BOTH properties hold:
 *   - relative → pre-joined to the worktree, jailed to the SESSION cwd (the
 *     worktree is inside the session jail, so it always passes).
 *   - absolute → passed unchanged, jailed to the SESSION cwd (byte-identical to
 *     the no-worktree path).
 *
 * For `bash` the override is simpler: the spawned shell's process `cwd` is the
 * worktree directory itself (there is no separate jail — the FS jail only
 * governs the `read`/`write`/`edit` tools). {@link resolveBashCwd} is the
 * single source for that selection.
 */

import { isAbsolute, resolve } from "node:path"
import type { ActiveWorktree } from "../types"

/**
 * The effective working directory the `bash` tool spawns its child in.
 *
 * When a worktree is active, the shell runs INSIDE the worktree directory so a
 * relative command (`ls`, `git status`, `cat rel.txt`) sees the worktree's
 * files. Absent ⇒ the session cwd (byte-identical legacy). This is the literal
 * `cwd = ctx.activeWorktree?.worktreePath ?? ctx.cwd` the ticket specifies,
 * centralized so the bash tool stays a one-liner.
 */
export const resolveBashCwd = (sessionCwd: string, active: ActiveWorktree | undefined): string =>
  active?.worktreePath ?? sessionCwd

/**
 * Resolve the `{ path, base }` pair the `edit` tool hands to the storage
 * FileSystemPort so the worktree edit-fence INVARIANT holds.
 *
 *   - No active worktree ⇒ `{ path: raw, base: sessionCwd }` — BYTE-IDENTICAL to
 *     today (the storage port resolves + jails against the session cwd).
 *   - Active worktree + RELATIVE `raw` ⇒ pre-join to the worktree to get an
 *     absolute path, then jail to the SESSION cwd. The worktree is a subdir of
 *     the session jail, so the join lands inside it and passes the session jail.
 *   - Active worktree + ABSOLUTE `raw` ⇒ pass `raw` UNCHANGED with the SESSION
 *     cwd as base, so the storage jail check is against the session jail root
 *     exactly as if no worktree were active.
 *
 * The returned `base` is ALWAYS the session cwd when a worktree is active — that
 * is the whole point: the JAIL root never moves to the worktree. Only the
 * RELATIVE-path RESOLUTION base moves (and only by pre-joining the path, never
 * by handing the worktree to the jail).
 */
export const resolveEditBase = (
  raw: string,
  sessionCwd: string,
  active: ActiveWorktree | undefined,
): { readonly path: string; readonly base: string } => {
  if (active === undefined) return { path: raw, base: sessionCwd }
  // Absolute path: never re-based. Jail stays the session root (invariant).
  if (isAbsolute(raw)) return { path: raw, base: sessionCwd }
  // Relative path: resolve against the WORKTREE dir, but keep the SESSION jail.
  // `resolve(worktree, raw)` yields an absolute path inside the worktree; the
  // storage port will then `resolve(sessionCwd, absInsideWorktree)` === the same
  // absolute (absolute wins) and jail-check it against the session root — which
  // passes because the worktree is inside the session jail.
  return { path: resolve(active.worktreePath, raw), base: sessionCwd }
}
