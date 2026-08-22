/**
 * RFC-06 §RFC06-2 — crash-resume RECONCILIATION wire (runner composition layer).
 *
 * RFC06-2 built {@link reconcileCreatingWorktree} — the PURE verdict that
 * inspects the live git registry for a session found stuck in the `creating`
 * state (the crash window between the intent-persist BEFORE the git effect and
 * the ready-publish AFTER it) — but left it with ZERO production caller. A
 * worktree create that dies mid-way therefore leaves a durable `creating`
 * ownership record that NOTHING reconciles at restart: the orphan sits forever
 * (the cwd-pin follower never pins a `creating` record, and GC leaves a
 * non-terminal `creating` record report-only). This module is that caller — it
 * runs the reconciler AND persists the resolved record at the resume boundary.
 *
 * It lives in the runner orchestration layer for the SAME reason as the
 * turn-boundary cwd pin follower ({@link pinTurnBoundaryCwd}, its sibling): this
 * is the only seam that may import BOTH the turn loop and `@/session` (the
 * persisted `SessionMeta.workspaceOwnership` authority). It reuses the SSOT the
 * transition already wrote — there is NO new store.
 *
 * Contract (mirrors the cwd-pin gate semantics):
 *   - {@link reconcileCreatingWorktreeAtResume} runs at the START of a turn
 *     (the resume/session-load boundary every resumed session funnels through)
 *     BEFORE the cwd pin — so a `creating` orphan is first resolved to `ready`
 *     (when the worktree exists on disk) and the pin can then pin it, or rolled
 *     to a clean terminal (`failed`/`quarantined`) when it does not.
 *   - The reconciler is IDEMPOTENT and SAFE: it only ever touches an OWNED
 *     record that is in `creating`; any other state is a `noop` verdict ⇒ NO
 *     write. It NEVER removes a worktree from disk (it invokes no git removal at
 *     all) — a dirty/unowned/on-disk worktree is preserved; only the durable
 *     `creating` record is transitioned.
 *
 * GATE (default-OFF): the read delegates to `@/session` `worktreeCwdPinEnabled`,
 * a NO-OP unless `QUANTA_WORKTREE_CWD_PIN` is on (read via the INJECTED `env`).
 * So when the gate is absent this is a transparent no-op: nothing is loaded,
 * NOTHING is inspected, NOTHING is persisted — byte-identical to the unwired
 * turn path. NEVER throws (a follower must not break a turn): a load/inspect/
 * persist failure is logged and the turn proceeds (the durable record is still
 * authoritative on the next resume, so reconciliation retries).
 */

import {
  type ReconcileVerdict,
  reconcileCreatingWorktree,
} from "@/runner/session-ops/current-thread-worktree"
import {
  loadSessionById,
  type SavedSession,
  type SessionMeta,
  transitionWorkspaceState,
  updateSessionAtomic,
  type WorkspaceOwnershipState,
  worktreeCwdPinEnabled,
} from "@/session"
import { errMessage, logger } from "@/shared"

/** Injected clock — epoch-ms — so the transition stamps are deterministic in
 *  tests (matches the `Clock` the pure reconciler takes). */
export type ReconcileClock = () => number

/** Inputs for {@link reconcileCreatingWorktreeAtResume}. `env` is threaded from
 *  the composition root (the `@/session` gate is env-pure). `now` is the
 *  injected clock. Absent gate ⇒ byte-identical no-op. */
export interface WorktreeReconcileArgs {
  readonly sessionId: string
  /** Threaded from the composition root — the gate read is env-pure. */
  readonly env: Record<string, string | undefined>
  /** Injected clock (epoch-ms); defaults to `Date.now`. */
  readonly now?: ReconcileClock
}

/** The verdict kinds that carry a transitioned record to persist. `noop` (no
 *  ownership / not in `creating`) writes nothing — byte-identical. */
const isResolvingVerdict = (
  v: ReconcileVerdict,
): v is Exclude<ReconcileVerdict, { readonly kind: "noop" }> => v.kind !== "noop"

/** The lifecycle target each resolving verdict transitions the `creating` record
 *  to, plus the errorCode carried onto the terminal states. Pure mapping — the
 *  re-apply below stamps it onto the FRESH record inside the save lock. */
const VERDICT_TARGET: Readonly<
  Record<
    Exclude<ReconcileVerdict, { readonly kind: "noop" }>["kind"],
    { readonly to: WorkspaceOwnershipState; readonly errorCode?: string }
  >
