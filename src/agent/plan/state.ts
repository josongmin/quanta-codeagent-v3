/**
 * PlanStore — CAS-versioned, emit-hooked wrapper around the pure reducers.
 *
 * Every public method checks `expectedVersion` BEFORE invoking the reducer
 * (the reducers themselves are version-agnostic). On success, bumps version
 * (already in the reducer's output plan), updates internal state, and emits
 * via `onDelta?` if provided. Errors do not emit (failed mutations are
 * server-side only — surfaces should only render successful state).
 *
 * In-memory only — durability is the host's job (see ADR-0094 PlanStore port
 * + AgentConfig.planSnapshotStore).
 */

import {
  addTodos as addTodosReducer,
  createPlan as createPlanReducer,
  removeTodos as removeTodosReducer,
  reorderPhases as reorderPhasesReducer,
  updateMeta as updateMetaReducer,
  updateTodos as updateTodosReducer,
} from "./mutations"
import { fromSnapshot, type PlanSnapshot, toSnapshot } from "./snapshot"
import type { CreatePlanArgs, NewTodo, Plan, PlanDelta, PlanResult, TodoPatch } from "./types"

export interface PlanStore {
  current(): Plan | null
  create(args: CreatePlanArgs): PlanResult<PlanDelta>
  addTodos(items: readonly NewTodo[], expectedVersion: number): PlanResult<PlanDelta>
  updateTodos(
    patches: readonly TodoPatch[],
    merge: boolean,
    expectedVersion: number,
  ): PlanResult<PlanDelta>
  removeTodos(ids: readonly string[], expectedVersion: number): PlanResult<PlanDelta>
  reorderPhases(phaseIds: readonly string[], expectedVersion: number): PlanResult<PlanDelta>
  updateMeta(
    args: { name?: string; overview?: string; isProject?: boolean },
    expectedVersion: number,
  ): PlanResult<PlanDelta>
  snapshot(): PlanSnapshot | null
  restore(snap: PlanSnapshot): PlanResult<true>
  /**
   * Explicit, caller-driven reset path (ADR-0093 P6 plan-exit-lifecycle).
   *
   * Drops the current plan unconditionally:
   *   - `current()` returns `null` afterward.
   *   - Internal version counter is reset (next `create()` produces v0 — a
   *     fresh plan, NOT a continuation of the prior version chain).
   *   - **Emits no delta.** Clearing is a lifecycle event, not a mutation;
   *     observers learn of the absence via `current() === null`, not via a
   *     `PlanDelta`. Subsequent `create()` emits `plan_created` as usual.
   *   - **Idempotent.** Calling `clear()` on an already-empty store is a no-op.
   *
   * Used by `plan-exit-lifecycle.applyPlanExitOutcome` when the operator
   * rejects the plan via the 3-way exit (ADR-0086). Held snapshots (taken via
   * `snapshot()` before `clear()`) are unaffected — snapshots are by-value.
   *
   * NOT a heuristic-driven path. The store NEVER calls `clear()` itself; only
   * an external caller (plan-exit flow, host shutdown) may invoke it.
   */
  clear(): void
}

export interface CreateInMemoryPlanStoreOpts {
  readonly now: () => number
  readonly idGen?: () => string
  readonly onDelta?: (delta: PlanDelta) => void
}

/** Default id generator: monotonic counter + random suffix. Sufficient for
 *  test determinism (injectable) AND prod uniqueness (random suffix). */
const defaultIdGen = (): (() => string) => {
  let counter = 0
  return () => {
    counter += 1
    return `t-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}

export const createInMemoryPlanStore = (opts: CreateInMemoryPlanStoreOpts): PlanStore => {
  let plan: Plan | null = null
  const idGen = opts.idGen ?? defaultIdGen()
  const emit = (d: PlanDelta): void => {
    try {
      opts.onDelta?.(d)
    } catch {
      // observer throw must not propagate to caller (mutation already applied).
    }
  }
  const cas = (expected: number | undefined): PlanResult<undefined> => {
    if (plan === null) return { ok: true, value: undefined }
    if (expected !== undefined && expected !== plan.version) {
      return { ok: false, error: { kind: "version_conflict", expected, actual: plan.version } }
    }
    return { ok: true, value: undefined }
  }
  const apply = (r: PlanResult<PlanDelta>): PlanResult<PlanDelta> => {
    if (r.ok) {
      plan = r.value.plan
      emit(r.value)
    }
    return r
  }

  return {
    current: () => plan,
    create: (args) => {
      // Create only allowed when no plan exists OR plan exists and caller knows it.
      if (plan !== null)
        return {
          ok: false,
          error: { kind: "version_conflict", expected: -1, actual: plan.version },
        }
      return apply(createPlanReducer(args, opts.now(), idGen))
    },
    addTodos: (items, expectedVersion) => {
      const c = cas(expectedVersion)
      if (!c.ok) return c
      if (plan === null)
        return {
          ok: false,
          error: { kind: "version_conflict", expected: expectedVersion, actual: -1 },
        }
      return apply(addTodosReducer(plan, items, opts.now(), idGen))
    },
    updateTodos: (patches, merge, expectedVersion) => {
      const c = cas(expectedVersion)
      if (!c.ok) return c
      if (plan === null)
        return {
          ok: false,
          error: { kind: "version_conflict", expected: expectedVersion, actual: -1 },
        }
      return apply(updateTodosReducer(plan, patches, merge, opts.now()))
    },
    removeTodos: (ids, expectedVersion) => {
      const c = cas(expectedVersion)
      if (!c.ok) return c
      if (plan === null)
        return {
          ok: false,
          error: { kind: "version_conflict", expected: expectedVersion, actual: -1 },
        }
      return apply(removeTodosReducer(plan, ids, opts.now()))
    },
    reorderPhases: (phaseIds, expectedVersion) => {
      const c = cas(expectedVersion)
      if (!c.ok) return c
      if (plan === null)
        return {
          ok: false,
          error: { kind: "version_conflict", expected: expectedVersion, actual: -1 },
        }
      return apply(reorderPhasesReducer(plan, phaseIds, opts.now()))
    },
    updateMeta: (args, expectedVersion) => {
      const c = cas(expectedVersion)
      if (!c.ok) return c
      if (plan === null)
        return {
          ok: false,
          error: { kind: "version_conflict", expected: expectedVersion, actual: -1 },
        }
      return apply(updateMetaReducer(plan, args, opts.now()))
    },
    snapshot: () => (plan === null ? null : toSnapshot(plan)),
    restore: (snap) => {
      const r = fromSnapshot(snap)
      if (!r.ok) return r
      plan = r.value
      return { ok: true, value: true }
    },
    clear: () => {
      // Drop the plan reference. Next `create()` succeeds from a clean slate
      // (the `plan !== null` guard in create() no longer trips, and the
      // reducer produces v0 since version lives on the plan envelope itself
      // — there is no separate counter to reset).
      //
      // Idempotent: if plan is already null, this is a no-op. We do NOT emit
      // a delta — clearing is a lifecycle event, not a mutation. Observers
      // that care will see `current() === null` and react accordingly.
      // Snapshots already returned to callers are unaffected (by-value).
      plan = null
    },
  }
}
