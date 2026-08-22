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
  const p = raw.plan as Record<string, unknown>

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

  // Parse todos.
  if (!isObj(p.todos)) {
    return { ok: false, error: { kind: "content_too_long", field: "content", max: 0, actual: 0 } }
  }
  const todos: Record<string, TodoItem> = {}
  const seenTodoIds = new Set<string>()
  for (const key of Object.keys(p.todos)) {
    const t = (p.todos as Record<string, unknown>)[key]
    if (!isObj(t)) {
      return { ok: false, error: { kind: "todo_not_found", id: key } }
    }
    if (!isStr(t.id) || t.id !== key) {
      return { ok: false, error: { kind: "todo_not_found", id: key } }
    }
    if (seenTodoIds.has(t.id)) {
      return { ok: false, error: { kind: "duplicate_id", id: t.id } }
    }
    seenTodoIds.add(t.id)
    if (!isStr(t.content) || !isStatus(t.status) || !isNum(t.createdAt) || !isNum(t.updatedAt)) {
      return { ok: false, error: { kind: "todo_not_found", id: t.id } }
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
      return { ok: false, error: { kind: "todo_not_found", id: t.id } }
    }
    const deps: string[] = []
    for (const dep of t.dependencies) {
      if (!isStr(dep)) {
        return { ok: false, error: { kind: "todo_not_found", id: t.id } }
      }
      deps.push(dep)
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
    }
  }

  // Parse phases.
  if (!Array.isArray(p.phases)) {
    return { ok: false, error: { kind: "phase_not_found", id: "(non-array)" } }
  }
  const phases: Phase[] = []
  const seenPhaseIds = new Set<string>()
  for (const ph of p.phases) {
    if (!isObj(ph) || !isStr(ph.id) || !isStr(ph.name) || !isNum(ph.order)) {
      return { ok: false, error: { kind: "phase_not_found", id: "(invalid)" } }
    }
    if (seenPhaseIds.has(ph.id)) {
      return { ok: false, error: { kind: "duplicate_id", id: ph.id } }
    }
    seenPhaseIds.add(ph.id)
    if (!Array.isArray(ph.todoIds)) {
      return { ok: false, error: { kind: "phase_not_found", id: ph.id } }
    }
    const todoIds: string[] = []
    for (const tid of ph.todoIds) {
      if (!isStr(tid)) {
        return { ok: false, error: { kind: "phase_not_found", id: ph.id } }
      }
      if (!(tid in todos)) {
        return { ok: false, error: { kind: "todo_not_found", id: tid } }
      }
      todoIds.push(tid)
    }
    phases.push({ id: ph.id, name: ph.name, todoIds, order: ph.order })
  }

  // ── Cross-check the todo.phaseId → phase direction of the bidirectional
  // membership invariant (corruption class 10). The phase loop above already
  // validated phase.todoIds → todos (class 9, the phase→todo direction). Phases
  // are now fully parsed, so we can assert the reverse direction that every
  // mutation reducer guarantees via `syncPhaseMembership`:
  //   (a) every set todo.phaseId is a parsed phase id (else `phase_not_found`);
  //   (b) that phase's todoIds contains the todo id (else asymmetry); and
  //   (c) no todo id appears in two phases' todoIds (else asymmetry).
  // FAIL-CLOSED: a violation is rejected, never silently dropped or re-derived
  // (re-deriving would hide the corruption from the caller).
  const phaseById = new Map<string, Phase>()
  for (const ph of phases) phaseById.set(ph.id, ph)
  // (c) ownership: which phase claims each todo id (phase→todo direction, but
  // also detects a todo id listed in two phases).
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

  // DAG validation last (catches dangling + cycles).
  const dagOk = validateDag(todos)
  if (!dagOk.ok) return { ok: false, error: dagOk.error }

  const plan: Plan = {
    version: p.version,
    name: p.name,
    overview: p.overview,
    isProject: p.isProject,
    todos,
    phases,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
  return { ok: true, value: plan }
}