> = {
  promote_ready: { to: "ready" },
  mark_failed: { to: "failed", errorCode: "reconcile_no_worktree" },
  quarantine: { to: "quarantined", errorCode: "reconcile_inspect_failed" },
}

/**
 * Fold the resolved transition onto the session's ownership record CLOBBER-SAFELY.
 * The verdict was decided from a snapshot loaded OUTSIDE the save lock; the actual
 * write re-reads the FRESHEST snapshot INSIDE `updateSessionAtomic` (the SSOT
 * load→mutate→write-under-lock owner) and re-applies the PURE transition there —
 * so a concurrent mid-turn transcript append in the load→write gap is carried
 * forward via the full-snapshot spread, never overwritten by a stale `messages`.
 * IDEMPOTENT: if the fresh record is no longer `creating` (another writer already
 * reconciled it), `transitionWorkspaceState` refuses and we return the snapshot
 * UNCHANGED (no write of a different state). Returns whether a real transition was
 * applied (for logging only).
 */
const foldReconciled = async (
  sessionId: string,
  target: { readonly to: WorkspaceOwnershipState; readonly errorCode?: string },
  clock: () => number,
): Promise<boolean> => {
  let applied = false
  await updateSessionAtomic(sessionId, (fresh: SavedSession): SavedSession => {
    const cur = fresh.meta.workspaceOwnership
    // Re-check against the FRESH record: only a still-`creating` orphan is
    // transitioned. Any other state (already reconciled by a peer, torn down,
    // gone) ⇒ leave the snapshot byte-identical (no clobber, no resurrection).
    if (cur === undefined || cur.state !== "creating") return fresh
    const t = transitionWorkspaceState(cur, target.to, clock(), target.errorCode)
    if (!t.ok) return fresh
    applied = true
    const nextMeta: SessionMeta = { ...fresh.meta, workspaceOwnership: t.record }
    return { ...fresh, meta: nextMeta }
  })
  return applied
}

/**
 * Reconcile a session's `creating` worktree orphan at the resume/session-load
 * boundary, PERSISTING the resolved record. Reads the persisted
 * `SessionMeta.workspaceOwnership` (the SSOT the transition wrote); when the gate
 * is on AND that record is in `creating`, runs the pure reconciler against the
 * live git registry and writes back the transitioned record (`ready` when the
 * worktree is registered, `failed` when it is not, `quarantined` when the
 * registry is unreadable). Any non-`creating` record ⇒ `noop` ⇒ NO write.
 *
 * Gate-off ⇒ transparent no-op (nothing loaded, nothing inspected, nothing
 * written), byte-identical. Best-effort: NEVER throws — a load/inspect/persist
 * failure is logged and the turn proceeds (the durable record stays authoritative
 * so a later resume retries). NEVER removes an on-disk worktree.
 */
export const reconcileCreatingWorktreeAtResume = async (
  args: WorktreeReconcileArgs,
): Promise<void> => {
  // Gate-off ⇒ do NOT even load the session: no I/O, byte-identical.
  if (!worktreeCwdPinEnabled(args.env)) return
  const clock = args.now ?? Date.now
  try {
    const saved = await loadSessionById(args.sessionId)
    // No session, or no ownership, or not in `creating` ⇒ the reconciler returns
    // `noop` and we write NOTHING (a `ready`/`active`/terminal record is never
    // touched). Loading is cheap; the verdict gates the (only) write.
    if (saved === undefined) return
    const verdict = await reconcileCreatingWorktree(saved.meta, clock)
    if (!isResolvingVerdict(verdict)) return
    // Persist the resolution CLOBBER-SAFELY (re-reads the freshest snapshot inside
    // the save lock; a peer that already reconciled ⇒ our fold is a no-op).
    const applied = await foldReconciled(args.sessionId, VERDICT_TARGET[verdict.kind], clock)
    if (applied)
      logger.info("worktree.reconcile.resumed", {
        sessionId: args.sessionId,
        verdict: verdict.kind,
        state: verdict.ownership.state,
      })
  } catch (e) {
    // A follower must NOT break a turn: log and let the turn run. The durable
    // `creating` record is still on disk, so a later resume reconciles again.
    logger.warn("worktree: resume reconcile failed", {
      sessionId: args.sessionId,
      error: errMessage(e),
    })
  }
}
