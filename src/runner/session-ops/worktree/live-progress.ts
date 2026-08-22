/**
 * RFC-04 D4 — live CLI worktree-transition progress orchestration.
 *
 * Split out of `session-ops/index.ts` (god-MODULE cap) so the `worktree` command
 * stays lean. This module owns the D4 seam: it subscribes to the session
 * `ActivityStore` ATOMICALLY (the store's `{snapshot,nextSeq}` contract) BEFORE
 * invoking `transitionThreadToWorktree`, so no staged event is lost between
 * subscribe and the operation start; it renders each materialized change the
 * instant it arrives (synchronous flush) so the FIRST progress render precedes
 * command completion; and it unsubscribes in `finally`.
 *
 * Gate discipline: `progress` is the resolved `QUANTA_WORKTREE_PROGRESS` decision
 * threaded from the composition root. When it is false (or no store is wired) the
 * function neither turns on the transaction's `staged` children NOR subscribes —
 * so the transition + output are byte-identical to the pre-D4 coarse path. The
 * caller still renders the final settled snapshot as a receipt.
 */

import { type ActivitySnapshot, type ActivityStore, renderActivity } from "@/activity"
import {
  type TransitionActivity,
  type TransitionRequest,
  type TransitionResult,
  transitionThreadToWorktree,
} from "../current-thread-worktree"

/** Render an activity snapshot as newline-terminated `/activity` lines onto the
 *  surface writer. Shared by the live-progress subscription and the final settle
 *  receipt so both format identically. */
export const renderActivityTo = (snapshot: ActivitySnapshot, out: (s: string) => void): void => {
  for (const line of renderActivity(snapshot, { now: Date.now() })) out(`${line}\n`)
}

/** Options resolved by the command front door. */
export interface WorktreeProgressOpts {
  /** The session activity store (DI). Absent ⇒ no activity emitted/rendered. */
  readonly store?: ActivityStore
  /** Resolved `QUANTA_WORKTREE_PROGRESS` gate. */
  readonly progress: boolean
  /** Correlation turn id the front door holds. */
  readonly turnId: string
}

/**
 * Run the worktree transition, wiring live staged progress when the gate is ON.
 *
 * When `progress` is true AND a `store` is wired: the transaction emits
 * `workspace`/`checkout` staged children (via `staged: true`), and a subscription
 * — attached BEFORE the transition and flushed synchronously — renders each stage
 * the moment it materializes (the `running` open is emitted before the git-effect
 * await, so the first render precedes completion). Otherwise the transition is
 * byte-identical to the coarse path: no `staged`, no subscription.
 */
export const runWorktreeTransitionWithProgress = async (
  req: TransitionRequest,
  out: (s: string) => void,
  opts: WorktreeProgressOpts,
): Promise<TransitionResult> => {
  const activity: TransitionActivity | undefined =
    opts.store !== undefined
      ? { store: opts.store, turnId: opts.turnId, ...(opts.progress ? { staged: true } : {}) }
      : undefined
  const liveStore = opts.progress ? opts.store : undefined
  const sub = liveStore?.subscribe(() => renderActivityTo(liveStore.snapshot(), out), {
    schedule: (flush) => flush(),
  })
  try {
    return await transitionThreadToWorktree(req, () => Date.now(), activity)
  } finally {
    sub?.unsubscribe()
  }
}
