/**
 * Plan → stream-mirror projector (ADR-0095 P7).
 *
 * The stream slice (`@/stream/types`) declares minimalist mirrors of plan
 * shapes (`PlanReadonlyMirror`, `TodoReadonlyMirror`) so cross-slice flow
 * stays by-value (RFC §3.1 — `@/stream` MUST NOT import `@/agent/plan`).
 * This file is the single coercion site from canonical {@link Plan} to the
 * minimalist mirror shape.
 *
 * No heuristics — `id` is a deterministic function of `createdAt` so the
 * mirror has a stable identifier across emits without requiring `Plan` to
 * carry one. Adding a field to the mirror MUST also extend this projector
 * (closed-shape drift gate).
 */
/** Coerce canonical `TodoStatus` → mirror `TodoStatusMirror`. Closed switch
 *  with `never` default arm: adding a status to canonical forces a compile
 *  error here. The mirror happens to use the SAME literals today; if they
 *  ever diverge, the mapping stays explicit. */
const todoStatusMirror = (s) => {
    switch (s) {
        case "pending":
        case "in_progress":
        case "completed":
        case "cancelled":
        case "blocked":
            return s;
        default: {
            const _e = s;
            return _e;
        }
    }
};
const todoToMirror = (t) => ({
    id: t.id,
    title: t.content,
    status: todoStatusMirror(t.status),
});
/**
 * Project a canonical {@link Plan} into the stream-mirror
 * {@link PlanReadonlyMirror} shape. The mirror's `id` is derived
 * deterministically from `createdAt` — closed-shape, no heuristic, stable
 * across mutations until {@link PlanStore.clear} resets the plan.
 */
export const planToStreamMirror = (plan) => ({
    id: `plan-${plan.createdAt}`,
    name: plan.name,
    version: plan.version,
    todos: Object.values(plan.todos).map(todoToMirror),
});
