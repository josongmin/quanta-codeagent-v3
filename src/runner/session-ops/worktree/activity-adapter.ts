/**
 * RFC-04 D3 — worktree runtime-progress → activity adapter (aug-22 absorption).
 *
 * The ONE cross-domain adapter that maps a worktree-create runtime STAGE
 * progress stream onto the D1 staged activity nodes (workspace/checkout). Runner
 * owns this seam because it is the composition layer: `@/activity` must never
 * import `@/runtime`, and the runtime create must never speak the activity
 * vocabulary. This module TRANSLATES the runtime's typed stage union into
 * `@/activity` events, reusing D1's `worktreeStepOpen`/`worktreeStepSettle` — NO
 * new node kind, NO second spine, NO status bus.
 *
 * ── STATUS: UNWIRED FORWARD SEAM (no production caller) ──────────────────────
 * This adapter has ZERO production callers — it is a forward contract, not a
 * live path, and `worktree-checkout-progress-retired.test.ts` PINS that "no
 * production caller" claim so it cannot silently rot into a second spine. The
 * DELIVERED staged-card UX is emitted DIRECTLY by
 * `current-thread-worktree.ts` (which calls `worktreeStepOpen`/
 * `worktreeStepSettle` inline around the git effect), NOT through this adapter.
 * The originally-planned D2 real-time checkout-% arm was RETIRED (RESOLUTION-PLAN
 * R5): `git worktree add` rejects `--progress` and streams no per-file checkout
 * meter, so a real checkout percentage is structurally impossible on that path —
 * the union carries only lifecycle stages now, never a fabricated ratio.
 *
 * Pure of I/O: the mapping is a pure function; the only stateful surface is the
 * gated observer that writes mapped events to a supplied `ActivityStore`.
 */

import {
  type ActivityStore,
  type AgentActivityEvent,
  type WorktreeStep,
  worktreeStepOpen,
  worktreeStepSettle,
} from "@/activity"

/**
 * The RFC-04 worktree-create runtime STAGE union — the documented forward
 * contract this adapter would CONSUME. A CLOSED union: the exhaustive switch in
 * {@link worktreeProgressToActivity} is the drift-guard (a new arm fails to
 * compile until mapped). `stage` reuses the D1 {@link WorktreeStep} SSOT; `code`
 * is the failure code (typed as `string` here since the activity mapping never
 * branches on it — a failed stage settles `failed` regardless of code). There is
 * deliberately NO `checkout-progress`/percentage arm: git worktree add streams no
 * checkout meter, so no real ratio can ever be produced (RESOLUTION-PLAN R5).
 */
export type WorktreeCreateProgress =
  | { readonly kind: "stage-started"; readonly stage: WorktreeStep }
  | { readonly kind: "stage-completed"; readonly stage: WorktreeStep }
  | { readonly kind: "failed"; readonly stage: WorktreeStep; readonly code: string }

/**
 * Pure, exhaustive translation of ONE runtime progress event into the activity
 * events that update the D1 staged nodes. A closed switch over the union is the
 * drift-guard: a new arm fails to compile until mapped. `at` stamps lifecycle
 * transitions (ignored by the meta-only progress refresh). This function is the
 * whole semantic mapping; it decides no gating and touches no store.
 */
export const worktreeProgressToActivity = (
  operationId: string,
  progress: WorktreeCreateProgress,
  at?: number,
): readonly AgentActivityEvent[] => {
  switch (progress.kind) {
    case "stage-started":
      return [worktreeStepOpen(operationId, progress.stage, at)]
    case "stage-completed":
      return [worktreeStepSettle(operationId, progress.stage, "done", at)]
    case "failed":
      return [worktreeStepSettle(operationId, progress.stage, "failed", at)]
    default: {
      // Exhaustiveness guard: an unmapped arm is a compile error here.
      const _never: never = progress
      return _never
    }
  }
}

/** Facts the runner supplies to build a gated progress observer. */
export interface WorktreeActivityObserverOpts {
  readonly store: ActivityStore
  /** The operation (retry) id — the correlation key. A retry mints a NEW id, so
   *  its checkout node is a distinct child and its progress is isolated/reset. */
  readonly operationId: string
  /**
   * D1 staged gate. When NOT explicitly `true` the observer is INERT: it emits
   * NOTHING, so the default path is byte-identical (no progress source and staged
   * off both yield zero events). Sink presence is NOT the gate — mirrors the D1
   * `TransitionActivity.staged` discipline.
   */
  readonly staged?: boolean
  /** Optional monotonic clock for lifecycle timestamps. */
  readonly clock?: () => number
}

/**
 * Build the progress callback the runtime create observer invokes. Self-gated on
 * `staged`: when `staged !== true` the returned callback is a NO-OP (byte-
 * identical). This is the ONLY place the adapter writes to a store. The runtime
 * never calling it (absent progress source) is likewise zero-event.
 */
export const makeWorktreeActivityObserver = (
  opts: WorktreeActivityObserverOpts,
): ((progress: WorktreeCreateProgress) => void) => {
  if (opts.staged !== true) return () => {}
  return (progress) => {
    const at = opts.clock?.()
    for (const event of worktreeProgressToActivity(opts.operationId, progress, at)) {
      opts.store.emit(event)
    }
  }
}
