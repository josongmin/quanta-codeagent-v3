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

import { validateDag } from "./dag"
import { isValidTransition } from "./transitions"
import {
  type CreatePlanArgs,
  type NewPhase,
  type NewTodo,
  type Phase,
  PLAN_LIMITS,
  type Plan,
  type PlanDelta,
  type PlanMutationError,
  type PlanResult,
  type TodoItem,
  type TodoPatch,
  type TodoStatus,
} from "./types"

// ── helpers (pure) ───────────────────────────────────────────────────────

const err = (error: PlanMutationError): PlanResult => ({ ok: false, error })

const checkLen = (
  field: "name" | "overview" | "content",
  value: string,
  max: number,
): PlanMutationError | null =>
  value.length > max ? { kind: "content_too_long", field, max, actual: value.length } : null

const checkVerifyHint = (value: string | undefined): PlanMutationError | null =>
  value !== undefined && value.length > PLAN_LIMITS.MAX_VERIFY_HINT
    ? {
        kind: "content_too_long",
        field: "content",
        max: PLAN_LIMITS.MAX_VERIFY_HINT,
        actual: value.length,
      }
    : null

const dedupeIds = (ids: readonly string[]): string | null => {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) return id
    seen.add(id)
  }
  return null
}

/**
 * T04 owning-seam — re-derive every `phase.todoIds` from the authoritative
 * `todo.phaseId` side so the two never drift.
 *
 * The reducers treat `todo.phaseId` as the SINGLE source of truth for
 * membership; `phase.todoIds` is a DERIVED ordered view. This helper rebuilds
 * each phase's `todoIds` to exactly the set of todos whose `phaseId` points at
 * it, while PRESERVING the prior intra-phase order and APPENDING any newly
 * bound todos (deterministic order: existing-first, then new-by-insertion).
 *
 * Guarantees post-condition for any plan it produces:
 *   (a) todo.phaseId === ph.id            ⇒ ph.todoIds includes todo.id
 *   (b) id ∈ ph.todoIds                   ⇒ todo exists ∧ todo.phaseId === ph.id
 *   (c) no todo id appears in two phases' todoIds
 *
 * Pure — no I/O, deterministic given identical inputs.
 */
const syncPhaseMembership = (
  phases: readonly Phase[],
  todos: Readonly<Record<string, TodoItem>>,
): Phase[] => {
  // Group todo ids by their current phaseId (insertion order = Object key order
  // for newly-built records; for existing todos we re-impose the prior phase
  // order below so display stays stable).
  const boundByPhase = new Map<string, string[]>()
  for (const phase of phases) boundByPhase.set(phase.id, [])
  for (const id of Object.keys(todos)) {
    const todo = todos[id]
    if (todo?.phaseId === undefined) continue
    const bucket = boundByPhase.get(todo.phaseId)
    if (bucket !== undefined) bucket.push(id)
  }
  return phases.map((phase) => {
    const members = boundByPhase.get(phase.id) ?? []
    const memberSet = new Set(members)
    // Prior order first (only ids still bound here), then any new bindings.
    const ordered: string[] = []
    for (const id of phase.todoIds) {
      if (memberSet.has(id)) {
        ordered.push(id)
        memberSet.delete(id)
      }
    }
    for (const id of members) {
      if (memberSet.has(id)) {
        ordered.push(id)
        memberSet.delete(id)
      }
    }
    return { ...phase, todoIds: ordered }
  })
}

/** Build a new TodoItem from NewTodo input. Generates id via injected idGen.
 *  Status defaults to "pending". Optional fields are spread only if present. */
const buildTodoItem = (
  input: NewTodo,
  id: string,
  now: number,
): { ok: true; item: TodoItem } | { ok: false; error: PlanMutationError } => {
  const lenErr = checkLen("content", input.content, PLAN_LIMITS.MAX_TODO_CONTENT)
  if (lenErr !== null) return { ok: false, error: lenErr }
  const hintErr = checkVerifyHint(input.verifyHint)
  if (hintErr !== null) return { ok: false, error: hintErr }
  if ((input.dependencies?.length ?? 0) > PLAN_LIMITS.MAX_DEPS_PER_TODO) {
    return {
      ok: false,
      error: {
        kind: "content_too_long",
        field: "content",
        max: PLAN_LIMITS.MAX_DEPS_PER_TODO,
        actual: input.dependencies?.length ?? 0,
      },
    }
  }
  const item: TodoItem = {
    id,
    content: input.content,
    status: input.status ?? "pending",
    createdAt: now,
    updatedAt: now,
    dependencies: input.dependencies ?? [],
    ...(input.phaseId !== undefined ? { phaseId: input.phaseId } : {}),
    ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
    ...(input.verifyHint !== undefined ? { verifyHint: input.verifyHint } : {}),
  }
  return { ok: true, item }
}

