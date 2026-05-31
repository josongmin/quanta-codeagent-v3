/**
 * Per-thread permission resolver (ADR-0046).
 *
 * Thin facade over `permission-store.ts` for the per-thread axis. Lives in
 * its own module so callers depending on the "thread permission" concept
 * (admissibility-gate, CLI commands like `/thread perm`) don't import the
 * full store API surface. Pure delegation — no business logic beyond the
 * facade.
 */

import type { PermissionStore, ThreadPermission } from "./permission-store"

export type { ThreadPermission } from "./permission-store"

/** Read the per-thread override (if any). `undefined` ⇒ caller falls back
 *  to the per-host axis (next in precedence). `store` is REQUIRED — the
 *  composition root injects (no service-locator fallback). */
export const getThreadPermission = (
  threadId: string,
  store: PermissionStore,
): ThreadPermission | undefined => store.getThread(threadId)

/** Set the per-thread override. Mutating call — schedules a debounced flush.
 *  `store` is REQUIRED. */
export const setThreadPermission = (
  threadId: string,
  perm: ThreadPermission,
  store: PermissionStore,
): void => {
  store.setThread(threadId, perm)
}

/** Remove the per-thread override. The thread reverts to the per-host /
 *  global precedence chain. `store` is REQUIRED. */
export const clearThreadPermission = (threadId: string, store: PermissionStore): void => {
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
 *                            absolute prefixes).
 *
 *  Fail-closed (T08 — May-31 bugbash, audit L8 H4): an EMPTY or absent
 *  `writableRoots` is NOT "writable anywhere". The prior code returned `true`
 *  for an empty list — a `workspace-write` thread whose writable-root list
 *  was never populated (a config gap, or a root list that got filtered to
 *  empty) silently became writable across the whole filesystem. An empty
 *  writable-root set means "no root is writable" ⇒ DENY. Callers that want the
 *  workspace root writable MUST list it explicitly. Containment uses a
 *  separator-anchored prefix so `/repo` covers `/repo/x` but not `/repo2/x`. */
export const threadAllowsMutation = (perm: ThreadPermission, workdir: string): boolean => {
  switch (perm.sandboxPolicy.type) {
    case "danger-full-access":
      return true
    case "read-only":
      return false
    case "workspace-write": {
      const roots = perm.sandboxPolicy.writableRoots
      if (!roots || roots.length === 0) return false
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
