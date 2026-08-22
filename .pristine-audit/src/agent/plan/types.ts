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

/**
 * Closed 5-state todo lifecycle enum (vs Cursor's `UNSPECIFIED`-including loose
 * enum). Adding a status MUST extend {@link ALL_TODO_STATUSES} AND the
 * transition matrix in `transitions.ts` — exhaustive switches will fail to
 * compile otherwise.
 *
 *   - `pending`      — created, not started; default initial status.
 *   - `in_progress`  — actively being worked on (model or human).
 *   - `completed`    — terminal success.
 *   - `cancelled`    — terminal abandonment (never executed, not failed).
 *   - `blocked`      — dependency unmet OR external block; recoverable.
 */
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled" | "blocked"

/** All {@link TodoStatus} values as a frozen readonly array. Used by enum-
 *  coverage tests + UI iteration. */
export const ALL_TODO_STATUSES = Object.freeze([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
  "blocked",
] as const satisfies readonly TodoStatus[])
// Drift guard: `satisfies` = array⊆union; Assert = union⊆array. The outer
// annotation was removed so `[number]` is the literal tuple (not the widened
// union, which would make this reverse check trivially true). A new TodoStatus
// missing from the array → build error.
type _AssertTodo<T extends true> = T
export type _TodoStatusesDriftGuard = _AssertTodo<
  TodoStatus extends (typeof ALL_TODO_STATUSES)[number] ? true : false
>

/** Terminal statuses (no outgoing transitions). Used by `transitions.ts`. */
export const TERMINAL_TODO_STATUSES: readonly TodoStatus[] = Object.freeze([
  "completed",
  "cancelled",
] as const)

/**
 * A single todo item. Immutable — mutations produce a new instance via
 * `mutations.ts` reducers. `id` is a ULID (monotonic, sortable, opaque).
 *
 * `dependencies` form a DAG across the plan's whole todo set: cycles,
 * self-references, and unknown ids are rejected by `dag.ts`. Cross-phase
 * dependencies are legal (a phase boundary is for grouping, not isolation).
 *
 * `assignee` and `verifyHint` are SOTA++ extensions beyond Cursor's TodoItem:
 * they bridge plan-mode to ADR-0042 subagent nicknames and ADR-0013 verify-
 * guard respectively, so a plan can carry execution + verification intent.
 */
export interface TodoItem {
  readonly id: string
  readonly content: string
  readonly status: TodoStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly dependencies: readonly string[]
  readonly phaseId?: string
  readonly assignee?: string
  readonly verifyHint?: string
  /**
   * S2 unified-observability (jul-03) — present-tense "active form" label shown
   * while this todo is `in_progress` (e.g. content "Fix the parser" →
   * activeForm "Fixing the parser"), mirroring the TodoWrite `activeForm`
   * convention. APPEND-ONLY / OPTIONAL: absent ⇒ a surface falls back to
   * `content`, and the snapshot round-trip (`snapshot.ts`) stays byte-stable
   * (an absent field never serialises). Never used for control flow — a pure
   * display affordance folded onto the `plan` item core.
   */
  readonly activeForm?: string
}

/**
 * A named grouping of todos. Pure organizational construct — does NOT gate
 * dependency edges (cross-phase deps are legal). `order` is strictly
 * monotonic and gap-allowed so reorder operations can swap without renumber.
 */
export interface Phase {
  readonly id: string
  readonly name: string
  readonly todoIds: readonly string[]
  readonly order: number
}

/**
 * The top-level plan envelope. `version` is the CAS handle — every mutation
 * bumps it by exactly 1. A surface that holds a stale plan must reconcile
 * before retrying (see {@link PlanMutationError} `version_conflict`).
 *
 * `todos` is a Record keyed by id (constant-time lookup); iteration order is
 * NOT guaranteed (use `phases[*].todoIds` for ordered traversal or sort by
 * `createdAt`/`id` for deterministic display).
 *
 * `isProject` distinguishes a long-lived plan persisted across sessions
 * (project-level) from an ephemeral plan that lives only for the current
 * conversation. Persistence (`snapshot.ts`) treats both uniformly; surfaces
 * may display them differently.
 */
