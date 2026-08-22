/**
 * Plan snapshot serialization (ADR-0095 draft).
 *
 * Round-trip identity: `fromSnapshot(toSnapshot(p))` returns a plan
 * structurally equal to `p`. Schema-versioned (`"plan-v1"`) so future
 * additive fields can be migrated forward without breaking existing
 * snapshots. Defensive parse rejects 10 corruption classes with typed errors.
 */

import { validateDag } from "./dag"
import {
  type Phase,
  PLAN_LIMITS,
  type Plan,
  type PlanMutationError,
  type PlanResult,
  type TodoItem,
  type TodoStatus,
} from "./types"

export interface PlanSnapshot {
  readonly schema: "plan-v1"
  readonly plan: Plan
}

export const PLAN_SNAPSHOT_SCHEMA = "plan-v1" as const

/** Frozen-deep clone for snapshot output (immutability guarantee). */
const freezePlan = (p: Plan): Plan => {
  const todos: Record<string, TodoItem> = {}
  for (const id of Object.keys(p.todos)) {
    const t = p.todos[id]
    if (t === undefined) continue
    todos[id] = Object.freeze({ ...t, dependencies: Object.freeze([...t.dependencies]) })
  }
  return Object.freeze({
    ...p,
    todos: Object.freeze(todos),
    phases: Object.freeze(
      p.phases.map((ph) => Object.freeze({ ...ph, todoIds: Object.freeze([...ph.todoIds]) })),
    ),
  })
}

export const toSnapshot = (plan: Plan): PlanSnapshot =>
  Object.freeze({ schema: PLAN_SNAPSHOT_SCHEMA, plan: freezePlan(plan) })

// ── defensive parse ─────────────────────────────────────────────────────

/** Snapshot-specific parse errors. Map onto {@link PlanMutationError} where
 *  the kind overlaps (`dependency_unknown`, `duplicate_id`); otherwise emit
 *  a `content_too_long`-style stub via a synthetic field. */
export type PlanSnapshotParseError =
  | PlanMutationError
  | {
      readonly kind: "schema_mismatch"
      readonly expected: string
      readonly actual: string
    }
  | {
      /** Corruption class 10: a `todo.phaseId` references a phase whose
       *  `todoIds` does NOT contain that todo id, OR a todo id is claimed by
       *  two phases. The bidirectional invariant `todo.phaseId ↔ phase.todoIds`
       *  (enforced atomically by every mutation reducer via
       *  `syncPhaseMembership`) is broken. Distinct from `phase_not_found`,
       *  which fires when the referenced phase does not exist at all. */
      readonly kind: "phase_membership_asymmetry"
      /** The todo whose phase membership is inconsistent. */
      readonly todoId: string
      /** The phase the todo claims via `todo.phaseId`. */
      readonly phaseId: string
      /** Disambiguates the two asymmetry shapes:
       *   - `missing_in_phase`: `phase.todoIds` omits this todo id.
       *   - `claimed_by_two_phases`: id appears in another phase's `todoIds`. */
      readonly detail: "missing_in_phase" | "claimed_by_two_phases"
    }

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x)
const isStr = (x: unknown): x is string => typeof x === "string"
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x)
const isBool = (x: unknown): x is boolean => typeof x === "boolean"

const VALID_STATUSES: readonly TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
  "blocked",
]
const isStatus = (x: unknown): x is TodoStatus =>
  isStr(x) && VALID_STATUSES.includes(x as TodoStatus)

/** The failure arm of {@link PlanResult}, shared by every parse step so a step
 *  can hand its rejection straight back to {@link fromSnapshot}. */
type PlanParseFailure = { readonly ok: false; readonly error: PlanMutationError }

/** Responsibility: corruption class 1 — unwrap the snapshot ENVELOPE. Confirms
 *  the value is an object carrying the expected `schema` and a `plan` object,
 *  and yields the raw plan record for the field parsers. */
