/** ADR-0431 — live `McpTasksPort` over an `McpClient`.
 *
 *  This is the wired sibling of `defaultTasksPort` (the in-memory store
 *  adapter): instead of projecting a local `DefaultTaskStore`, it dispatches
 *  the four `tasks/*` JSON-RPC requests through the live `McpClient` via
 *  `client.requestRaw(method, params)` — the outbound mirror of the inbound
 *  `routeElicitation` request path.
 *
 *  Method map (rmcp 0.15):
 *    `list`      → `tasks/list`      `{ cursor? }`  → `{ tasks, nextCursor? }`
 *    `getInfo`   → `tasks/getInfo`   `{ taskId }`   → `{ taskId, status, … }` | unknown
 *    `getResult` → `tasks/getResult` `{ taskId }`   → `{ status, result | error }`
 *    `cancel`    → `tasks/cancel`    `{ taskId }`   → `{ }` | error
 *
 *  Contract (matches `McpTasksPort`): a TRANSPORT error (process exit, RPC
 *  timeout) propagates — `requestRaw` rejects with `McpError` and we let it
 *  through (same as `tools/call`). A MALFORMED but successful response (the
 *  server returned something we can't parse) is mapped to the typed
 *  conservative outcome — `null` (getInfo), `not-ready` (getResult),
 *  `cursor-stale` (list), `not-found` (cancel) — so a buggy/hostile server
 *  cannot crash the model loop. */

import type { McpClient } from "../client"
import type { McpTasksPort } from "./port"
import type {
  McpTaskInfo,
  TaskCancelResult,
  TaskListOutcome,
  TaskListPage,
  TaskResult,
  TaskState,
} from "./types"

const VALID_STATES: ReadonlyArray<TaskState> = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
]

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

const asState = (v: unknown): TaskState | null =>
  typeof v === "string" && (VALID_STATES as ReadonlyArray<string>).includes(v)
    ? (v as TaskState)
    : null

/** Parse one raw task entry. The server may name the state field `state` or
 *  `status`; both are accepted. Returns `null` when the entry lacks a usable
 *  id or state (caller drops it). */
const parseInfo = (raw: unknown): McpTaskInfo | null => {
  const rec = asRecord(raw)
  if (rec === null) return null
  const taskId = asString(rec.taskId) ?? asString(rec.id)
  if (taskId === undefined || taskId.length === 0) return null
  const state = asState(rec.state) ?? asState(rec.status)
  if (state === null) return null
  const title = asString(rec.title)
  const progress = typeof rec.progress === "number" ? rec.progress : undefined
  return {
    taskId,
    state,
    ...(title !== undefined ? { title } : {}),
    ...(progress !== undefined ? { progress } : {}),
  }
}

const parseListPage = (raw: unknown): TaskListPage | null => {
  const rec = asRecord(raw)
  if (rec === null) return null
  if (!Array.isArray(rec.tasks)) return null
  const tasks: McpTaskInfo[] = []
  for (const entry of rec.tasks) {
    const info = parseInfo(entry)
    if (info !== null) tasks.push(info)
  }
  const nextCursor = asString(rec.nextCursor)
  return nextCursor !== undefined && nextCursor.length > 0 ? { tasks, nextCursor } : { tasks }
}

/** Map a raw `tasks/getResult` payload onto the typed {@link TaskResult}. A
 *  terminal state carries `output`/`error`; non-terminal or unparseable maps
 *  to `not-ready` (the model polls again — never a crash). */
const parseResult = (raw: unknown): TaskResult => {
  const rec = asRecord(raw)
  if (rec === null) return { state: "not-ready" }
  const state = asState(rec.state) ?? asState(rec.status)
  if (state === "completed") return { state: "completed", output: asString(rec.output) ?? "" }
  if (state === "failed") {
    return { state: "failed", error: asString(rec.error) ?? "(no error message)" }
  }
  if (state === "cancelled") return { state: "cancelled" }
  return { state: "not-ready" }
}

/** Build a live `McpTasksPort` bound to a started `McpClient` (ADR-0431). */
export const clientTasksPort = (client: McpClient): McpTasksPort => ({
  async list(cursor?: string): Promise<TaskListOutcome> {
    const params = cursor === undefined ? {} : { cursor }
    const raw = await client.requestRaw("tasks/list", params)
    const page = parseListPage(raw)
    // A malformed list (server returned garbage, or a stale-cursor error shape
    // we can't read) surfaces as the typed cursor-stale failure → the model
    // retries with no cursor rather than crashing.
    if (page === null) return { ok: false, failure: { reason: "cursor-stale" } }
    return { ok: true, page }
  },
  async getInfo(taskId: string): Promise<McpTaskInfo | null> {
    const raw = await client.requestRaw("tasks/getInfo", { taskId })
    // Servers may nest under `task` or return the record directly.
    const rec = asRecord(raw)
    return parseInfo(rec?.task ?? raw)
  },
  async getResult(taskId: string): Promise<TaskResult> {
    const raw = await client.requestRaw("tasks/getResult", { taskId })
    const rec = asRecord(raw)
    return parseResult(rec?.result ?? raw)
  },
  async cancel(taskId: string): Promise<TaskCancelResult> {
    const raw = await client.requestRaw("tasks/cancel", { taskId })
    const rec = asRecord(raw)
    if (rec === null) return { ok: false, reason: "not-found" }
    // An explicit `{ ok:false, reason }` is honored; anything else (the rmcp
    // happy path is an empty/echo result) is treated as a successful cancel.
    if (rec.ok === false) {
      const reason = asString(rec.reason)
      return {
        ok: false,
        reason: reason === "not-cancellable" ? "not-cancellable" : "not-found",
      }
    }
    return { ok: true }
  },
})
