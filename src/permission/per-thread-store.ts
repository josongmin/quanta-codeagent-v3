/**
 * Per-thread permission resolver (ADR-0046).
 *
 * Thin facade over `permission-store.ts` for the per-thread axis. Lives in
 * its own module so callers depending on the "thread permission" concept
 * (admissibility-gate, CLI commands like `/thread perm`) don't import the
 * full store API surface. Pure delegation — no business logic beyond the
 * facade.
 */

import {
  getDefaultPermissionStore,
  type PermissionStore,
  type ThreadPermission,
} from "./permission-store"

export type { ThreadPermission } from "./permission-store"

/** Read the per-thread override (if any). `undefined` ⇒ caller falls back
 *  to the per-host axis (next in precedence). */
export const getThreadPermission = (
  threadId: string,
  store: PermissionStore = getDefaultPermissionStore(),
): ThreadPermission | undefined => store.getThread(threadId)

/** Set the per-thread override. Mutating call — schedules a debounced flush. */
export const setThreadPermission = (
  threadId: string,
  perm: ThreadPermission,
  store: PermissionStore = getDefaultPermissionStore(),
): void => {
  store.setThread(threadId, perm)
}

/** Remove the per-thread override. The thread reverts to the per-host /
 *  global precedence chain. */
export const clearThreadPermission = (
  threadId: string,
  store: PermissionStore = getDefaultPermissionStore(),
): void => {
  store.clearThread(threadId)
}

/** Decide whether the per-thread record blocks a mutating action. Read-only
 *  actions always bypass this check (they're handled by `evaluate()` in
 *  `policy.ts`).
 *
 *  Maps `ThreadPermission.sandboxPolicy` to a binary "writable?" verdict:
 *   - `danger-full-access` → true (writable anywhere)
 *   - `read-only`          → false
 *   - `workspace-write`    → true ONLY if `workdir` is under one of
 *                            `writableRoots` (caller-supplied list of
 *                            absolute prefixes). Empty/absent `writableRoots`
 *                            ⇒ defaults to "writable" (the workspace root
 *                            itself is implicit). */
export const threadAllowsMutation = (perm: ThreadPermission, workdir: string): boolean => {
  switch (perm.sandboxPolicy.type) {
    case "danger-full-access":
      return true
    case "read-only":
      return false
    case "workspace-write": {
      const roots = perm.sandboxPolicy.writableRoots
      if (!roots || roots.length === 0) return true
      return roots.some((r) => workdir === r || workdir.startsWith(`${r}/`))
    }
    default: {
      // Exhaustiveness guard — if a new sandboxPolicy type is added the
      // compiler flags it here. Cast through never so untyped JS callers
      // still hit the runtime throw.
      const _exhaustive: never = perm.sandboxPolicy
      throw new Error(`unhandled sandboxPolicy: ${JSON.stringify(_exhaustive)}`)
    }
  }
}
