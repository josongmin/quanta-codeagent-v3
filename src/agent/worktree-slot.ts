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