const parseSnapshotEnvelope = (raw: unknown): PlanResult<Record<string, unknown>> => {
  if (!isObj(raw)) {
    return {
      ok: false,
      error: {
        kind: "schema_mismatch",
        expected: PLAN_SNAPSHOT_SCHEMA,
        actual: "(non-object)",
      } as PlanSnapshotParseError as PlanMutationError,
    }
  }
  if (raw.schema !== PLAN_SNAPSHOT_SCHEMA) {
    return {
      ok: false,
      error: {
        kind: "schema_mismatch",
        expected: PLAN_SNAPSHOT_SCHEMA,
        actual: String(raw.schema),
      } as PlanSnapshotParseError as PlanMutationError,
    }
  }
  if (!isObj(raw.plan)) {
    return {
      ok: false,
      error: {
        kind: "schema_mismatch",
        expected: "plan-object",
        actual: typeof raw.plan,
      } as PlanSnapshotParseError as PlanMutationError,
    }
  }
  return { ok: true, value: raw.plan as Record<string, unknown> }
}

/** The Plan's non-collection fields, narrowed once so the assembly step can
 *  read them without re-testing. */
type PlanScalars = {
  readonly name: string
  readonly overview: string
  readonly isProject: boolean
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** Responsibility: corruption classes 2 + 4 for the PLAN-level scalar fields —
 *  the required strings/boolean, a finite non-negative `version`, and the two
 *  numeric timestamps. */
const parsePlanScalars = (p: Record<string, unknown>): PlanResult<PlanScalars> => {
  if (!isStr(p.name) || !isStr(p.overview) || !isBool(p.isProject)) {
    return {
      ok: false,
      error: { kind: "content_too_long", field: "name", max: PLAN_LIMITS.MAX_NAME, actual: 0 },
    }
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
    }
  }
  if (!isNum(p.createdAt) || !isNum(p.updatedAt)) {
    return { ok: false, error: { kind: "content_too_long", field: "content", max: 0, actual: 0 } }
  }
  return {
    ok: true,
    value: {
      name: p.name,
      overview: p.overview,
      isProject: p.isProject,
      version: p.version,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    },
  }
}

/** Responsibility: corruption class 2 (identity half) — a todo entry must be an
 *  object whose `id` is a string agreeing with its record key. Split out so the
 *  duplicate-id check (class 7) can run in its ORIGINAL position: after identity
 *  but BEFORE the field/dependency parse. */
const parseTodoIdentity = (
  key: string,
  t: unknown,
): PlanResult<{ readonly id: string; readonly obj: Record<string, unknown> }> => {
  if (!isObj(t)) {
    return { ok: false, error: { kind: "todo_not_found", id: key } }
  }
  if (!isStr(t.id) || t.id !== key) {
    return { ok: false, error: { kind: "todo_not_found", id: key } }
  }
  return { ok: true, value: { id: t.id, obj: t } }
}

/** Responsibility: corruption classes 2 + 3 + 6 for ONE already-identified todo
 *  — required field types, a known status, monotonic timestamps, and a
 *  string-only dependency array. */
const parseTodoFields = (id: string, t: Record<string, unknown>): PlanResult<TodoItem> => {
  if (!isStr(t.content) || !isStatus(t.status) || !isNum(t.createdAt) || !isNum(t.updatedAt)) {
    return { ok: false, error: { kind: "todo_not_found", id } }
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
    }
  }
  if (!Array.isArray(t.dependencies)) {
    return { ok: false, error: { kind: "todo_not_found", id } }
  }
  const deps: string[] = []
  for (const dep of t.dependencies) {
    if (!isStr(dep)) {
      return { ok: false, error: { kind: "todo_not_found", id } }
    }
    deps.push(dep)
  }
  return {
    ok: true,
    value: {
      id,
      content: t.content,
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      dependencies: deps,
      ...(typeof t.phaseId === "string" ? { phaseId: t.phaseId } : {}),
      ...(typeof t.assignee === "string" ? { assignee: t.assignee } : {}),
      ...(typeof t.verifyHint === "string" ? { verifyHint: t.verifyHint } : {}),
    },
  }
}

/** Responsibility: parse the whole `todos` record — the container's own shape
 *  plus corruption class 7 (an id keyed twice), delegating each entry to
 *  {@link parseTodoIdentity} + {@link parseTodoFields}. Rejects on the FIRST bad entry. */
