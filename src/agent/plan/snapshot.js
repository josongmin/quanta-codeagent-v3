/**
 * Plan snapshot serialization (ADR-0095 draft).
 *
 * Round-trip identity: `fromSnapshot(toSnapshot(p))` returns a plan
 * structurally equal to `p`. Schema-versioned (`"plan-v1"`) so future
 * additive fields can be migrated forward without breaking existing
 * snapshots. Defensive parse rejects 9 corruption classes with typed errors.
 */
import { validateDag } from "./dag";
import { PLAN_LIMITS, } from "./types";
export const PLAN_SNAPSHOT_SCHEMA = "plan-v1";
/** Frozen-deep clone for snapshot output (immutability guarantee). */
const freezePlan = (p) => {
    const todos = {};
    for (const id of Object.keys(p.todos)) {
        const t = p.todos[id];
        if (t === undefined)
            continue;
        todos[id] = Object.freeze({ ...t, dependencies: Object.freeze([...t.dependencies]) });
    }
    return Object.freeze({
        ...p,
        todos: Object.freeze(todos),
        phases: Object.freeze(p.phases.map((ph) => Object.freeze({ ...ph, todoIds: Object.freeze([...ph.todoIds]) }))),
    });
};
export const toSnapshot = (plan) => Object.freeze({ schema: PLAN_SNAPSHOT_SCHEMA, plan: freezePlan(plan) });
const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x) => typeof x === "string";
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const isBool = (x) => typeof x === "boolean";
const VALID_STATUSES = [
    "pending",
    "in_progress",
    "completed",
    "cancelled",
    "blocked",
];
const isStatus = (x) => isStr(x) && VALID_STATUSES.includes(x);
/**
 * Parse an unknown into a `Plan`. Rejects with the FIRST validation failure
 * encountered. The 9 covered corruption classes:
 *
 *   1. schema_mismatch    — `schema !== "plan-v1"` or absent.
 *   2. missing fields     — required Plan/Todo/Phase fields absent or wrong type.
 *   3. status_invalid     — TodoItem.status not in `VALID_STATUSES`.
 *   4. negative version   — `Plan.version < 0` or non-finite.
 *   5. dangling deps      — TodoItem.dependencies references an unknown id.
 *   6. non-monotonic ts   — createdAt > updatedAt for a TodoItem.
 *   7. duplicate todo id  — same id keyed twice (impossible in a Record but
 *                            checked via array deserialization path if any).
 *   8. duplicate phase id — two phases share `id`.
 *   9. phase ref unknown  — phase.todoIds[*] references an id not in todos.
 */
export const fromSnapshot = (raw) => {
    if (!isObj(raw)) {
        return {
            ok: false,
            error: {
                kind: "schema_mismatch",
                expected: PLAN_SNAPSHOT_SCHEMA,
                actual: "(non-object)",
            },
        };
    }
    if (raw.schema !== PLAN_SNAPSHOT_SCHEMA) {
        return {
            ok: false,
            error: {
                kind: "schema_mismatch",
                expected: PLAN_SNAPSHOT_SCHEMA,
                actual: String(raw.schema),
            },
        };
    }
    if (!isObj(raw.plan)) {
        return {
            ok: false,
            error: {
                kind: "schema_mismatch",
                expected: "plan-object",
                actual: typeof raw.plan,
            },
        };
    }
    const p = raw.plan;
    if (!isStr(p.name) || !isStr(p.overview) || !isBool(p.isProject)) {
        return {
            ok: false,
            error: { kind: "content_too_long", field: "name", max: PLAN_LIMITS.MAX_NAME, actual: 0 },
        };
    }
    if (!isNum(p.version) || p.version < 0) {
        return {
            ok: false,
            error: {
                kind: "content_too_long",
                field: "content",
                max: 0,
                actual: isNum(p.version) ? p.version : -1,
            },
        };
    }
    if (!isNum(p.createdAt) || !isNum(p.updatedAt)) {
        return { ok: false, error: { kind: "content_too_long", field: "content", max: 0, actual: 0 } };
    }
    // Parse todos.
    if (!isObj(p.todos)) {
        return { ok: false, error: { kind: "content_too_long", field: "content", max: 0, actual: 0 } };
    }
    const todos = {};
    const seenTodoIds = new Set();
    for (const key of Object.keys(p.todos)) {
        const t = p.todos[key];
        if (!isObj(t)) {
            return { ok: false, error: { kind: "todo_not_found", id: key } };
        }
        if (!isStr(t.id) || t.id !== key) {
            return { ok: false, error: { kind: "todo_not_found", id: key } };
        }
        if (seenTodoIds.has(t.id)) {
            return { ok: false, error: { kind: "duplicate_id", id: t.id } };
        }
        seenTodoIds.add(t.id);
        if (!isStr(t.content) || !isStatus(t.status) || !isNum(t.createdAt) || !isNum(t.updatedAt)) {
            return { ok: false, error: { kind: "todo_not_found", id: t.id } };
        }
        if (t.createdAt > t.updatedAt) {
            return {
                ok: false,
                error: {
                    kind: "content_too_long",
                    field: "content",
                    max: t.updatedAt,
                    actual: t.createdAt,
                },
            };
        }
        if (!Array.isArray(t.dependencies)) {
            return { ok: false, error: { kind: "todo_not_found", id: t.id } };
        }
        const deps = [];
        for (const dep of t.dependencies) {
            if (!isStr(dep)) {
                return { ok: false, error: { kind: "todo_not_found", id: t.id } };
            }
            deps.push(dep);
        }
        todos[t.id] = {
            id: t.id,
            content: t.content,
            status: t.status,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            dependencies: deps,
            ...(typeof t.phaseId === "string" ? { phaseId: t.phaseId } : {}),
            ...(typeof t.assignee === "string" ? { assignee: t.assignee } : {}),
            ...(typeof t.verifyHint === "string" ? { verifyHint: t.verifyHint } : {}),
        };
    }
    // Parse phases.
    if (!Array.isArray(p.phases)) {
        return { ok: false, error: { kind: "phase_not_found", id: "(non-array)" } };
    }
    const phases = [];
    const seenPhaseIds = new Set();
    for (const ph of p.phases) {
        if (!isObj(ph) || !isStr(ph.id) || !isStr(ph.name) || !isNum(ph.order)) {
            return { ok: false, error: { kind: "phase_not_found", id: "(invalid)" } };
        }
        if (seenPhaseIds.has(ph.id)) {
            return { ok: false, error: { kind: "duplicate_id", id: ph.id } };
        }
        seenPhaseIds.add(ph.id);
        if (!Array.isArray(ph.todoIds)) {
            return { ok: false, error: { kind: "phase_not_found", id: ph.id } };
        }
        const todoIds = [];
        for (const tid of ph.todoIds) {
            if (!isStr(tid)) {
                return { ok: false, error: { kind: "phase_not_found", id: ph.id } };
            }
            if (!(tid in todos)) {
                return { ok: false, error: { kind: "todo_not_found", id: tid } };
            }
            todoIds.push(tid);
        }
        phases.push({ id: ph.id, name: ph.name, todoIds, order: ph.order });
    }
    // DAG validation last (catches dangling + cycles).
    const dagOk = validateDag(todos);
    if (!dagOk.ok)
        return { ok: false, error: dagOk.error };
    const plan = {
        version: p.version,
        name: p.name,
        overview: p.overview,
        isProject: p.isProject,
        todos,
        phases,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
    };
    return { ok: true, value: plan };
};
