/**
 * RFC-04 D3 — worktree runtime-progress → activity adapter (aug-22 absorption).
 *
 * The ONE cross-domain adapter that maps a worktree-create runtime progress
 * stream onto the D1 staged activity nodes (workspace/checkout). Runner owns
 * this seam because it is the composition layer: `@/activity` must never import
 * `@/runtime`, and the runtime create must never speak the activity vocabulary.
 * This module TRANSLATES the runtime's typed progress union into `@/activity`
 * events, reusing D1's `worktreeStepOpen`/`worktreeStepSettle` and the
 * `worktreeCheckoutProgress` producer — NO new node kind, NO second spine, NO
 * status bus (blueprint §RFC-04: "Runner maps it to activity").
 *
 * ── D2 coupling (producer/consumer contract) ────────────────────────────────
 * The input {@link WorktreeCreateProgress} is the RFC-04 documented progress
 * SHAPE (rfc-04 domain contract; blueprint §RFC-04). D2 owns the concrete
 * `runtime/worktree/types.ts` PRODUCER of that shape and its git plumbing; this
 * adapter is the CONSUMER and depends only on the documented shape — it does not
 * reimplement any git plumbing. The stage vocabulary reuses D1's landed
 * {@link WorktreeStep} SSOT (workspace/checkout/setup) rather than minting a
 * second stage enum. When D2 lands its concrete union, D4 (which takes the
 * session/CLI composition lock) threads this adapter's observer into the runtime
 * progress callback and reconciles the two structurally-identical types. The
 * adapter is complete and unit-provable in isolation before that wiring exists.
 *
 * Pure of I/O: the mapping is a pure function; the only stateful surface is the
 * gated observer that writes mapped events to a supplied `ActivityStore`.
 */

import {
  type ActivityStore,
  type AgentActivityEvent,
  type WorktreeStep,
  worktreeCheckoutProgress,
  worktreeStepOpen,
  worktreeStepSettle,
} from "@/activity"

/**
 * The RFC-04 worktree-create runtime progress union — the documented contract
 * this adapter CONSUMES (D2 produces it). A CLOSED union: the exhaustive switch
 * in {@link worktreeProgressToActivity} is the drift-guard (a new arm fails to
 * compile until mapped). `stage` reuses the D1 {@link WorktreeStep} SSOT; `code`
 * is the failure code (D2's `WorktreeFailureCode`, typed as `string` here since
 * the activity mapping never branches on it — a failed stage settles `failed`
 * regardless of code).
 */
export type WorktreeCreateProgress =
  | { readonly kind: "stage-started"; readonly stage: WorktreeStep }
  | { readonly kind: "checkout-progress"; readonly completed: number; readonly total: number }
  | { readonly kind: "stage-completed"; readonly stage: WorktreeStep }
  | { readonly kind: "failed"; readonly stage: WorktreeStep; readonly code: string }

/**
 * Convert a git-reported `(completed/total)` count pair to an integer percentage
 * in [0,100], or `null` when the counts are malformed/indeterminate. Reports
 * git's OWN ratio — NEVER a fabricated/heuristic number: a non-finite or
 * non-positive total, a negative/non-finite completed, or a regressing
 * `completed > total` is indeterminate (→ `null` → the adapter emits no progress
 * event, so the node stays `running` with no invented %). Aligns with
 * no-heuristics/no-optimistic-signal: it is git's number or nothing.
 */
export const checkoutPercentage = (completed: number, total: number): number | null => {
  if (!Number.isFinite(completed) || !Number.isFinite(total)) return null
  if (total <= 0) return null
  if (completed < 0 || completed > total) return null
  return Math.round((completed / total) * 100)
}

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
    case "checkout-progress": {
      const pct = checkoutPercentage(progress.completed, progress.total)
      // Indeterminate ⇒ NO event: the checkout node stays `running` with no
      // fabricated number.
      return pct === null ? [] : [worktreeCheckoutProgress(operationId, pct)]
    }
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
