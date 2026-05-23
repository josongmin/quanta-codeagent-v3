/**
 * Pure plan-state reducers (ADR-0095 draft).
 *
 * Every reducer takes a plan + inputs + injected `now`/`idGen` and returns
 * {@link PlanResult}<{@link PlanDelta}>. No state, no I/O, no logger. Side-
 * effect-free (call twice → identical result given identical injected ids).
 *
 * Validation order (deterministic; per-reducer specifics noted):
 *   1. PLAN_LIMITS bounds (name / overview / content / verifyHint length,
 *      total todo count, phase count, deps fan-out).
 *   2. duplicate_id (within a batch + against existing plan).
 *   3. invalid_status_transition (per `transitions.ts` matrix).
 *   4. {@link validateDag} (self_dep → dependency_unknown → dependency_cycle).
 *   5. version bump (CAS is handled by `state.ts`, NOT here — reducers are
 *      version-agnostic; `state.ts` checks expectedVersion BEFORE calling).
 *
 * Reducers are exported individually so `state.ts` can compose them and the
 * tool layer can call them via the `PlanStore` interface — never directly.
 */
import { validateDag } from "./dag";
import { isValidTransition } from "./transitions";
import { PLAN_LIMITS, } from "./types";
// ── helpers (pure) ───────────────────────────────────────────────────────
const err = (error) => ({ ok: false, error });
const checkLen = (field, value, max) => value.length > max ? { kind: "content_too_long", field, max, actual: value.length } : null;
const checkVerifyHint = (value) => value !== undefined && value.length > PLAN_LIMITS.MAX_VERIFY_HINT
    ? {
        kind: "content_too_long",
        field: "content",
        max: PLAN_LIMITS.MAX_VERIFY_HINT,
        actual: value.length,
    }
    : null;
const dedupeIds = (ids) => {
    const seen = new Set();
    for (const id of ids) {
        if (seen.has(id))
            return id;
        seen.add(id);
    }
    return null;
};
/** Build a new TodoItem from NewTodo input. Generates id via injected idGen.
 *  Status defaults to "pending". Optional fields are spread only if present. */