// ── createPlan ───────────────────────────────────────────────────────────

export const createPlan = (args: CreatePlanArgs, now: number, idGen: () => string): PlanResult => {
  if (args.todos.length === 0 && (args.phases?.length ?? 0) === 0) {
    return err({ kind: "empty_plan_create" })
  }
  if (args.todos.length > PLAN_LIMITS.MAX_TODOS) {
    return err({
      kind: "content_too_long",
      field: "content",
      max: PLAN_LIMITS.MAX_TODOS,
      actual: args.todos.length,
    })
  }
  if ((args.phases?.length ?? 0) > PLAN_LIMITS.MAX_PHASES) {
    return err({
      kind: "content_too_long",
      field: "content",
      max: PLAN_LIMITS.MAX_PHASES,
      actual: args.phases?.length ?? 0,
    })
  }
  const nameErr = checkLen("name", args.name, PLAN_LIMITS.MAX_NAME)
  if (nameErr !== null) return err(nameErr)
  const overErr = checkLen("overview", args.overview, PLAN_LIMITS.MAX_OVERVIEW)
  if (overErr !== null) return err(overErr)

  // Build phases first (with generated ids), then todos with phaseId binding.
  const phases: Phase[] = []
  const phaseIdByIndex: string[] = []
  for (let i = 0; i < (args.phases?.length ?? 0); i += 1) {
    const p = args.phases?.[i]
    if (p === undefined) continue
    const pid = idGen()
    phaseIdByIndex.push(pid)
    phases.push({ id: pid, name: p.name, todoIds: [], order: i })
  }

  // Build todos.
  const todos: Record<string, TodoItem> = {}
  const newIds: string[] = []
  for (let i = 0; i < args.todos.length; i += 1) {
    const ni = args.todos[i]
    if (ni === undefined) continue
    const id = idGen()
    if (todos[id] !== undefined) return err({ kind: "duplicate_id", id })
    const built = buildTodoItem(ni, id, now)
    if (!built.ok) return err(built.error)
    todos[id] = built.item
    newIds.push(id)
  }

  // Bind todos → phases via NewPhase.todoIndexes (or default: spread evenly into phase 0).
  const argPhases: readonly NewPhase[] = args.phases ?? []
  for (let pi = 0; pi < argPhases.length; pi += 1) {
    const p: NewPhase | undefined = argPhases[pi]
    const phase: Phase | undefined = phases[pi]
    if (p === undefined || phase === undefined) continue
    const indexes: readonly number[] = p.todoIndexes ?? []
    const todoIds: string[] = []
    for (const idx of indexes) {
      const tid: string | undefined = newIds[idx]
      if (tid === undefined) {
        return err({ kind: "todo_not_found", id: `index:${idx}` })
      }
      const todo: TodoItem | undefined = todos[tid]
      if (todo !== undefined) {
        todos[tid] = { ...todo, phaseId: phase.id }
      }
      todoIds.push(tid)
    }
    phases[pi] = { ...phase, todoIds }
  }

  // DAG validation.
  const dagOk = validateDag(todos)
  if (!dagOk.ok) return err(dagOk.error)

  const plan: Plan = {
    version: 0,
    name: args.name,
    overview: args.overview,
    isProject: args.isProject ?? false,
    todos,
    phases,
    createdAt: now,
    updatedAt: now,
  }
  return { ok: true, value: { kind: "created", plan } }
}

// ── addTodos ─────────────────────────────────────────────────────────────

