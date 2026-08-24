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

/** Every PLAN_LIMITS bound `createPlan` enforces BEFORE it builds anything, in the fixed order
 *  emptiness → todo count → phase count → name → overview. Returns the FIRST violation or `null`. */
const createPlanBoundsError = (args: CreatePlanArgs): PlanMutationError | null => {
  const phaseCount = args.phases?.length ?? 0
  if (args.todos.length === 0 && phaseCount === 0) return { kind: "empty_plan_create" }
  if (args.todos.length > PLAN_LIMITS.MAX_TODOS) {
    return {
      kind: "content_too_long",
      field: "content",
      max: PLAN_LIMITS.MAX_TODOS,
      actual: args.todos.length,
    }
  }
  if (phaseCount > PLAN_LIMITS.MAX_PHASES) {
    return {
      kind: "content_too_long",
      field: "content",
      max: PLAN_LIMITS.MAX_PHASES,
      actual: phaseCount,
    }
  }
  return (
    checkLen("name", args.name, PLAN_LIMITS.MAX_NAME) ??
    checkLen("overview", args.overview, PLAN_LIMITS.MAX_OVERVIEW)
  )
}

/** Materialise the phase records with generated ids, in input order. `todoIds` is filled later by
 *  {@link bindOnePhase} — membership is derived from the todo side, never invented here. */
const buildPhases = (newPhases: readonly NewPhase[] | undefined, idGen: () => string): Phase[] => {
  const phases: Phase[] = []
  for (let i = 0; i < (newPhases?.length ?? 0); i += 1) {
    const p = newPhases?.[i]
    if (p === undefined) continue
    phases.push({ id: idGen(), name: p.name, todoIds: [], order: i })
  }
  return phases
}

type BuiltTodos =
  | { ok: true; todos: Record<string, TodoItem>; newIds: string[] }
  | { ok: false; error: PlanMutationError }

/** Materialise the todo records with generated ids. `newIds` is the INDEX-ALIGNED id list the
 *  phase binding below resolves `todoIndexes` against. A colliding `idGen` ⇒ `duplicate_id`. */
const buildTodos = (
  inputs: readonly NewTodo[],
  now: number,
  idGen: () => string,
): BuiltTodos => {
  const todos: Record<string, TodoItem> = {}
  const newIds: string[] = []
  for (let i = 0; i < inputs.length; i += 1) {
    const ni = inputs[i]
    if (ni === undefined) continue
    const id = idGen()
    if (todos[id] !== undefined) return { ok: false, error: { kind: "duplicate_id", id } }
    const built = buildTodoItem(ni, id, now)
    if (!built.ok) return { ok: false, error: built.error }
    todos[id] = built.item
    newIds.push(id)
  }
  return { ok: true, todos, newIds }
}

/** Resolve ONE phase's `todoIndexes` into todo ids, stamping `phaseId` onto each bound todo.
 *  MUTATES `todos` in place. An index with no corresponding todo ⇒ `todo_not_found index:N`. */
const bindOnePhase = (
  phaseId: string,
  indexes: readonly number[],
  todos: Record<string, TodoItem>,
  newIds: readonly string[],
): { ok: true; todoIds: string[] } | { ok: false; error: PlanMutationError } => {
  const todoIds: string[] = []
  for (const idx of indexes) {
    const tid: string | undefined = newIds[idx]
    if (tid === undefined) {
      return { ok: false, error: { kind: "todo_not_found", id: `index:${idx}` } }
    }
    const todo: TodoItem | undefined = todos[tid]
    if (todo !== undefined) todos[tid] = { ...todo, phaseId }
    todoIds.push(tid)
  }
  return { ok: true, todoIds }
}

/** Bind todos → phases via `NewPhase.todoIndexes`. MUTATES both `phases` (rewriting each entry's
 *  `todoIds`) and `todos` (stamping `phaseId`). Returns the first binding error, or `null`. */