export interface Plan {
  readonly version: number
  readonly name: string
  readonly overview: string
  readonly isProject: boolean
  readonly todos: Readonly<Record<string, TodoItem>>
  readonly phases: readonly Phase[]
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * Typed delta from a successful mutation. Surfaces (CLI / IDE / Tauri) use
 * this to render incremental updates without diffing the full plan. The
 * `plan` field always carries the post-mutation snapshot so late-attaching
 * surfaces (re-connected web client) can paint from any single event.
 *
 *   - `created`           — first {@link Plan} bound to the store.
 *   - `todos_added`       — one or more new {@link TodoItem}s appended.
 *   - `todos_updated`     — one or more todos mutated (status / content / deps).
 *   - `todos_removed`     — todos deleted (also implies any dangling dep edges
 *                            were rejected as `dependency_unknown` BEFORE the
 *                            remove was applied).
 *   - `phases_reordered`  — phase array reordered; todos untouched.
 *   - `noop`              — empty patch / merge with no changes (idempotent).
 *                            Plan version still bumps so callers can detect
 *                            "checked but found no change."
 */
export type PlanDeltaKind =
  | "created"
  | "todos_added"
  | "todos_updated"
  | "todos_removed"
  | "phases_reordered"
  | "noop"

export type PlanDelta =
  | { readonly kind: "created"; readonly plan: Plan }
  | { readonly kind: "todos_added"; readonly added: readonly TodoItem[]; readonly plan: Plan }
  | { readonly kind: "todos_updated"; readonly updated: readonly TodoItem[]; readonly plan: Plan }
  | { readonly kind: "todos_removed"; readonly removedIds: readonly string[]; readonly plan: Plan }
  | { readonly kind: "phases_reordered"; readonly plan: Plan }
  | { readonly kind: "noop"; readonly plan: Plan }

/** All {@link PlanDeltaKind} values for enum-coverage tests. */
export const ALL_PLAN_DELTA_KINDS = Object.freeze([
  "created",
  "todos_added",
  "todos_updated",
  "todos_removed",
  "phases_reordered",
  "noop",
] as const satisfies readonly PlanDeltaKind[])
type _AssertDelta<T extends true> = T
export type _PlanDeltaKindsDriftGuard = _AssertDelta<
  PlanDeltaKind extends (typeof ALL_PLAN_DELTA_KINDS)[number] ? true : false
>

/**
 * Closed mutation-error taxonomy. Every reducer in `mutations.ts` returns
 * `Result<PlanDelta, PlanMutationError>` (see {@link PlanResult}). The tool
 * layer maps this onto the {@link import("@/tool").ToolFailure} discriminated
 * union (`mode: "rejected"` + reason code in `failure` detail) so the model
 * can branch programmatically.
 *
 *   - `version_conflict`           — CAS expected/actual mismatch.
 *   - `todo_not_found`             — update/remove referenced an unknown id.
 *   - `phase_not_found`            — todo.phaseId or reorder referenced an
 *                                     unknown phase.
 *   - `dependency_cycle`           — DAG validation found a cycle; `path` is
 *                                     the cycle nodes in traversal order.
 *   - `dependency_unknown`         — todo `from` depends on `to`, but `to`
 *                                     does not exist in the plan after the
 *                                     mutation applies (dangling).
 *   - `self_dependency`            — todo lists itself in `dependencies`.
 *   - `content_too_long`           — `field` exceeded `max` chars.
 *   - `invalid_status_transition`  — `from`→`to` not in the matrix.
 *   - `duplicate_id`               — an `add` introduced an id already in
 *                                     the plan (also fires on phase id
 *                                     collisions).
 *   - `empty_plan_create`          — `create_plan` called with zero todos
 *                                     AND zero phases (no work item to
 *                                     anchor; require at least one).
 */
export type PlanMutationError =
  | { readonly kind: "version_conflict"; readonly expected: number; readonly actual: number }
  | { readonly kind: "todo_not_found"; readonly id: string }
  | { readonly kind: "phase_not_found"; readonly id: string }
  | { readonly kind: "dependency_cycle"; readonly path: readonly string[] }
  | { readonly kind: "dependency_unknown"; readonly from: string; readonly to: string }
  | { readonly kind: "self_dependency"; readonly id: string }
  | {
      readonly kind: "content_too_long"
      readonly field: "name" | "overview" | "content"
      readonly max: number
      readonly actual: number
    }
  | {
      readonly kind: "invalid_status_transition"
      readonly from: TodoStatus
      readonly to: TodoStatus
      readonly id: string
    }
  | { readonly kind: "duplicate_id"; readonly id: string }
  | { readonly kind: "empty_plan_create" }

/** Closed list of {@link PlanMutationError} `kind` values for the enum-
 *  coverage test + tool-layer reason mapping. */
export type PlanMutationErrorKind = PlanMutationError["kind"]
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
] as const satisfies readonly PlanMutationErrorKind[])
type _AssertPlanErr<T extends true> = T
export type _PlanMutationErrorKindsDriftGuard = _AssertPlanErr<
  PlanMutationErrorKind extends (typeof ALL_PLAN_MUTATION_ERROR_KINDS)[number] ? true : false
