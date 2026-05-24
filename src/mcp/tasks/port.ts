/** ADR-0196 — closed-port for MCP `tasks/*` JSON-RPC methods.
 *
 *  Four methods mapping 1:1 to rmcp 0.15:
 *    `list`      → `tasks/list`      (cursor-paginated)
 *    `getInfo`   → `tasks/getInfo`   (id → status)
 *    `getResult` → `tasks/getResult` (id → result | not-ready)
 *    `cancel`    → `tasks/cancel`    (id → ok | reason)
 *
 *  The port never throws on a typed MCP failure (stale cursor, not-found,
 *  not-cancellable) — those return the typed outcome. Transport errors
 *  (process exited, RPC timeout) DO throw — same contract as `McpClient`. */

import type { McpTaskInfo, TaskCancelResult, TaskListOutcome, TaskResult } from "./types"

export interface McpTasksPort {
  /** `tasks/list` — paginated. `cursor` is the opaque resume token; absent
   *  on the first call. The outcome is `ok:false {cursor-stale}` when the
   *  server resets the listing window mid-iteration. */
  list(cursor?: string): Promise<TaskListOutcome>
  /** `tasks/getInfo` — id → status. Returns `null` when the server reports
   *  the id is unknown (server-side eviction). */
  getInfo(taskId: string): Promise<McpTaskInfo | null>
  /** `tasks/getResult` — id → terminal payload. Returns `state: "not-ready"`
   *  when the task is still `pending`/`in_progress`. */
  getResult(taskId: string): Promise<TaskResult>
  /** `tasks/cancel` — id → typed outcome. Idempotent on terminal
   *  `cancelled` (returns `{ok:true}`). */
  cancel(taskId: string): Promise<TaskCancelResult>
}
