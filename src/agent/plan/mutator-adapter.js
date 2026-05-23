/**
 * PlanStore → PlanMutator adapter (ADR-0096 draft).
 *
 * The producer-side `PlanStore` returns `PlanResult<PlanDelta>` (rich shape:
 * full Plan snapshot + typed delta). The duck-typed consumer-side
 * `PlanMutator` (in `@/tool/types`) returns `PlanMutationResult` (compact
 * shape: version + delta kind + touched ids). This adapter is the ONLY place
 * the two shapes meet — keeps the slice fence (`@/tool` never imports
 * `@/agent/plan`) intact, and centralizes the by-value translation so a
 * drift between producer and consumer fails at exactly one site.
 *
 * No heuristics — every mapping is a closed switch with `never` default arm.
 */
import { planErrorMessage } from "@/tool";
const deltaKind = (k) => {
    switch (k) {
        case "created":
        case "todos_added":
        case "todos_updated":
        case "todos_removed":
        case "phases_reordered":
        case "noop":
            return k;
        default: {
            const _e = k;
            return _e;
        }
    }
};
const errorCode = (e) => {
    switch (e) {
        case "version_conflict":
        case "todo_not_found":
        case "phase_not_found":
        case "dependency_cycle":
        case "dependency_unknown":
        case "self_dependency":
        case "content_too_long":
        case "invalid_status_transition":
        case "duplicate_id":
        case "empty_plan_create":
            return e;
        default: {
            const _e = e;
            return _e;
        }
    }
};
const ok = (delta) => {
    const touchedIds = delta.kind === "todos_added"
        ? delta.added.map((t) => t.id)
        : delta.kind === "todos_updated"
            ? delta.updated.map((t) => t.id)
            : delta.kind === "todos_removed"
                ? delta.removedIds
                : delta.kind === "created"
                    ? Object.keys(delta.plan.todos)
                    : [];
    return {
        ok: true,
        version: delta.plan.version,
        deltaKind: deltaKind(delta.kind),
        touchedIds,
    };
};
const fail = (e) => {
    const code = errorCode(e.kind);
    return { ok: false, reason: planErrorMessage(code), code };
};
const adapt = (r) => (r.ok ? ok(r.value) : fail(r.error));
/** Coerce a free-form `string` (zod-validated upstream) into a `TodoStatus`
 *  or fall back to undefined so the reducer uses its default. Closed list
 *  of 5 values; anything else returns undefined and the reducer's default
 *  (`pending`) applies. No heuristic — exact membership match only. */
const coerceStatus = (s) => {
    if (s === "pending" ||
        s === "in_progress" ||
        s === "completed" ||
        s === "cancelled" ||
        s === "blocked")
        return s;
    return undefined;
};
const coerceNewTodo = (ni) => ({
    content: ni.content,
    ...(coerceStatus(ni.status) !== undefined
        ? { status: coerceStatus(ni.status) }
        : {}),
    ...(ni.dependencies !== undefined ? { dependencies: ni.dependencies } : {}),
    ...(ni.phaseId !== undefined ? { phaseId: ni.phaseId } : {}),
    ...(ni.assignee !== undefined ? { assignee: ni.assignee } : {}),
    ...(ni.verifyHint !== undefined ? { verifyHint: ni.verifyHint } : {}),
});
const coerceTodoPatch = (p) => ({
    id: p.id,
    ...(p.content !== undefined ? { content: p.content } : {}),
    ...(coerceStatus(p.status) !== undefined ? { status: coerceStatus(p.status) } : {}),
    ...(p.dependencies !== undefined ? { dependencies: p.dependencies } : {}),
    ...(p.phaseId !== undefined ? { phaseId: p.phaseId } : {}),
    ...(p.assignee !== undefined ? { assignee: p.assignee } : {}),
    ...(p.verifyHint !== undefined ? { verifyHint: p.verifyHint } : {}),
});
/**
 * Build a `PlanMutator` (consumer-side, duck-typed) from a canonical
 * `PlanStore` (producer-side). Pure factory — the returned mutator captures
 * the store reference; subsequent `store.create(...)` / `addTodos(...)` etc.
 * flow through unchanged.
 */
export const planStoreToMutator = (store) => ({
    create: (args) => {
        const a = {
            name: args.name,
            overview: args.overview,
            ...(args.isProject !== undefined ? { isProject: args.isProject } : {}),
            todos: args.todos.map(coerceNewTodo),
            ...(args.phases !== undefined
                ? {
                    phases: args.phases.map((p) => ({
                        name: p.name,
                        ...(p.todoIndexes !== undefined ? { todoIndexes: p.todoIndexes } : {}),
                    })),
                }
                : {}),
        };
        return adapt(store.create(a));
    },
    addTodos: (items, expectedVersion) => adapt(store.addTodos(items.map(coerceNewTodo), expectedVersion)),
    updateTodos: (patches, merge, expectedVersion) => adapt(store.updateTodos(patches.map(coerceTodoPatch), merge, expectedVersion)),
    removeTodos: (ids, expectedVersion) => adapt(store.removeTodos(ids, expectedVersion)),
    updateMeta: (args, expectedVersion) => {
        // phaseOrder is in args but updateMeta on the producer doesn't accept it
        // directly — split into two reducer calls: updateMeta then reorderPhases.
        // Both bump version; if reorderPhases fails, the meta change still landed.
        // Documented behavior: meta first, then optional reorder.
        const metaArgs = {
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.overview !== undefined ? { overview: args.overview } : {}),
            ...(args.isProject !== undefined ? { isProject: args.isProject } : {}),
        };
        const metaTouched = args.name !== undefined || args.overview !== undefined || args.isProject !== undefined;
        if (metaTouched) {
            const r1 = store.updateMeta(metaArgs, expectedVersion);
            if (!r1.ok)
                return adapt(r1);
            if (args.phaseOrder !== undefined) {
                const r2 = store.reorderPhases(args.phaseOrder, r1.value.plan.version);
                return adapt(r2);
            }
            return adapt(r1);
        }
        if (args.phaseOrder !== undefined) {
            return adapt(store.reorderPhases(args.phaseOrder, expectedVersion));
        }
        // No-op call — still return a noop result via updateMeta path.
        return adapt(store.updateMeta({}, expectedVersion));
    },
    current: () => {
        const p = store.current();
        if (p === null)
            return null;
        return {
            version: p.version,
            name: p.name,
            overview: p.overview,
            isProject: p.isProject,
            todoCount: Object.keys(p.todos).length,
            phaseCount: p.phases.length,
        };
    },
});
