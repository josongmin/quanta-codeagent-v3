/**
 * Plan-mode SOTA++ data model (ADR-0095 draft, 2026-05-23).
 *
 * Canonical shapes for the structured plan-state-machine that the four model-
 * callable tools (`create_plan` / `update_todos` / `update_plan` /
 * `remove_todos`) mutate. Pure TypeScript — no zod, no runtime schemas; the
 * tool layer (`@/tool/plan`) attaches zod at the dispatch boundary.
 *
 * Design pillars (vs Codex/Cursor/Claude, see docs/plans/plan-mode-sota-plus-plus.md):
 *
 *   1. **Closed shapes**: every union is exhaustive — adding a value forces a
 *      `never` default arm to fail at compile time. No `string` discriminants.
 *   2. **Readonly throughout**: callers cannot mutate a `Plan` in place. State
 *      transitions happen exclusively through `PlanStore` mutations (see
 *      `state.ts`) which return new immutable snapshots.
 *   3. **Version-tracked CAS**: every mutation requires `expectedVersion`.
 *      Mismatch ⇒ {@link PlanMutationError} `version_conflict`. Optimistic
 *      concurrency without locks.
 *   4. **DAG-enforced dependencies**: `TodoItem.dependencies` is validated by
 *      `dag.ts` on every mutation that touches them. Cycle / self / dangling
 *      / unknown ⇒ typed rejection (see {@link PlanMutationError}).
 *   5. **Slice isolation**: `@/tool` mirrors readonly subsets via duck-typed
 *      `ToolContext.planMutator` seam (RFC §3.1; biome `noRestrictedImports`
 *      fence). Cross-slice flow stays by-value.
 *
 * Adding a new field to `TodoItem` / `Plan`: append-only (additive) keeps
 * snapshot round-trip (see `snapshot.ts`) byte-stable when the new field is
 * absent. Reading old snapshots ⇒ new field is `undefined`.
 */
/** All {@link TodoStatus} values as a frozen readonly array. Used by enum-
 *  coverage tests + UI iteration. */
export const ALL_TODO_STATUSES = Object.freeze([
    "pending",
    "in_progress",
    "completed",
    "cancelled",
    "blocked",
]);
/** Terminal statuses (no outgoing transitions). Used by `transitions.ts`. */
export const TERMINAL_TODO_STATUSES = Object.freeze([
    "completed",
    "cancelled",
]);
/** All {@link PlanDeltaKind} values for enum-coverage tests. */
export const ALL_PLAN_DELTA_KINDS = Object.freeze([
    "created",
    "todos_added",
    "todos_updated",
    "todos_removed",
    "phases_reordered",
    "noop",
]);
export const ALL_PLAN_MUTATION_ERROR_KINDS = Object.freeze([
    "version_conflict",
    "todo_not_found",
    "phase_not_found",
    "dependency_cycle",
    "dependency_unknown",
    "self_dependency",
    "content_too_long",
    "invalid_status_transition",
    "duplicate_id",
    "empty_plan_create",
]);
// ── Limits / constants ─────────────────────────────────────────────────
/** Maximum character lengths (DOS guards). Mutations reject above. */
export const PLAN_LIMITS = Object.freeze({
    /** Plan.name max chars. */
    MAX_NAME: 120,
    /** Plan.overview max chars. */
    MAX_OVERVIEW: 2000,
    /** TodoItem.content max chars. */
    MAX_TODO_CONTENT: 500,
    /** TodoItem.verifyHint max chars. */
    MAX_VERIFY_HINT: 300,
    /** Per-plan total todo count (Cursor-style cap; avoid runaway). */
    MAX_TODOS: 200,
    /** Per-plan phase count. */
    MAX_PHASES: 32,
    /** Per-todo dependency edge count (DAG fan-in/out cap). */
    MAX_DEPS_PER_TODO: 32,
});