const buildTodoItem = (input, id, now) => {
    const lenErr = checkLen("content", input.content, PLAN_LIMITS.MAX_TODO_CONTENT);
    if (lenErr !== null)
        return { ok: false, error: lenErr };
    const hintErr = checkVerifyHint(input.verifyHint);
    if (hintErr !== null)
        return { ok: false, error: hintErr };
    if ((input.dependencies?.length ?? 0) > PLAN_LIMITS.MAX_DEPS_PER_TODO) {
        return {
            ok: false,
            error: {
                kind: "content_too_long",
                field: "content",
                max: PLAN_LIMITS.MAX_DEPS_PER_TODO,
                actual: input.dependencies?.length ?? 0,
            },
        };
    }
    const item = {
        id,
        content: input.content,
        status: input.status ?? "pending",
        createdAt: now,
        updatedAt: now,
        dependencies: input.dependencies ?? [],
        ...(input.phaseId !== undefined ? { phaseId: input.phaseId } : {}),
        ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
        ...(input.verifyHint !== undefined ? { verifyHint: input.verifyHint } : {}),
    };
    return { ok: true, item };
};
// ── createPlan ───────────────────────────────────────────────────────────
export const createPlan = (args, now, idGen) => {
    if (args.todos.length === 0 && (args.phases?.length ?? 0) === 0) {
        return err({ kind: "empty_plan_create" });
    }
    if (args.todos.length > PLAN_LIMITS.MAX_TODOS) {
        return err({
            kind: "content_too_long",
            field: "content",
            max: PLAN_LIMITS.MAX_TODOS,
            actual: args.todos.length,
        });
    }
    if ((args.phases?.length ?? 0) > PLAN_LIMITS.MAX_PHASES) {
        return err({
            kind: "content_too_long",
            field: "content",
            max: PLAN_LIMITS.MAX_PHASES,
            actual: args.phases?.length ?? 0,
        });
    }
    const nameErr = checkLen("name", args.name, PLAN_LIMITS.MAX_NAME);
    if (nameErr !== null)
        return err(nameErr);
    const overErr = checkLen("overview", args.overview, PLAN_LIMITS.MAX_OVERVIEW);
    if (overErr !== null)
        return err(overErr);
    // Build phases first (with generated ids), then todos with phaseId binding.
    const phases = [];
    const phaseIdByIndex = [];
    for (let i = 0; i < (args.phases?.length ?? 0); i += 1) {
        const p = args.phases?.[i];
        if (p === undefined)
            continue;
        const pid = idGen();
        phaseIdByIndex.push(pid);
        phases.push({ id: pid, name: p.name, todoIds: [], order: i });
    }
    // Build todos.
    const todos = {};
    const newIds = [];
    for (let i = 0; i < args.todos.length; i += 1) {
        const ni = args.todos[i];
        if (ni === undefined)
            continue;
        const id = idGen();
        if (todos[id] !== undefined)
            return err({ kind: "duplicate_id", id });
        const built = buildTodoItem(ni, id, now);
        if (!built.ok)
            return err(built.error);
        todos[id] = built.item;
        newIds.push(id);
    }
    // Bind todos → phases via NewPhase.todoIndexes (or default: spread evenly into phase 0).
    const argPhases = args.phases ?? [];
    for (let pi = 0; pi < argPhases.length; pi += 1) {
        const p = argPhases[pi];
        const phase = phases[pi];
        if (p === undefined || phase === undefined)
            continue;
        const indexes = p.todoIndexes ?? [];
        const todoIds = [];
        for (const idx of indexes) {
            const tid = newIds[idx];
            if (tid === undefined) {
                return err({ kind: "todo_not_found", id: `index:${idx}` });
            }
            const todo = todos[tid];
            if (todo !== undefined) {
                todos[tid] = { ...todo, phaseId: phase.id };
            }
            todoIds.push(tid);
        }
        phases[pi] = { ...phase, todoIds };
    }
    // DAG validation.
    const dagOk = validateDag(todos);
    if (!dagOk.ok)
        return err(dagOk.error);
    const plan = {
        version: 0,
        name: args.name,
        overview: args.overview,
        isProject: args.isProject ?? false,
        todos,
        phases,
        createdAt: now,
        updatedAt: now,
    };
    return { ok: true, value: { kind: "created", plan } };
};
// ── addTodos ─────────────────────────────────────────────────────────────
export const addTodos = (plan, items, now, idGen) => {
    if (items.length === 0) {
        return {
            ok: true,
            value: { kind: "noop", plan: { ...plan, version: plan.version + 1, updatedAt: now } },
        };
    }
    if (Object.keys(plan.todos).length + items.length > PLAN_LIMITS.MAX_TODOS) {
        return err({
            kind: "content_too_long",
            field: "content",
            max: PLAN_LIMITS.MAX_TODOS,
            actual: Object.keys(plan.todos).length + items.length,
        });
    }
    const newTodos = { ...plan.todos };
    const added = [];
    for (const ni of items) {
        const id = idGen();
        if (newTodos[id] !== undefined)
            return err({ kind: "duplicate_id", id });
        if (ni.phaseId !== undefined && !plan.phases.some((p) => p.id === ni.phaseId)) {
            return err({ kind: "phase_not_found", id: ni.phaseId });
        }
        const built = buildTodoItem(ni, id, now);
        if (!built.ok)
            return err(built.error);
        newTodos[id] = built.item;
        added.push(built.item);
    }
    const dagOk = validateDag(newTodos);
    if (!dagOk.ok)
        return err(dagOk.error);
    const newPlan = {
        ...plan,
        version: plan.version + 1,
        todos: newTodos,
        updatedAt: now,
    };
    return { ok: true, value: { kind: "todos_added", added, plan: newPlan } };
};
// ── updateTodos ──────────────────────────────────────────────────────────
const applyPatch = (existing, patch, merge, now) => {
    if (patch.content !== undefined) {
        const e = checkLen("content", patch.content, PLAN_LIMITS.MAX_TODO_CONTENT);
        if (e !== null)
            return { ok: false, error: e };
    }
    if (patch.verifyHint !== undefined && patch.verifyHint !== null) {
        const e = checkVerifyHint(patch.verifyHint);
        if (e !== null)
            return { ok: false, error: e };
    }
    if (patch.status !== undefined && patch.status !== existing.status) {
        if (!isValidTransition(existing.status, patch.status)) {
            return {
                ok: false,
                error: {
                    kind: "invalid_status_transition",
                    from: existing.status,
                    to: patch.status,
                    id: existing.id,
                },
            };
        }
    }
    if ((patch.dependencies?.length ?? 0) > PLAN_LIMITS.MAX_DEPS_PER_TODO) {
        return {
            ok: false,
            error: {
                kind: "content_too_long",
                field: "content",
                max: PLAN_LIMITS.MAX_DEPS_PER_TODO,
                actual: patch.dependencies?.length ?? 0,
            },
        };
    }
    // Merge vs replace: under merge=false, missing fields drop to default/clear.
    // We treat content/status/dependencies as REQUIRED-fields so merge=false keeps them; the difference
    // is on optional fields (phaseId, assignee, verifyHint) where null SENTINEL clears under either mode.
    const item = {
        id: existing.id,
        content: patch.content ?? (merge ? existing.content : existing.content),
        status: patch.status ?? (merge ? existing.status : existing.status),
        createdAt: existing.createdAt,
        updatedAt: now,
        dependencies: patch.dependencies ?? (merge ? existing.dependencies : existing.dependencies),
        ...(patch.phaseId === null
            ? {}
            : patch.phaseId !== undefined
                ? { phaseId: patch.phaseId }
                : merge && existing.phaseId !== undefined
                    ? { phaseId: existing.phaseId }
                    : {}),
        ...(patch.assignee === null
            ? {}
            : patch.assignee !== undefined
                ? { assignee: patch.assignee }
                : merge && existing.assignee !== undefined
                    ? { assignee: existing.assignee }
                    : {}),
        ...(patch.verifyHint === null
            ? {}
            : patch.verifyHint !== undefined
                ? { verifyHint: patch.verifyHint }
                : merge && existing.verifyHint !== undefined
                    ? { verifyHint: existing.verifyHint }
                    : {}),
    };
    return { ok: true, item };
};
export const updateTodos = (plan, patches, merge, now) => {
    if (patches.length === 0) {
        return {
            ok: true,
            value: { kind: "noop", plan: { ...plan, version: plan.version + 1, updatedAt: now } },
        };
    }
    const dupId = dedupeIds(patches.map((p) => p.id));
    if (dupId !== null)
        return err({ kind: "duplicate_id", id: dupId });
    const newTodos = { ...plan.todos };
    const updated = [];
    for (const patch of patches) {
        const existing = newTodos[patch.id];
        if (existing === undefined)
            return err({ kind: "todo_not_found", id: patch.id });
        if (patch.phaseId !== undefined &&
            patch.phaseId !== null &&
            !plan.phases.some((p) => p.id === patch.phaseId)) {
            return err({ kind: "phase_not_found", id: patch.phaseId });
        }
        const built = applyPatch(existing, patch, merge, now);
        if (!built.ok)
            return err(built.error);
        newTodos[patch.id] = built.item;
        updated.push(built.item);
    }
    const dagOk = validateDag(newTodos);
    if (!dagOk.ok)
        return err(dagOk.error);
    const newPlan = { ...plan, version: plan.version + 1, todos: newTodos, updatedAt: now };
    return { ok: true, value: { kind: "todos_updated", updated, plan: newPlan } };
};
// ── removeTodos ──────────────────────────────────────────────────────────
export const removeTodos = (plan, ids, now) => {
    if (ids.length === 0) {
        return {
            ok: true,
            value: { kind: "noop", plan: { ...plan, version: plan.version + 1, updatedAt: now } },
        };
    }
    const dupId = dedupeIds(ids);
    if (dupId !== null)
        return err({ kind: "duplicate_id", id: dupId });
    const newTodos = { ...plan.todos };
    const removed = [];
    for (const id of ids) {
        if (newTodos[id] === undefined)
            return err({ kind: "todo_not_found", id });
        delete newTodos[id];
        removed.push(id);
    }
    // Post-removal DAG check: any todo still in plan referencing a removed id → dangling.
    const dagOk = validateDag(newTodos);
    if (!dagOk.ok)
        return err(dagOk.error);
    // Phase todoIds: strip removed ids from each phase.
    const newPhases = plan.phases.map((p) => ({
        ...p,
        todoIds: p.todoIds.filter((id) => !removed.includes(id)),
    }));
    const newPlan = {
        ...plan,
        version: plan.version + 1,
        todos: newTodos,
        phases: newPhases,
        updatedAt: now,
    };
    return { ok: true, value: { kind: "todos_removed", removedIds: removed, plan: newPlan } };
};
// ── reorderPhases ────────────────────────────────────────────────────────
export const reorderPhases = (plan, phaseIds, now) => {
    if (plan.phases.length === 0 && phaseIds.length === 0) {
        return {
            ok: true,
            value: { kind: "noop", plan: { ...plan, version: plan.version + 1, updatedAt: now } },
        };
    }
    const dupId = dedupeIds(phaseIds);
    if (dupId !== null)
        return err({ kind: "duplicate_id", id: dupId });
    if (phaseIds.length !== plan.phases.length) {
        // Must reorder full set (partial reorder ambiguous); treat as not_found if any id missing.
        for (const id of phaseIds) {
            if (!plan.phases.some((p) => p.id === id))
                return err({ kind: "phase_not_found", id });
        }
        // Or unknown phase if length mismatch with extras.
        if (phaseIds.length > plan.phases.length) {
            const extra = phaseIds.find((id) => !plan.phases.some((p) => p.id === id));
            if (extra !== undefined)
                return err({ kind: "phase_not_found", id: extra });
        }
        // Length less than current → missing required ids.
        const missing = plan.phases.find((p) => !phaseIds.includes(p.id));
        if (missing !== undefined)
            return err({ kind: "phase_not_found", id: missing.id });
    }
    // All ids match — reorder by index in phaseIds.
    const byId = new Map(plan.phases.map((p) => [p.id, p]));
    const newPhases = [];
    for (let i = 0; i < phaseIds.length; i += 1) {
        const id = phaseIds[i];
        if (id === undefined)
            continue;
        const p = byId.get(id);
        if (p === undefined)
            return err({ kind: "phase_not_found", id });
        newPhases.push({ ...p, order: i });
    }
    const newPlan = { ...plan, version: plan.version + 1, phases: newPhases, updatedAt: now };
    return { ok: true, value: { kind: "phases_reordered", plan: newPlan } };
};
// ── updateMeta ───────────────────────────────────────────────────────────
export const updateMeta = (plan, args, now) => {
    if (args.name !== undefined) {
        const e = checkLen("name", args.name, PLAN_LIMITS.MAX_NAME);
        if (e !== null)
            return err(e);
    }
    if (args.overview !== undefined) {
        const e = checkLen("overview", args.overview, PLAN_LIMITS.MAX_OVERVIEW);
        if (e !== null)
            return err(e);
    }
    const newPlan = {
        ...plan,
        version: plan.version + 1,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.overview !== undefined ? { overview: args.overview } : {}),
        ...(args.isProject !== undefined ? { isProject: args.isProject } : {}),
        updatedAt: now,
    };
    // No structural change → noop kind (version still bumped per noop semantics).
    return { ok: true, value: { kind: "noop", plan: newPlan } };
};
