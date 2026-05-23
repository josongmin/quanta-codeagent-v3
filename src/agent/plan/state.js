/**
 * PlanStore — CAS-versioned, emit-hooked wrapper around the pure reducers.
 *
 * Every public method checks `expectedVersion` BEFORE invoking the reducer
 * (the reducers themselves are version-agnostic). On success, bumps version
 * (already in the reducer's output plan), updates internal state, and emits
 * via `onDelta?` if provided. Errors do not emit (failed mutations are
 * server-side only — surfaces should only render successful state).
 *
 * In-memory only — durability is the host's job (see ADR-0096 PlanStore port
 * + AgentConfig.planSnapshotStore).
 */
import { addTodos as addTodosReducer, createPlan as createPlanReducer, removeTodos as removeTodosReducer, reorderPhases as reorderPhasesReducer, updateMeta as updateMetaReducer, updateTodos as updateTodosReducer, } from "./mutations";
import { fromSnapshot, toSnapshot } from "./snapshot";
/** Default id generator: monotonic counter + random suffix. Sufficient for
 *  test determinism (injectable) AND prod uniqueness (random suffix). */
const defaultIdGen = () => {
    let counter = 0;
    return () => {
        counter += 1;
        return `t-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    };
};
export const createInMemoryPlanStore = (opts) => {
    let plan = null;
    const idGen = opts.idGen ?? defaultIdGen();
    const emit = (d) => {
        try {
            opts.onDelta?.(d);
        }
        catch {
            // observer throw must not propagate to caller (mutation already applied).
        }
    };
    const cas = (expected) => {
        if (plan === null)
            return { ok: true, value: undefined };
        if (expected !== undefined && expected !== plan.version) {
            return { ok: false, error: { kind: "version_conflict", expected, actual: plan.version } };
        }
        return { ok: true, value: undefined };
    };
    const apply = (r) => {
        if (r.ok) {
            plan = r.value.plan;
            emit(r.value);
        }
        return r;
    };
    return {
        current: () => plan,
        create: (args) => {
            // Create only allowed when no plan exists OR plan exists and caller knows it.
            if (plan !== null)
                return {
                    ok: false,
                    error: { kind: "version_conflict", expected: -1, actual: plan.version },
                };
            return apply(createPlanReducer(args, opts.now(), idGen));
        },
        addTodos: (items, expectedVersion) => {
            const c = cas(expectedVersion);
            if (!c.ok)
                return c;
            if (plan === null)
                return {
                    ok: false,
                    error: { kind: "version_conflict", expected: expectedVersion, actual: -1 },
                };
            return apply(addTodosReducer(plan, items, opts.now(), idGen));
        },
        updateTodos: (patches, merge, expectedVersion) => {
            const c = cas(expectedVersion);
            if (!c.ok)
                return c;
            if (plan === null)
                return {
                    ok: false,
                    error: { kind: "version_conflict", expected: expectedVersion, actual: -1 },
                };
            return apply(updateTodosReducer(plan, patches, merge, opts.now()));
        },
        removeTodos: (ids, expectedVersion) => {
            const c = cas(expectedVersion);
            if (!c.ok)
                return c;
            if (plan === null)
                return {
                    ok: false,
                    error: { kind: "version_conflict", expected: expectedVersion, actual: -1 },
                };
            return apply(removeTodosReducer(plan, ids, opts.now()));
        },
        reorderPhases: (phaseIds, expectedVersion) => {
            const c = cas(expectedVersion);
            if (!c.ok)
                return c;
            if (plan === null)
                return {
                    ok: false,
                    error: { kind: "version_conflict", expected: expectedVersion, actual: -1 },
                };
            return apply(reorderPhasesReducer(plan, phaseIds, opts.now()));
        },
        updateMeta: (args, expectedVersion) => {
            const c = cas(expectedVersion);
            if (!c.ok)
                return c;
            if (plan === null)
                return {
                    ok: false,
                    error: { kind: "version_conflict", expected: expectedVersion, actual: -1 },
                };
            return apply(updateMetaReducer(plan, args, opts.now()));
        },
        snapshot: () => (plan === null ? null : toSnapshot(plan)),
        restore: (snap) => {
            const r = fromSnapshot(snap);
            if (!r.ok)
                return r;
            plan = r.value;
            return { ok: true, value: true };
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
            plan = null;
        },
    };
};