export const addTodos = (
  plan: Plan,
  items: readonly NewTodo[],
  now: number,
  idGen: () => string,
): PlanResult => {
  if (items.length === 0) {
    return {
      ok: true,
      value: { kind: "noop", plan: { ...plan, version: plan.version + 1, updatedAt: now } },
    }
  }
  if (Object.keys(plan.todos).length + items.length > PLAN_LIMITS.MAX_TODOS) {
    return err({
      kind: "content_too_long",
      field: "content",
      max: PLAN_LIMITS.MAX_TODOS,
      actual: Object.keys(plan.todos).length + items.length,
    })
  }
  const newTodos: Record<string, TodoItem> = { ...plan.todos }
  const added: TodoItem[] = []
  for (const ni of items) {
    const id = idGen()
    if (newTodos[id] !== undefined) return err({ kind: "duplicate_id", id })
    if (ni.phaseId !== undefined && !plan.phases.some((p) => p.id === ni.phaseId)) {
      return err({ kind: "phase_not_found", id: ni.phaseId })
    }
    const built = buildTodoItem(ni, id, now)
    if (!built.ok) return err(built.error)
    newTodos[id] = built.item
    added.push(built.item)
  }
  const dagOk = validateDag(newTodos)
  if (!dagOk.ok) return err(dagOk.error)

  // T04 owning-seam: a new todo bound to a phase MUST appear in that phase's
  // todoIds atomically — callers no longer compose a follow-up membership write.
  const newPhases = syncPhaseMembership(plan.phases, newTodos)
  const newPlan: Plan = {
    ...plan,
    version: plan.version + 1,
    todos: newTodos,
    phases: newPhases,
    updatedAt: now,
  }
  return { ok: true, value: { kind: "todos_added", added, plan: newPlan } }
}

// ── updateTodos ──────────────────────────────────────────────────────────

const applyPatch = (
  existing: TodoItem,
  patch: TodoPatch,
  merge: boolean,
  now: number,
): { ok: true; item: TodoItem } | { ok: false; error: PlanMutationError } => {
  if (patch.content !== undefined) {
    const e = checkLen("content", patch.content, PLAN_LIMITS.MAX_TODO_CONTENT)
    if (e !== null) return { ok: false, error: e }
  }
  if (patch.verifyHint !== undefined && patch.verifyHint !== null) {
    const e = checkVerifyHint(patch.verifyHint)
    if (e !== null) return { ok: false, error: e }
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
      }
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
    }
  }

  // Merge vs replace: under merge=false, missing fields drop to default/clear.
  // We treat content/status/dependencies as REQUIRED-fields so merge=false keeps them; the difference
  // is on optional fields (phaseId, assignee, verifyHint) where null SENTINEL clears under either mode.
  const item: TodoItem = {
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
  }
  return { ok: true, item }
}

export const updateTodos = (
  plan: Plan,
  patches: readonly TodoPatch[],
  merge: boolean,
  now: number,
): PlanResult => {
  if (patches.length === 0) {
    return {
      ok: true,
      value: { kind: "noop", plan: { ...plan, version: plan.version + 1, updatedAt: now } },
    }
  }
  const dupId = dedupeIds(patches.map((p) => p.id))
  if (dupId !== null) return err({ kind: "duplicate_id", id: dupId })

  const newTodos: Record<string, TodoItem> = { ...plan.todos }
  const updated: TodoItem[] = []
  for (const patch of patches) {
    const existing = newTodos[patch.id]
    if (existing === undefined) return err({ kind: "todo_not_found", id: patch.id })
    if (
      patch.phaseId !== undefined &&
      patch.phaseId !== null &&
      !plan.phases.some((p) => p.id === patch.phaseId)
    ) {
      return err({ kind: "phase_not_found", id: patch.phaseId })
    }
    const built = applyPatch(existing, patch, merge, now)
    if (!built.ok) return err(built.error)
    newTodos[patch.id] = built.item
    updated.push(built.item)
  }

  const dagOk = validateDag(newTodos)
  if (!dagOk.ok) return err(dagOk.error)

  // T04 owning-seam: any patch that changed/cleared a todo's phaseId MUST move
  // it between phases atomically (no caller-side membership repair).
  const newPhases = syncPhaseMembership(plan.phases, newTodos)
  const newPlan: Plan = {
    ...plan,
    version: plan.version + 1,
    todos: newTodos,
    phases: newPhases,
    updatedAt: now,
  }
  return { ok: true, value: { kind: "todos_updated", updated, plan: newPlan } }
}

// ── removeTodos ──────────────────────────────────────────────────────────