const parseSnapshotTodos = (rawTodos: unknown): PlanResult<Record<string, TodoItem>> => {
  if (!isObj(rawTodos)) {
    return { ok: false, error: { kind: "content_too_long", field: "content", max: 0, actual: 0 } }
  }
  const todos: Record<string, TodoItem> = {}
  const seenTodoIds = new Set<string>()
  for (const key of Object.keys(rawTodos)) {
    const identity = parseTodoIdentity(key, rawTodos[key])
    if (!identity.ok) return identity
    const { id, obj } = identity.value
    if (seenTodoIds.has(id)) {
      return { ok: false, error: { kind: "duplicate_id", id } }
    }
    seenTodoIds.add(id)
    const parsed = parseTodoFields(id, obj)
    if (!parsed.ok) return parsed
    todos[id] = parsed.value
  }
  return { ok: true, value: todos }
}

/** Responsibility: validate ONE phase's `todoIds` list — string-only entries
 *  that each name a parsed todo (corruption class 9). */
const parsePhaseTodoIds = (
  phaseId: string,
  rawTodoIds: unknown,
  todos: Record<string, TodoItem>,
): PlanResult<string[]> => {
  if (!Array.isArray(rawTodoIds)) {
    return { ok: false, error: { kind: "phase_not_found", id: phaseId } }
  }
  const todoIds: string[] = []
  for (const tid of rawTodoIds) {
    if (!isStr(tid)) {
      return { ok: false, error: { kind: "phase_not_found", id: phaseId } }
    }
    if (!(tid in todos)) {
      return { ok: false, error: { kind: "todo_not_found", id: tid } }
    }
    todoIds.push(tid)
  }
  return { ok: true, value: todoIds }
}

/** Responsibility: corruption classes 8 + 9 — parse the `phases` array,
 *  rejecting a duplicate phase id and any `phase.todoIds` entry that is not a
 *  string or does not name a parsed todo (the phase→todo direction of the
 *  bidirectional membership invariant). */
const parseSnapshotPhases = (
  rawPhases: unknown,
  todos: Record<string, TodoItem>,
): PlanResult<Phase[]> => {
  if (!Array.isArray(rawPhases)) {
    return { ok: false, error: { kind: "phase_not_found", id: "(non-array)" } }
  }
  const phases: Phase[] = []
  const seenPhaseIds = new Set<string>()
  for (const ph of rawPhases) {
    if (!isObj(ph) || !isStr(ph.id) || !isStr(ph.name) || !isNum(ph.order)) {
      return { ok: false, error: { kind: "phase_not_found", id: "(invalid)" } }
    }
    if (seenPhaseIds.has(ph.id)) {
      return { ok: false, error: { kind: "duplicate_id", id: ph.id } }
    }
    seenPhaseIds.add(ph.id)
    const todoIds = parsePhaseTodoIds(ph.id, ph.todoIds, todos)
    if (!todoIds.ok) return todoIds
    phases.push({ id: ph.id, name: ph.name, todoIds: todoIds.value, order: ph.order })
  }
  return { ok: true, value: phases }
}

/** Responsibility: corruption class 10(c) — build the todo-id → owning-phase
 *  index, rejecting a todo id claimed by TWO phases. */
const indexPhaseOwnership = (phases: readonly Phase[]): PlanResult<Map<string, string>> => {
  const ownerPhaseOf = new Map<string, string>()
  for (const ph of phases) {
    for (const tid of ph.todoIds) {
      const prior = ownerPhaseOf.get(tid)
      if (prior !== undefined && prior !== ph.id) {
        return {
          ok: false,
          error: {
            kind: "phase_membership_asymmetry",
            todoId: tid,
            phaseId: ph.id,
            detail: "claimed_by_two_phases",
          } as PlanSnapshotParseError as PlanMutationError,
        }
      }
      ownerPhaseOf.set(tid, ph.id)
    }
  }
  return { ok: true, value: ownerPhaseOf }
}

