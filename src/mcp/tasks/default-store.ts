/** ADR-0196 — in-memory MCP tasks store + port adapter.
 *
 *  Backs the `McpTasksPort` for clients that lack a real server-side tasks
 *  endpoint (test harnesses + tools that synthesize task ids client-side).
 *  FIFO eviction at `MAX_TASKS` so a runaway server cannot blow memory. */

import type { McpTasksPort } from "./port"
import type { McpTaskInfo, TaskCancelResult, TaskListOutcome, TaskResult } from "./types"

const MAX_TASKS = 256

interface StoreEntry {
  info: McpTaskInfo
  result?: TaskResult
}

/** Storage primitives — separated from the port adapter so a test can pre-seed
 *  state and the adapter is a thin projection. */
export class DefaultTaskStore {
  private readonly entries = new Map<string, StoreEntry>()

  /** Insert or replace a task. FIFO eviction kicks when the map exceeds
   *  `MAX_TASKS` — the oldest insertion is dropped. */
  upsert(info: McpTaskInfo, result?: TaskResult): void {
    if (this.entries.has(info.taskId)) {
      const existing = this.entries.get(info.taskId) as StoreEntry
      existing.info = info
      if (result !== undefined) existing.result = result
      return
    }
    const entry: StoreEntry = result === undefined ? { info } : { info, result }
    this.entries.set(info.taskId, entry)
    if (this.entries.size > MAX_TASKS) {
      const firstKey = this.entries.keys().next().value
      if (typeof firstKey === "string") this.entries.delete(firstKey)
    }
  }

  /** Mark a task as cancelled. No-op when terminal. */
  cancel(taskId: string): TaskCancelResult {
    const entry = this.entries.get(taskId)
    if (entry === undefined) return { ok: false, reason: "not-found" }
    const state = entry.info.state
    if (state === "completed" || state === "failed") {
      return { ok: false, reason: "not-cancellable" }
    }
    if (state === "cancelled") return { ok: true } // idempotent
    entry.info = { ...entry.info, state: "cancelled" }
    entry.result = { state: "cancelled" }
    return { ok: true }
  }

  list(): ReadonlyArray<McpTaskInfo> {
    return [...this.entries.values()].map((e) => e.info)
  }

  size(): number {
    return this.entries.size
  }

  get(taskId: string): StoreEntry | undefined {
    return this.entries.get(taskId)
  }
}

/** Pagination size for the in-memory adapter. */
const PAGE_SIZE = 50

/** Adapt a `DefaultTaskStore` to the port. Cursor is the index of the next
 *  entry; stale cursors (out of range after eviction) surface as
 *  `cursor-stale` instead of throwing. */
export const defaultTasksPort = (store: DefaultTaskStore): McpTasksPort => ({
  async list(cursor?: string): Promise<TaskListOutcome> {
    const all = store.list()
    const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10)
    if (Number.isNaN(start) || start < 0 || start > all.length) {
      return { ok: false, failure: { reason: "cursor-stale" } }
    }
    const slice = all.slice(start, start + PAGE_SIZE)
    const next = start + PAGE_SIZE
    return {
      ok: true,
      page: next < all.length ? { tasks: slice, nextCursor: String(next) } : { tasks: slice },
    }
  },
  async getInfo(taskId: string): Promise<McpTaskInfo | null> {
    return store.get(taskId)?.info ?? null
  },
  async getResult(taskId: string): Promise<TaskResult> {
    const entry = store.get(taskId)
    if (entry === undefined) return { state: "not-ready" }
    if (entry.result !== undefined) return entry.result
    const state = entry.info.state
    if (state === "pending" || state === "in_progress") return { state: "not-ready" }
    if (state === "cancelled") return { state: "cancelled" }
    if (state === "failed") return { state: "failed", error: "(no error message)" }
    return { state: "completed", output: "" }
  },
  async cancel(taskId: string): Promise<TaskCancelResult> {
    return store.cancel(taskId)
  },
})
