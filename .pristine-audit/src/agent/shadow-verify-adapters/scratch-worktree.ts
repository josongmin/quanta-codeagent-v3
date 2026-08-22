/**
 * ADR-0400 — Real `ShadowScratchPort` over `@/runtime` git-worktree primitives.
 *
 * Composition-root adapter: the wave-1 `@/agent/shadow-verify` slice CANNOT
 * import `@/runtime` (slice fence). This sibling slice
 * (`@/agent/shadow-verify-adapters`) is the assembler that wires the closed
 * scratch port into a real persistent git worktree spun off `HEAD`.
 *
 * NO-THROW: the runner already wraps `scratch.open(...)` in try/catch and
 * converts any throw into an error-severity `ShadowDiagnostic`, so a failure
 * to create the worktree here will surface cleanly to the caller. The adapter
 * still tries to leave the host workspace untouched — every code path is
 * disposable, and `dispose()` is best-effort (matches the wave-1 contract:
 * dispose throws are swallowed by the runner).
 */

import { randomUUID } from "node:crypto"
import {
  createPersistentWorktree,
  forceRemoveWorktree,
  type PersistentWorktree,
} from "@/runtime/worktree-fork"
import { throwIfAborted } from "@/shared"
import type { ShadowScratchPort } from "../shadow-verify"

/**
 * Build a `ShadowScratchPort` backed by `createPersistentWorktree`. Each
 * `open()` mints a fresh uuid-tagged worktree at
 * `<repoRoot>/.quanta/worktrees/shadow-verify-<uuid>` on branch
 * `shadow-verify-<uuid>` (auto-sanitized by `@/runtime/worktree-fork`). The
 * returned `handle` IS the absolute worktree path — the apply / check adapters
 * read it back verbatim so the V4A applier / LSP / shell can target the
 * isolated tree.
 *
 * @param repoRoot   the host repo root (e.g. session `cwd`); the worktree is
 *                   forked off HEAD of THIS repo.
 */
export const createScratchWorktreePort = (repoRoot: string): ShadowScratchPort => ({
  async open(signal?: AbortSignal): Promise<{ handle: string; dispose: () => Promise<void> }> {
    // T01 (audit L3 C-10): honor cancellation before the multi-second
    // `git worktree add` I/O. The underlying `createPersistentWorktree` chain
    // (`runWorktreeAddWithRetry → git → runShell`) is owned by `@/runtime` and
    // does not yet take a signal, so this seam cannot interrupt the git process
    // once spawned. The HONEST contract: gate at the boundary so a verify that
    // was already cancelled does NOT spawn the worktree at all; the runner
    // converts the thrown typed AbortError into an error-severity diagnostic.
    throwIfAborted(signal)
    const id = `shadow-verify-${randomUUID()}`
    const wt: PersistentWorktree = await createPersistentWorktree(id, repoRoot)
    const dispose = async (): Promise<void> => {
      // Best-effort: forceRemoveWorktree returns false on failure but never
      // throws; a leftover worktree is recoverable via `git worktree prune` and
      // the runner swallows dispose failures regardless (wave-1 contract). This
      // is the THROWAWAY eval remover (force), NOT the hardened user-session
      // `removeWorktree` — a scratch verify tree is meant to be discarded.
      await forceRemoveWorktree(wt.worktreePath, repoRoot, { branch: wt.branch })
    }
    return { handle: wt.worktreePath, dispose }
  },
})