>

/**
 * Mutation result envelope. Result-monad over delta + typed error so callers
 * NEVER have to try/catch a thrown mutation. Following the `Result<T,E>`
 * pattern from `@/runtime/sandbox` for consistency.
 */
export type PlanResult<T = PlanDelta> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PlanMutationError }

// ── Input shapes (model → tool → mutations) ─────────────────────────────

/**
 * Input shape for adding a new todo. `id` is OMITTED (mutations generate ULIDs)
 * to prevent the model from spoofing existing ids. `createdAt`/`updatedAt`
 * are computed by `state.ts` from the caller-supplied clock.
 */
export interface NewTodo {
  readonly content: string
  readonly status?: TodoStatus
  readonly dependencies?: readonly string[]
  readonly phaseId?: string
  readonly assignee?: string
  readonly verifyHint?: string
}

/**
 * Patch for an existing todo. All fields except `id` are optional — undefined
 * means "leave as-is" (under `merge:true` semantics). Empty `dependencies:[]`
 * means "drop all deps" (intent-explicit; cannot be confused with undefined).
 */
export interface TodoPatch {
  readonly id: string
  readonly content?: string
  readonly status?: TodoStatus
  readonly dependencies?: readonly string[]
  readonly phaseId?: string | null // null sentinel = clear phaseId
  readonly assignee?: string | null
  readonly verifyHint?: string | null
}

/** Input shape for `create_plan`. Mirrors {@link Plan} minus computed
 *  fields (version=0, ts injected). Phases optional; if absent ⇒ all todos
 *  share an implicit single phase (rendered as "(default)"). */
export interface CreatePlanArgs {
  readonly name: string
  readonly overview: string
  readonly isProject?: boolean
  readonly todos: readonly NewTodo[]
  readonly phases?: readonly NewPhase[]
}

export interface NewPhase {
  readonly name: string
  readonly todoIndexes?: readonly number[] // indexes INTO `todos[]` (id-free)
}

/** Input shape for `update_plan` (meta only — does NOT touch todos). */
export interface UpdatePlanArgs {
  readonly name?: string
  readonly overview?: string
  readonly isProject?: boolean
  readonly phaseOrder?: readonly string[] // phase ids in new order
  readonly expectedVersion: number
}

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
} as const)

// ── Readonly mirrors for slice isolation ────────────────────────────────

/**
 * Structurally-identical readonly mirror of {@link Plan} for cross-slice
 * publication (e.g. `@/tool`, `@/stream`). Slices that ship this type
 * STRUCTURALLY (duck-typed via `ToolContext.planMutator` etc.) instead of
 * importing `@/agent/plan` keep the slice fence intact. Adding a field here
 * MUST also add it to {@link Plan}.
 */
export type PlanReadonly = Plan

/** Structurally-identical readonly mirror of {@link PlanDelta} for events. */
export type PlanDeltaReadonly = PlanDelta