export const removeTodos = (plan: Plan, ids: readonly string[], now: number): PlanResult => {
  if (ids.length === 0) {
    return {
      ok: true,
      value: { kind: "noop", plan: { ...plan, version: plan.version + 1, updatedAt: now } },
    }
  }
  const dupId = dedupeIds(ids)
  if (dupId !== null) return err({ kind: "duplicate_id", id: dupId })

  const newTodos: Record<string, TodoItem> = { ...plan.todos }
  const removed: string[] = []
  for (const id of ids) {
    if (newTodos[id] === undefined) return err({ kind: "todo_not_found", id })
    delete newTodos[id]
    removed.push(id)
  }

  // Post-removal DAG check: any todo still in plan referencing a removed id → dangling.
  const dagOk = validateDag(newTodos)
  if (!dagOk.ok) return err(dagOk.error)

  // Phase todoIds: strip removed ids from each phase.
  const newPhases = plan.phases.map((p) => ({
    ...p,
    todoIds: p.todoIds.filter((id) => !removed.includes(id)),
  }))

  const newPlan: Plan = {
    ...plan,
    version: plan.version + 1,
    todos: newTodos,
    phases: newPhases,
    updatedAt: now,
  }
  return { ok: true, value: { kind: "todos_removed", removedIds: removed, plan: newPlan } }
}

// ── reorderPhases ────────────────────────────────────────────────────────

export const reorderPhases = (plan: Plan, phaseIds: readonly string[], now: number): PlanResult => {
  if (plan.phases.length === 0 && phaseIds.length === 0) {
    return {
      ok: true,
      value: { kind: "noop", plan: { ...plan, version: plan.version + 1, updatedAt: now } },
    }
  }
  const dupId = dedupeIds(phaseIds)
  if (dupId !== null) return err({ kind: "duplicate_id", id: dupId })
  if (phaseIds.length !== plan.phases.length) {
    // Must reorder full set (partial reorder ambiguous); treat as not_found if any id missing.
    for (const id of phaseIds) {
      if (!plan.phases.some((p) => p.id === id)) return err({ kind: "phase_not_found", id })
    }
    // Or unknown phase if length mismatch with extras.
    if (phaseIds.length > plan.phases.length) {
      const extra = phaseIds.find((id) => !plan.phases.some((p) => p.id === id))
      if (extra !== undefined) return err({ kind: "phase_not_found", id: extra })
    }
    // Length less than current → missing required ids.
    const missing = plan.phases.find((p) => !phaseIds.includes(p.id))
    if (missing !== undefined) return err({ kind: "phase_not_found", id: missing.id })
  }
  // All ids match — reorder by index in phaseIds.
  const byId = new Map(plan.phases.map((p) => [p.id, p]))
  const newPhases: Phase[] = []
  for (let i = 0; i < phaseIds.length; i += 1) {
    const id = phaseIds[i]
    if (id === undefined) continue
    const p = byId.get(id)
    if (p === undefined) return err({ kind: "phase_not_found", id })
    newPhases.push({ ...p, order: i })
  }
  const newPlan: Plan = { ...plan, version: plan.version + 1, phases: newPhases, updatedAt: now }
  return { ok: true, value: { kind: "phases_reordered", plan: newPlan } }
}

// ── updateMeta ───────────────────────────────────────────────────────────

export const updateMeta = (
  plan: Plan,
  args: { name?: string; overview?: string; isProject?: boolean },
  now: number,
): PlanResult => {
  if (args.name !== undefined) {
    const e = checkLen("name", args.name, PLAN_LIMITS.MAX_NAME)
    if (e !== null) return err(e)
  }
  if (args.overview !== undefined) {
    const e = checkLen("overview", args.overview, PLAN_LIMITS.MAX_OVERVIEW)
    if (e !== null) return err(e)
  }
  const newPlan: Plan = {
    ...plan,
    version: plan.version + 1,
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.overview !== undefined ? { overview: args.overview } : {}),
    ...(args.isProject !== undefined ? { isProject: args.isProject } : {}),
    updatedAt: now,
  }
  // No structural change → noop kind (version still bumped per noop semantics).
  return { ok: true, value: { kind: "noop", plan: newPlan } }
}

// ── moveTodo (T04 atomic phase-membership owner) ──────────────────────────

/**
 * Atomically rebind ONE todo to a phase (or unbind it when `toPhaseId` is
 * `null`). The store-level owner of `todo.phaseId` ↔ `phase.todoIds`: callers
 * no longer compose an `updateTodos({phaseId})` followed by a phase-membership
 * repair. Both sides move in a single version bump or neither does.
 *
 * Validation order: todo existence → target-phase existence (when non-null).
 * On any error NO mutation is applied (the input plan is returned to the
 * caller unchanged via the error result; store.ts keeps the prior plan).
 */
