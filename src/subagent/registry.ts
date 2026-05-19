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

/**
 * In-memory registry of background subagent tasks (v2's `taskRegistry`). The
 * Agent tool registers a task here when launched in background mode and
 * resolves it when the forked runner settles; `TaskOutput`/`TaskStop` poll
 * and cancel by id. Lives for the process — not persisted.
 */
export class TaskRegistry {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly aborters = new Map<string, AbortController>()
  private seq = 0

  /** Mint a fresh, unique task id. */
  newId(): string {
    this.seq += 1
    return `task_${Date.now().toString(36)}_${this.seq}`
  }

  register(rec: Omit<TaskRecord, "status" | "startedAt">): AbortController {
    const ac = new AbortController()
    this.tasks.set(rec.id, { ...rec, status: "running", startedAt: Date.now() })
    this.aborters.set(rec.id, ac)
    return ac
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id)
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()]
  }

  complete(id: string, result: SubagentResult): void {
    const t = this.tasks.get(id)
    if (!t || t.status !== "running") return
    t.status = result.ok ? "completed" : "failed"
    t.result = result
    if (!result.ok) t.error = result.finalText
    t.endedAt = Date.now()
    this.aborters.delete(id)
  }

  fail(id: string, error: string): void {
    const t = this.tasks.get(id)
    if (!t || t.status !== "running") return
    t.status = "failed"
    t.error = error
    t.endedAt = Date.now()
    this.aborters.delete(id)
  }

  /** Cancel a running task. Returns false if unknown or already settled. */
  stop(id: string): boolean {
    const t = this.tasks.get(id)
    if (!t || t.status !== "running") return false
    this.aborters.get(id)?.abort()
    t.status = "stopped"
    t.endedAt = Date.now()
    this.aborters.delete(id)
    return true
  }
}