const bindTodosToPhases = (
  phases: Phase[],
  argPhases: readonly NewPhase[],
  todos: Record<string, TodoItem>,
  newIds: readonly string[],
): PlanMutationError | null => {
  for (let pi = 0; pi < argPhases.length; pi += 1) {
    const p: NewPhase | undefined = argPhases[pi]
    const phase: Phase | undefined = phases[pi]
    if (p === undefined || phase === undefined) continue
    const bound = bindOnePhase(phase.id, p.todoIndexes ?? [], todos, newIds)
    if (!bound.ok) return bound.error
    phases[pi] = { ...phase, todoIds: bound.todoIds }
  }
  return null
}

export const createPlan = (args: CreatePlanArgs, now: number, idGen: () => string): PlanResult => {
  const bounds = createPlanBoundsError(args)
  if (bounds !== null) return err(bounds)

  // Build phases first (with generated ids), then todos with phaseId binding.
  const phases = buildPhases(args.phases, idGen)
  const built = buildTodos(args.todos, now, idGen)
  if (!built.ok) return err(built.error)
  const { todos, newIds } = built

  // Bind todos → phases via NewPhase.todoIndexes.
  const bindErr = bindTodosToPhases(phases, args.phases ?? [], todos, newIds)
  if (bindErr !== null) return err(bindErr)

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

/** The status gate: a patch that CHANGES status must name a transition the matrix in
 *  `transitions.ts` permits. Re-stating the SAME status is always allowed (a no-op edit). */
const patchStatusError = (existing: TodoItem, patch: TodoPatch): PlanMutationError | null => {
  if (patch.status === undefined || patch.status === existing.status) return null
  if (isValidTransition(existing.status, patch.status)) return null
  return {
    kind: "invalid_status_transition",
    from: existing.status,
    to: patch.status,
    id: existing.id,
  }
}

/** The dependency fan-out bound. */
const patchDepsError = (patch: TodoPatch): PlanMutationError | null => {
  const count = patch.dependencies?.length ?? 0
  if (count <= PLAN_LIMITS.MAX_DEPS_PER_TODO) return null
  return {
    kind: "content_too_long",
    field: "content",
    max: PLAN_LIMITS.MAX_DEPS_PER_TODO,
    actual: count,
  }
}

/** Every bound a patch must clear BEFORE anything is written, in the fixed order
 *  content → verifyHint → status → dependencies. First violation wins. */
const patchValidationError = (existing: TodoItem, patch: TodoPatch): PlanMutationError | null =>
  (patch.content !== undefined
    ? checkLen("content", patch.content, PLAN_LIMITS.MAX_TODO_CONTENT)
    : null) ??
  (patch.verifyHint !== undefined && patch.verifyHint !== null
    ? checkVerifyHint(patch.verifyHint)
    : null) ??
  patchStatusError(existing, patch) ??
  patchDepsError(patch)

/**
 * The ONE resolution rule for an OPTIONAL todo field under a patch — applied identically to
 * `phaseId`, `assignee` and `verifyHint` (the pre-split code spelled this same four-way ladder out
 * three times, once per field, which is where most of the branch count lived):
 *
 *   - `null`      ⇒ explicit CLEAR. The sentinel wins under BOTH merge and replace.
 *   - a value     ⇒ set it.
 *   - `undefined` ⇒ keep the existing value under `merge`, DROP it under replace.
 *
 * `undefined` out means "omit the key entirely" (exactOptionalPropertyTypes), never "set to
 * undefined".
 */
const resolveOptionalField = (
  patched: string | null | undefined,
  existing: string | undefined,
  merge: boolean,
): string | undefined => {
  if (patched === null) return undefined // explicit clear
  if (patched !== undefined) return patched
  return merge ? existing : undefined
}

const applyPatch = (
  existing: TodoItem,
  patch: TodoPatch,
  merge: boolean,
  now: number,
): { ok: true; item: TodoItem } | { ok: false; error: PlanMutationError } => {
  const invalid = patchValidationError(existing, patch)
  if (invalid !== null) return { ok: false, error: invalid }

  // Merge vs replace: the difference is ONLY on the optional fields (phaseId, assignee,
  // verifyHint), where a null SENTINEL clears under either mode — see resolveOptionalField.
  // content/status/dependencies are treated as REQUIRED, so merge=false keeps them too.
  const phaseId = resolveOptionalField(patch.phaseId, existing.phaseId, merge)
  const assignee = resolveOptionalField(patch.assignee, existing.assignee, merge)
  const verifyHint = resolveOptionalField(patch.verifyHint, existing.verifyHint, merge)
  const item: TodoItem = {
    id: existing.id,
    content: patch.content ?? existing.content,
    status: patch.status ?? existing.status,
    createdAt: existing.createdAt,
    updatedAt: now,
    dependencies: patch.dependencies ?? existing.dependencies,
    ...(phaseId !== undefined ? { phaseId } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(verifyHint !== undefined ? { verifyHint } : {}),
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

/** A reorder must name EVERY phase exactly once — a partial reorder is ambiguous. When the counts
 *  differ, name the offending phase id in a fixed priority: an UNKNOWN id first (scanning the
 *  request), then an EXTRA id (only possible when the request is longer), then a MISSING one.
 *  Matching counts ⇒ `null` (the per-index rebuild still re-checks each id). */
const phaseSetMismatchError = (
  plan: Plan,
  phaseIds: readonly string[],
): PlanMutationError | null => {
  if (phaseIds.length === plan.phases.length) return null
  for (const id of phaseIds) {
    if (!plan.phases.some((p) => p.id === id)) return { kind: "phase_not_found", id }
  }
  // Or unknown phase if length mismatch with extras.
  if (phaseIds.length > plan.phases.length) {
    const extra = phaseIds.find((id) => !plan.phases.some((p) => p.id === id))
    if (extra !== undefined) return { kind: "phase_not_found", id: extra }
  }
  // Length less than current → missing required ids.
  const missing = plan.phases.find((p) => !phaseIds.includes(p.id))
  if (missing !== undefined) return { kind: "phase_not_found", id: missing.id }
  return null
}

/** Rebuild the phase list in `phaseIds` order, re-stamping `order` to the new index. */
const reorderedPhases = (
  plan: Plan,
  phaseIds: readonly string[],
): { ok: true; phases: Phase[] } | { ok: false; error: PlanMutationError } => {
  const byId = new Map(plan.phases.map((p) => [p.id, p]))
  const newPhases: Phase[] = []
  for (let i = 0; i < phaseIds.length; i += 1) {
    const id = phaseIds[i]
    if (id === undefined) continue
    const p = byId.get(id)
    if (p === undefined) return { ok: false, error: { kind: "phase_not_found", id } }
    newPhases.push({ ...p, order: i })
  }
  return { ok: true, phases: newPhases }
}

export const reorderPhases = (plan: Plan, phaseIds: readonly string[], now: number): PlanResult => {
  if (plan.phases.length === 0 && phaseIds.length === 0) {
    return {
      ok: true,
      value: { kind: "noop", plan: { ...plan, version: plan.version + 1, updatedAt: now } },
    }
  }
  const dupId = dedupeIds(phaseIds)
  if (dupId !== null) return err({ kind: "duplicate_id", id: dupId })
  const mismatch = phaseSetMismatchError(plan, phaseIds)
  if (mismatch !== null) return err(mismatch)
  // All ids match — reorder by index in phaseIds.
  const rebuilt = reorderedPhases(plan, phaseIds)
  if (!rebuilt.ok) return err(rebuilt.error)
  const newPlan: Plan = {
    ...plan,
    version: plan.version + 1,
    phases: rebuilt.phases,
    updatedAt: now,
  }
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
