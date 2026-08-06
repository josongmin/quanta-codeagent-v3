/**
 * RFC-06 §RFC06-2 — turn-boundary cwd pin (runner composition layer).
 *
 * RFC06-2 built `transitionThreadToWorktree`, which persists the intent→git
 * effect→ready publish and returns `nextCwd` (the owned worktree path) — but it
 * left the FOLLOWER unwired: nothing swaps the working cwd to that path. Its own
 * note: "next-turn cwd pin is a turn-loop follower, deferred." This module is
 * that follower.
 *
 * It lives in the runner orchestration layer for the SAME reason as the
 * crash-resume wiring: this is the only seam that may import BOTH the turn loop
 * (`@/runner/orchestrate/session-turn-driver`) and `@/session` (the persisted
 * `SessionMeta.workspaceOwnership` authority). The pin re-uses that persisted
 * record — the SSOT the transition already wrote — so there is NO new store.
 *
 * Contract (mirrors the crash-resume gate semantics):
 *   - {@link pinTurnBoundaryCwd} runs at the START of a turn, BEFORE the turn
 *     body appends input — i.e. AT the next turn boundary, never mid-turn (once
 *     the body runs the cwd is not touched again). When the gate is on AND the
 *     session's persisted ownership is a LIVE worktree (`ready`/`active`), it
 *     chdir's the working cwd to that owned path via the INJECTED `chdir` port.
 *
 * GATE (default-OFF): the read delegates to `@/session` `worktreeCwdPinEnabled`,
 * a NO-OP unless `QUANTA_WORKTREE_CWD_PIN` is on (read via the injected `env`).
 * So when the gate is absent this is a transparent no-op: nothing is loaded,
 * NOTHING chdir's — byte-identical to the unwired turn path. NEVER throws (a
 * follower must not break a turn); a load/chdir failure is logged and the turn
 * proceeds in the current cwd.
 *
 * SCOPE / documented limitation (mid-turn safety): the injected `chdir` the CLI
 * threads is process-GLOBAL (`process.chdir`). The pin fires only at THIS turn's
 * boundary (before its own `input.append`), so it never disturbs the turn it is
 * pinning FOR. It does NOT arbitrate a CONCURRENTLY-live turn: if a foreground
 * turn's boundary pin runs while a Ctrl+B-backgrounded turn is still streaming,
 * the global chdir moves the shared cwd under that background turn. Both the pin
 * gate AND the background-detach are niche/default-OFF; closing that window would
 * need a per-turn cwd (a new arbitration store), which RFC06-2 explicitly
 * declines. Surfaces that inject a per-turn (non-global) cwd port are unaffected.
 */

import { loadSessionById, worktreeCwdPinEnabled, worktreeCwdPinTarget } from "@/session"
import { errMessage, logger } from "@/shared"

/** The injected working-directory port. The `@/runner` slice is process-pure
 *  (no `process.chdir` literal), so the composition root threads a chdir/getcwd
 *  pair. `chdir` returns the resolved new cwd (mirrors `switchToSessionCwd`). */
export interface WorktreeCwdPort {
  /** Current working directory. */
  readonly cwd: () => string
  /** Change the working directory; returns the resolved new cwd. */
  readonly chdir: (target: string) => string
}

/** Inputs for {@link pinTurnBoundaryCwd}. `env` is threaded from the composition
 *  root (the `@/session` gate is env-pure). `port` is the injected chdir/getcwd
 *  pair. Absent gate ⇒ byte-identical no-op. */
export interface WorktreeCwdPinArgs {
  readonly sessionId: string
  /** Threaded from the composition root — the gate read is env-pure. */
  readonly env: Record<string, string | undefined>
  /** The working-directory port (injected; the runner slice is process-pure). */
  readonly port: WorktreeCwdPort
}

/**
 * Pin the working cwd to the session's owned worktree AT the turn boundary
 * (called BEFORE the turn body runs — never mid-turn). Reads the persisted
 * `SessionMeta.workspaceOwnership` (the SSOT the transition wrote) and, when the
 * gate is on AND that record is a LIVE worktree (`ready`/`active`), chdir's to
 * the owned path. Gate-off ⇒ transparent no-op (nothing loaded, no chdir),
 * byte-identical. Best-effort: NEVER throws — a load/chdir failure is logged and
 * the turn proceeds in the current cwd.
 */
export const pinTurnBoundaryCwd = async (args: WorktreeCwdPinArgs): Promise<void> => {
  // Gate-off ⇒ do NOT even load the session: no I/O, byte-identical.
  if (!worktreeCwdPinEnabled(args.env)) return
  try {
    const saved = await loadSessionById(args.sessionId)
    const target = worktreeCwdPinTarget(saved?.meta.workspaceOwnership)
    // No live-worktree ownership, or already there ⇒ nothing to pin.
    if (target === undefined || target === args.port.cwd()) return
    const next = args.port.chdir(target)
    logger.info("worktree.cwd.pinned", { sessionId: args.sessionId, to: next })
  } catch (e) {
    // A follower must NOT break a turn: log and let the turn run in the current
    // cwd (the persisted cwd is still authoritative on the next resume).
    logger.warn("worktree: cwd pin failed", {
      sessionId: args.sessionId,
      error: errMessage(e),
    })
  }
}