export const moveTodo = (
  plan: Plan,
  todoId: string,
  toPhaseId: string | null,
  now: number,
): PlanResult => {
  const existing = plan.todos[todoId]
  if (existing === undefined) return err({ kind: "todo_not_found", id: todoId })
  if (toPhaseId !== null && !plan.phases.some((p) => p.id === toPhaseId)) {
    return err({ kind: "phase_not_found", id: toPhaseId })
  }
  const moved: TodoItem = {
    ...existing,
    updatedAt: now,
    ...(toPhaseId !== null ? { phaseId: toPhaseId } : {}),
  }
  // exactOptionalPropertyTypes: when unbinding, the spread above omitted
  // phaseId from the literal but `...existing` carried it — drop explicitly.
  if (toPhaseId === null && moved.phaseId !== undefined) {
    const { phaseId: _drop, ...rest } = moved
    return finishMove(plan, todoId, rest, now)
  }
  return finishMove(plan, todoId, moved, now)
}

/** Shared tail of {@link moveTodo}: install the moved todo, re-derive phase
 *  membership, bump version. Pure. */
const finishMove = (plan: Plan, todoId: string, moved: TodoItem, now: number): PlanResult => {
  const newTodos: Record<string, TodoItem> = { ...plan.todos, [todoId]: moved }
  const newPhases = syncPhaseMembership(plan.phases, newTodos)
  const newPlan: Plan = {
    ...plan,
    version: plan.version + 1,
    todos: newTodos,
    phases: newPhases,
    updatedAt: now,
  }
  return { ok: true, value: { kind: "todos_updated", updated: [moved], plan: newPlan } }
}

// ── updateMetaAndReorder (T04 atomic meta+order owner) ────────────────────

/**
 * Apply a meta change AND an optional phase reorder as ONE atomic store
 * mutation with a SINGLE version bump.
 *
 * Replaces the prior caller-side composition (`updateMeta` then
 * `reorderPhases` — two store calls, two version bumps, partial-failure left
 * the meta landed while the order didn't). Here both validations run FIRST;
 * only if BOTH pass is a single new plan produced. Any failure returns an
 * error and applies NOTHING (all-or-nothing).
 *
 * `phaseOrder === undefined` ⇒ meta-only (equivalent to {@link updateMeta}).
 * Empty `args` + `phaseOrder` ⇒ reorder-only. Empty `args` + no order ⇒ a
 * version-bumping no-op (mirrors the existing reducers' noop semantics).
 */
export const updateMetaAndReorder = (
  plan: Plan,
  args: { name?: string; overview?: string; isProject?: boolean },
  phaseOrder: readonly string[] | undefined,
  now: number,
): PlanResult => {
  // 1. Validate meta bounds (no mutation yet).
  if (args.name !== undefined) {
    const e = checkLen("name", args.name, PLAN_LIMITS.MAX_NAME)
    if (e !== null) return err(e)
  }
  if (args.overview !== undefined) {
    const e = checkLen("overview", args.overview, PLAN_LIMITS.MAX_OVERVIEW)
    if (e !== null) return err(e)
  }

  // 2. Compute reordered phases (validated) WITHOUT bumping version — reuse the
  //    reorderPhases reducer purely for its validation + ordering, then graft
  //    the result onto the meta change as a single bump.
  let phases = plan.phases
  if (phaseOrder !== undefined) {
    const reordered = reorderPhases(plan, phaseOrder, now)
    if (!reordered.ok) return reordered
    phases = reordered.value.plan.phases
  }

  // 3. Single atomic plan: meta fields + (possibly) reordered phases, ONE bump.
  const newPlan: Plan = {
    ...plan,
    version: plan.version + 1,
    phases,
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.overview !== undefined ? { overview: args.overview } : {}),
    ...(args.isProject !== undefined ? { isProject: args.isProject } : {}),
    updatedAt: now,
  }
  // Delta kind: a reorder happened ⇒ "phases_reordered"; otherwise meta-only ⇒
  // "noop" (no structural list change), matching updateMeta's classification.
  const kind: PlanDelta["kind"] = phaseOrder !== undefined ? "phases_reordered" : "noop"
  return { ok: true, value: { kind, plan: newPlan } }
}

// Helper for transitions module re-export (avoid extra import in tests).
export type { TodoStatus }
