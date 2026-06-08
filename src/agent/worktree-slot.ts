/**
 * ticket-11 (P8 git-worktree agent tools) — session-scoped ACTIVE-WORKTREE slot.
 *
 * The `enter_worktree` / `exit_worktree` / `worktree_status` tools read + mutate
 * ONE holder per session through `ToolContext.worktreeSlot`; the dispatch seam
 * projects the holder's CURRENT value onto `ToolContext.activeWorktree` so the
 * `bash`/`edit` tools see the relative-cwd override (the edit-fence). This is the
 * SAME closure-handle pattern as `createWorkingStateSession` — the loop builds
 * one instance at session start, the tools mutate it across turns.
 *
 * Structurally compatible with `WorktreeSlotHandle` in `@/tool` (the canonical
 * declaration); kept HERE (producer side) so `@/agent` owns the immutable
 * session `repoRoot` / `sessionCwd` the slot carries.
 *
 * SECURITY: `sessionCwd` is the SESSION jail root. The worktree tools NEVER use
 * it to widen the jail — it is surfaced so the bash/edit edit-fence keeps
 * absolute-path writes jailed to the session, never re-jailed to the worktree.
 */

import { gateOn } from "@/shared"
import type { ActiveWorktree, WorktreeSlotHandle } from "@/tool"

/** Build a fresh session-scoped worktree slot. Starts empty (no active
 *  worktree); `enter_worktree` sets it, `exit_worktree` clears it. */
export const createWorktreeSlot = (args: {
  readonly repoRoot: string
  readonly sessionCwd: string
}): WorktreeSlotHandle => {
  let active: ActiveWorktree | undefined
  return {
    current: () => active,
    set: (value: ActiveWorktree) => {
      active = value
    },
    clear: () => {
      active = undefined
    },
    repoRoot: args.repoRoot,
    sessionCwd: args.sessionCwd,
  }
}

/** ticket-11 (P8 worktree) finding #7 — mint the session-scoped active-worktree
 *  slot when (and only when) `QUANTA_WORKTREE_TOOL` is on. Pure (env + a cwd in,
 *  slot-or-undefined out) so the comp-root gate is unit-testable without a full
 *  session boot. The slot carries the SESSION-RESOLVED jailed `bootCwd` as BOTH
 *  the immutable repoRoot AND the sessionCwd jail root — the edit-fence keeps
 *  absolute writes within it and NEVER widens it. Gate off ⇒ undefined ⇒ worktree
 *  tools unregistered + bash/edit cwd byte-identical (default-OFF). Lives in this
 *  library slice (not the CLI comp-root) so it stays importable by tests without
 *  crossing the `@/apps/cli` slice fence. */
export const mintActiveWorktreeSlot = (
  envSource: Readonly<Record<string, string | undefined>>,
  bootCwd: string,
): WorktreeSlotHandle | undefined =>
  gateOn(envSource, "QUANTA_WORKTREE_TOOL")
    ? createWorktreeSlot({ repoRoot: bootCwd, sessionCwd: bootCwd })
    : undefined
