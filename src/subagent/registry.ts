import type { SubagentResult } from "./types"

export type TaskStatus = "running" | "completed" | "failed" | "stopped"

export interface TaskRecord {
  id: string
  description: string
  agentType?: string
  status: TaskStatus
  /** Set once the task settles (completed/failed/stopped). */
  result?: SubagentResult
  /** Failure message when status === "failed". */
  error?: string
  startedAt: number
  endedAt?: number
}

/** Default cap on retained SETTLED records before LRU eviction kicks in.
 *  Running tasks are never evicted regardless of count — only settled ones are
 *  reclaimed, oldest `endedAt` first. 256 fits typical long sessions without
 *  unbounded growth; override via constructor for tests or extreme workloads. */
const DEFAULT_MAX_RETAINED = 256

export interface TaskRegistryOptions {
  /** Upper bound on retained SETTLED records (default 256). Running tasks
   *  never count toward the cap and are never evicted. When the settled
   *  count exceeds the cap, oldest-by-`endedAt` are dropped. */
  maxRetained?: number
}

/**
 * In-memory registry of background subagent tasks (v2's `taskRegistry`). The
 * Agent tool registers a task here when launched in background mode and
 * resolves it when the forked runner settles; `TaskOutput`/`TaskStop` observe
 * and cancel by id. Lives for the process — not persisted.
 *
 * Three seams the tools rely on:
 *   1. `register()` returns the per-task {@link AbortController}. Callers
 *      MUST plumb its `.signal` into the runner's request (via
 *      `SubagentRequest.signal`) so `stop(id)` actually unwinds the child.
 *      Discarding the controller is the historical bug class this fixed.
 *   2. `waitForSettle(id)` returns a Promise that resolves the instant the
 *      task transitions to a terminal status — event-driven, no busy poll.
 *   3. `pendingIds()` enumerates currently-running task ids — the session
 *      cleanup path uses this to stop+await all in-flight children on
 *      graceful shutdown.
 *
 * Settled-record GC: bounded by `maxRetained` (default 256). When the settled
 * count exceeds the cap, oldest-`endedAt`-first eviction reclaims space.
 * Running tasks are never evicted.
 */
export class TaskRegistry {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly aborters = new Map<string, AbortController>()
  private readonly settlers = new Map<string, { promise: Promise<void>; resolve: () => void }>()
  private readonly maxRetained: number

  constructor(opts: TaskRegistryOptions = {}) {
    this.maxRetained = opts.maxRetained ?? DEFAULT_MAX_RETAINED
  }

  /** Mint a fresh, unique task id. Uses `crypto.randomUUID()` (Bun + Node
   *  ≥19): collision-resistant regardless of clock granularity. The
   *  `task_<uuid>` shape keeps log lines greppable. */
  newId(): string {
    return `task_${crypto.randomUUID()}`
  }

  register(rec: Omit<TaskRecord, "status" | "startedAt">): AbortController {
    const ac = new AbortController()
    this.tasks.set(rec.id, { ...rec, status: "running", startedAt: Date.now() })
    this.aborters.set(rec.id, ac)
    let resolve!: () => void
    const promise = new Promise<void>((r) => {
      resolve = r
    })
    this.settlers.set(rec.id, { promise, resolve })
    return ac
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id)
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()]
  }

  /** Ids of tasks currently in the "running" state. Stable snapshot — caller
   *  may mutate via `stop()` while iterating the returned array. */
  pendingIds(): string[] {
    const out: string[] = []
    for (const t of this.tasks.values()) {
      if (t.status === "running") out.push(t.id)
    }
    return out
  }

  complete(id: string, result: SubagentResult): void {
    const t = this.tasks.get(id)
    if (!t || t.status !== "running") return
    t.status = result.ok ? "completed" : "failed"
    t.result = result
    if (!result.ok) t.error = result.finalText
    t.endedAt = Date.now()
    this.aborters.delete(id)
    this.settlers.get(id)?.resolve()
    this.settlers.delete(id)
    this.evictIfOverCap()
  }

  fail(id: string, error: string): void {
    const t = this.tasks.get(id)
    if (!t || t.status !== "running") return
    t.status = "failed"
    t.error = error
    t.endedAt = Date.now()
    this.aborters.delete(id)
    this.settlers.get(id)?.resolve()
    this.settlers.delete(id)
    this.evictIfOverCap()
  }

  /** Cancel a running task. Aborts the per-task controller (which the runner
   *  is listening on via `SubagentRequest.signal`) and flips status. Returns
   *  false if unknown or already settled. */
  stop(id: string): boolean {
    const t = this.tasks.get(id)
    if (!t || t.status !== "running") return false
    this.aborters.get(id)?.abort()
    t.status = "stopped"
    t.endedAt = Date.now()
    this.aborters.delete(id)
    this.settlers.get(id)?.resolve()
    this.settlers.delete(id)
    this.evictIfOverCap()
    return true
  }

  /** Event-driven settle notifier. Returns a Promise that resolves the
   *  instant `complete`/`fail`/`stop` is called for `id`. If the task is
   *  unknown or already settled, resolves immediately. No timer; the caller
   *  composes timeout via `Promise.race`. */
  waitForSettle(id: string): Promise<void> {
    const t = this.tasks.get(id)
    if (!t || t.status !== "running") return Promise.resolve()
    return this.settlers.get(id)?.promise ?? Promise.resolve()
  }

  /** Drop oldest-`endedAt` settled records until the settled count is under
   *  the cap. Running tasks are never evicted. O(N log N) on overflow, O(1)
   *  on the common path (no overflow). */
  private evictIfOverCap(): void {
    const settled: TaskRecord[] = []
    for (const t of this.tasks.values()) {
      if (t.status !== "running") settled.push(t)
    }
    if (settled.length <= this.maxRetained) return
    settled.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    const drop = settled.length - this.maxRetained
    for (let i = 0; i < drop; i++) {
      const t = settled[i]
      if (t) this.tasks.delete(t.id)
    }
  }
}
