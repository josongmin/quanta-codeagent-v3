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

import type {
  PlanMutationResult,
  PlanMutator,
  PlanDeltaKind as ToolPlanDeltaKind,
  PlanMutationErrorCode as ToolPlanMutationErrorCode,
} from "@/tool"
import { planErrorMessage } from "@/tool"
import type { PlanStore } from "./state"
import { projectPlanTasks } from "./task-projection"
import type {
  CreatePlanArgs,
  NewTodo,
  PlanDelta,
  PlanMutationError,
  PlanResult,
  TodoPatch,
  TodoStatus,
} from "./types"

const deltaKind = (k: PlanDelta["kind"]): ToolPlanDeltaKind => {
  switch (k) {
    case "created":
    case "todos_added":
    case "todos_updated":
    case "todos_removed":
    case "phases_reordered":
    case "noop":
      return k
    default: {
      const _e: never = k
      return _e
    }
  }
}

const errorCode = (e: PlanMutationError["kind"]): ToolPlanMutationErrorCode => {
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
      return e
    default: {
      const _e: never = e
      return _e
    }
  }
}

const ok = (delta: PlanDelta): PlanMutationResult => {
  const touchedIds: readonly string[] =
    delta.kind === "todos_added"
      ? delta.added.map((t) => t.id)
      : delta.kind === "todos_updated"
        ? delta.updated.map((t) => t.id)
        : delta.kind === "todos_removed"
          ? delta.removedIds
          : delta.kind === "created"
            ? Object.keys(delta.plan.todos)
            : []
  return {
    ok: true,
    version: delta.plan.version,
    deltaKind: deltaKind(delta.kind),
    touchedIds,
  }
}

const fail = (e: PlanMutationError): PlanMutationResult => {
  const code = errorCode(e.kind)
  return { ok: false, reason: planErrorMessage(code), code }
}

const adapt = (r: PlanResult<PlanDelta>): PlanMutationResult => (r.ok ? ok(r.value) : fail(r.error))

/** Coerce a free-form `string` (zod-validated upstream) into a `TodoStatus`
 *  or fall back to undefined so the reducer uses its default. Closed list
 *  of 5 values; anything else returns undefined and the reducer's default
 *  (`pending`) applies. No heuristic — exact membership match only. */
const coerceStatus = (s: string | undefined): TodoStatus | undefined => {
  if (
    s === "pending" ||
    s === "in_progress" ||
    s === "completed" ||
    s === "cancelled" ||
    s === "blocked"
  )
    return s
  return undefined
}

const coerceNewTodo = (ni: Parameters<PlanMutator["addTodos"]>[0][number]): NewTodo => ({
  content: ni.content,
  ...(coerceStatus(ni.status) !== undefined
    ? { status: coerceStatus(ni.status) as TodoStatus }
    : {}),
  ...(ni.dependencies !== undefined ? { dependencies: ni.dependencies } : {}),
  ...(ni.phaseId !== undefined ? { phaseId: ni.phaseId } : {}),
  ...(ni.assignee !== undefined ? { assignee: ni.assignee } : {}),
  ...(ni.verifyHint !== undefined ? { verifyHint: ni.verifyHint } : {}),
})

const coerceTodoPatch = (p: Parameters<PlanMutator["updateTodos"]>[0][number]): TodoPatch => ({
  id: p.id,
  ...(p.content !== undefined ? { content: p.content } : {}),
  ...(coerceStatus(p.status) !== undefined ? { status: coerceStatus(p.status) as TodoStatus } : {}),
  ...(p.dependencies !== undefined ? { dependencies: p.dependencies } : {}),
  ...(p.phaseId !== undefined ? { phaseId: p.phaseId } : {}),
  ...(p.assignee !== undefined ? { assignee: p.assignee } : {}),
  ...(p.verifyHint !== undefined ? { verifyHint: p.verifyHint } : {}),
})

/**
 * Build a `PlanMutator` (consumer-side, duck-typed) from a canonical
 * `PlanStore` (producer-side). Pure factory — the returned mutator captures
 * the store reference; subsequent `store.create(...)` / `addTodos(...)` etc.
 * flow through unchanged.
 */
export const planStoreToMutator = (store: PlanStore): PlanMutator => ({
  create: (args) => {
    const a: CreatePlanArgs = {
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
    }
    return adapt(store.create(a))
  },
  addTodos: (items, expectedVersion) =>
    adapt(store.addTodos(items.map(coerceNewTodo), expectedVersion)),
  updateTodos: (patches, merge, expectedVersion) =>
    adapt(store.updateTodos(patches.map(coerceTodoPatch), merge, expectedVersion)),
  removeTodos: (ids, expectedVersion) => adapt(store.removeTodos(ids, expectedVersion)),
  updateMeta: (args, expectedVersion) => {
    // T04: meta change + optional phase reorder are ONE atomic store mutation
    // (single version bump, all-or-nothing). The store owns the composition —
    // the adapter no longer chains `updateMeta` then `reorderPhases` (two bumps
    // where a failing reorder left the meta landed). `phaseOrder === undefined`
    // ⇒ meta-only; empty meta + order ⇒ reorder-only; empty + none ⇒ noop bump.
    const metaArgs = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.overview !== undefined ? { overview: args.overview } : {}),
      ...(args.isProject !== undefined ? { isProject: args.isProject } : {}),
    }
    return adapt(store.updateMetaAndReorder(metaArgs, args.phaseOrder, expectedVersion))
  },
  current: () => {
    const p = store.current()
    if (p === null) return null
    return {
      version: p.version,
      name: p.name,
      overview: p.overview,
      isProject: p.isProject,
      todoCount: Object.keys(p.todos).length,
      phaseCount: p.phases.length,
      // RFC07-3 read projection: owner/blockedBy/blocks derived by value from
      // the canonical plan. No stored reverse edge, no second owner field.
      tasks: projectPlanTasks(p).map((t) => ({
        id: t.id,
        // RFC12-1 — title + status carried through so the graph render
        // (plan-to-mermaid) can label + class each node.
        title: t.title,
        status: t.status,
        ...(t.owner !== undefined ? { owner: t.owner } : {}),
        blockedBy: t.blockedBy,
        blocks: t.blocks,
      })),
    }
  },
})