/**
 * Responsibility: corruption class 10 — the todo.phaseId → phase direction of
 * the bidirectional membership invariant. {@link parseSnapshotPhases} already
 * validated phase.todoIds → todos (class 9, the phase→todo direction). Phases
 * are now fully parsed, so we can assert the reverse direction that every
 * mutation reducer guarantees via `syncPhaseMembership`:
 *   (a) every set todo.phaseId is a parsed phase id (else `phase_not_found`);
 *   (b) that phase's todoIds contains the todo id (else asymmetry); and
 *   (c) no todo id appears in two phases' todoIds (else asymmetry).
 * FAIL-CLOSED: a violation is rejected, never silently dropped or re-derived
 * (re-deriving would hide the corruption from the caller).
 *
 * Returns undefined when the invariant holds.
 */
const checkPhaseMembership = (
  todos: Record<string, TodoItem>,
  phases: readonly Phase[],
): PlanParseFailure | undefined => {
  const phaseById = new Map<string, Phase>()
  for (const ph of phases) phaseById.set(ph.id, ph)
  const ownership = indexPhaseOwnership(phases)
  if (!ownership.ok) return ownership
  const ownerPhaseOf = ownership.value
  for (const id of Object.keys(todos)) {
    const todo = todos[id]
    if (todo === undefined || todo.phaseId === undefined) continue
    // (a) referenced phase must exist.
    if (!phaseById.has(todo.phaseId)) {
      return { ok: false, error: { kind: "phase_not_found", id: todo.phaseId } }
    }
    // (b) referenced phase must list this todo id.
    if (ownerPhaseOf.get(id) !== todo.phaseId) {
      return {
        ok: false,
        error: {
          kind: "phase_membership_asymmetry",
          todoId: id,
          phaseId: todo.phaseId,
          detail: "missing_in_phase",
        } as PlanSnapshotParseError as PlanMutationError,
      }
    }
  }
  return undefined
}

/**
 * Parse an unknown into a `Plan`. Rejects with the FIRST validation failure
 * encountered. The 10 covered corruption classes:
 *
 *    1. schema_mismatch    — `schema !== "plan-v1"` or absent.
 *    2. missing fields     — required Plan/Todo/Phase fields absent or wrong type.
 *    3. status_invalid     — TodoItem.status not in `VALID_STATUSES`.
 *    4. negative version   — `Plan.version < 0` or non-finite.
 *    5. dangling deps      — TodoItem.dependencies references an unknown id.
 *    6. non-monotonic ts   — createdAt > updatedAt for a TodoItem.
 *    7. duplicate todo id  — same id keyed twice (impossible in a Record but
 *                            checked via array deserialization path if any).
 *    8. duplicate phase id — two phases share `id`.
 *    9. phase ref unknown  — phase.todoIds[*] references an id not in todos.
 *   10. phase membership   — todo.phaseId → phases direction of the bidirectional
 *                            invariant: a `todo.phaseId` points at a phase that
 *                            does not exist (`phase_not_found`), or exists but
 *                            whose `todoIds` omits the todo, or the todo id is
 *                            claimed by two phases (`phase_membership_asymmetry`).
 *                            Class 9 covers only the phase→todo direction; this
 *                            closes the reverse direction that every mutation
 *                            reducer guarantees via `syncPhaseMembership`.
 */
export const fromSnapshot = (raw: unknown): PlanResult<Plan> => {
  const envelope = parseSnapshotEnvelope(raw)
  if (!envelope.ok) return envelope
  const p = envelope.value

  const scalars = parsePlanScalars(p)
  if (!scalars.ok) return scalars

  const parsedTodos = parseSnapshotTodos(p.todos)
  if (!parsedTodos.ok) return parsedTodos
  const todos = parsedTodos.value

  const parsedPhases = parseSnapshotPhases(p.phases, todos)
  if (!parsedPhases.ok) return parsedPhases
  const phases = parsedPhases.value

  const membershipFailure = checkPhaseMembership(todos, phases)
  if (membershipFailure !== undefined) return membershipFailure

  // DAG validation last (catches dangling + cycles).
  const dagOk = validateDag(todos)
  if (!dagOk.ok) return { ok: false, error: dagOk.error }

  const plan: Plan = {
    version: scalars.value.version,
    name: scalars.value.name,
    overview: scalars.value.overview,
    isProject: scalars.value.isProject,
    todos,
    phases,
    createdAt: scalars.value.createdAt,
    updatedAt: scalars.value.updatedAt,
  }
  return { ok: true, value: plan }
}
