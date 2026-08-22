/** ADR-0196 — MCP tasks/* protocol types.
 *
 *  The rmcp 0.15 task state is a CLOSED 5-arm union; a 6th arm would be an
 *  MCP spec change, not a quanta change. The union is mirrored to a const
 *  tuple at the bottom for grep + exhaustiveness checks. */

/** Lifecycle of a single rmcp 0.15 task. */
export type TaskState = "pending" | "in_progress" | "completed" | "failed" | "cancelled"

/** Terminal states — no further transitions possible. */
export const TERMINAL_TASK_STATES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies ReadonlyArray<TaskState>

/** A task as listed by `tasks/list` or fetched by `tasks/getInfo`. */
export interface McpTaskInfo {
  readonly taskId: string
  readonly state: TaskState
  /** Server-provided human label (optional — omitted, not undefined). */
  readonly title?: string
  /** Server-provided 0..1 progress ratio; omitted when unknown. */
  readonly progress?: number
  /** Server-advertised time-to-live in MILLISECONDS (unit in the name to kill
   *  the s-vs-ms bug class). When present, the poller stops after `ttlMs` of
   *  wall time and returns the LAST observed info (not null) so the model can
   *  read the final state + related ids. Omitted ⇒ no TTL (poll to terminal). */
  readonly ttlMs?: number
  /** Server-advertised poll cadence in MILLISECONDS — how often the model should
   *  re-probe this task. Overrides the caller/default cadence (floored + ceiled
   *  by the poller so a hostile value cannot busy-spin or stall). Omitted ⇒ the
   *  caller-supplied / default cadence applies. */
  readonly pollIntervalMs?: number
  /** Sibling task ids the model may want to poll/cancel together (an actionable
   *  affordance — e.g. a fan-out batch). Self-id is excluded by the codec
   *  (circular guard). Omitted (not `[]`) when the server advertises none. */
  readonly relatedTaskIds?: ReadonlyArray<string>
}

/** Paginated list response from `tasks/list`. `nextCursor` omitted when the
 *  server signals no further pages (terminal page). Stale cursors surface
 *  as the typed `cursor-stale` failure rather than an exception. */
export interface TaskListPage {
  readonly tasks: ReadonlyArray<McpTaskInfo>
  readonly nextCursor?: string
}

/** Result of `tasks/getResult` — typed payload for completed/failed tasks.
 *  `not-ready` is the not-yet-terminal case; the model retries via poller. */
export type TaskResult =
  | { readonly state: "completed"; readonly output: string }
  | { readonly state: "failed"; readonly error: string }
  | { readonly state: "cancelled" }
  | { readonly state: "not-ready" }

/** Result of `tasks/cancel`. `not-cancellable` covers terminal-state targets
 *  (already completed/failed/cancelled). Idempotent on terminal `cancelled`. */
export type TaskCancelResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not-cancellable" | "not-found" }

/** Typed `tasks/list` failure surface — the only non-Error path callers
 *  must branch on. Stale cursor surfaces here instead of throwing because
 *  the server resets the listing window without warning. */
export type TaskListFailure = { readonly reason: "cursor-stale" }

export type TaskListOutcome =
  | { readonly ok: true; readonly page: TaskListPage }
  | { readonly ok: false; readonly failure: TaskListFailure }
