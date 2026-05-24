/** ADR-0196 — duck-typed mirror of `McpTasksPort` (`@/mcp/tasks/port.ts`).
 *
 *  Lives in `@/tool` because the slice fence forbids `@/tool` from importing
 *  `@/mcp` (RFC §3.1 — biome enforces). The composition root in
 *  `src/apps/agent/` adapts the concrete `McpTasksPort` into this mirror at
 *  wire time. Any drift between the producer and this mirror is a TYPE error
 *  at the adapter site.
 *
 *  Adding a new method/state requires updating BOTH `@/mcp/tasks/port.ts`
 *  AND this declaration. */

/** Mirror of `TaskState`. */
export type TasksTaskState = "pending" | "in_progress" | "completed" | "failed" | "cancelled"

export interface TasksTaskInfo {
  readonly taskId: string
  readonly state: TasksTaskState
  readonly title?: string
  readonly progress?: number
}

export interface TasksListPage {
  readonly tasks: ReadonlyArray<TasksTaskInfo>
  readonly nextCursor?: string
}

export type TasksListOutcome =
  | { readonly ok: true; readonly page: TasksListPage }
  | { readonly ok: false; readonly failure: { readonly reason: "cursor-stale" } }

export type TasksTaskResult =
  | { readonly state: "completed"; readonly output: string }
  | { readonly state: "failed"; readonly error: string }
  | { readonly state: "cancelled" }
  | { readonly state: "not-ready" }

export type TasksCancelResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not-cancellable" | "not-found" }

export interface TasksHandle {
  list(cursor?: string): Promise<TasksListOutcome>
  getInfo(taskId: string): Promise<TasksTaskInfo | null>
  getResult(taskId: string): Promise<TasksTaskResult>
  cancel(taskId: string): Promise<TasksCancelResult>
}
