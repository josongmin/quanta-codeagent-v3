/**
 * sqlite-backed {@link JobStorePort} (GAP7-3, ADR-0463).
 *
 * The batch-jobs domain (`@/agent/batch-jobs`) is port-free — its `InMemoryJobStore`
 * cannot survive a restart. This is the durable adapter the composition root wires
 * so a long batch run resumes after a crash/restart (GAP7-5). Tables mirror the
 * Codex `agent_jobs` / `agent_job_items` schema + the `(job_id, row_index)` index.
 *
 * Lives in `src/host/runtime/` (the composition layer) — NOT the domain slice —
 * because it owns a concrete `bun:sqlite` handle (the slice may import only
 * `@/shared`). NO-THROW: every method wraps the sqlite ops and resolves a typed
 * `Result`, never rejects, so it is a structural drop-in for `InMemoryJobStore`.
 */
import { Database } from "bun:sqlite"
import type { BatchJob, BatchJobError, BatchJobItem, JobStorePort } from "@/agent/batch-jobs"
import { err, errMessage, ok, type Result } from "@/shared"

const DDL = `
CREATE TABLE IF NOT EXISTS agent_jobs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
  instruction TEXT NOT NULL, output_schema_json TEXT,
  input_headers_json TEXT NOT NULL, pool_size INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, last_error TEXT
);
CREATE TABLE IF NOT EXISTS agent_job_items (
  job_id TEXT NOT NULL, item_id TEXT PRIMARY KEY, row_index INTEGER NOT NULL,
  source_id TEXT, row_json TEXT NOT NULL, status TEXT NOT NULL,
  assigned_thread_id TEXT, attempt_count INTEGER NOT NULL, result_json TEXT,
  last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_items_job_row ON agent_job_items(job_id, row_index);
`

type JobRow = {
  id: string
  name: string
  status: string
  instruction: string
  output_schema_json: string | null
  input_headers_json: string
  pool_size: number
  max_attempts: number
  created_at: number
  updated_at: number
  started_at: number | null
  completed_at: number | null
  last_error: string | null
}
type ItemRow = {
  job_id: string
  item_id: string
  row_index: number
  source_id: string | null
  row_json: string
  status: string
  assigned_thread_id: string | null
  attempt_count: number
  result_json: string | null
  last_error: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

const toJob = (r: JobRow): BatchJob => ({
  id: r.id,
  name: r.name,
  status: r.status as BatchJob["status"],
  instruction: r.instruction,
  inputHeadersJson: r.input_headers_json,
  poolSize: r.pool_size,
  maxAttempts: r.max_attempts,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.output_schema_json !== null ? { outputSchemaJson: r.output_schema_json } : {}),
  ...(r.started_at !== null ? { startedAt: r.started_at } : {}),
  ...(r.completed_at !== null ? { completedAt: r.completed_at } : {}),
  ...(r.last_error !== null ? { lastError: r.last_error } : {}),
})

const toItem = (r: ItemRow): BatchJobItem => ({
  jobId: r.job_id,
  itemId: r.item_id,
  rowIndex: r.row_index,
  rowJson: r.row_json,
  status: r.status as BatchJobItem["status"],
  attemptCount: r.attempt_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.source_id !== null ? { sourceId: r.source_id } : {}),
  ...(r.assigned_thread_id !== null ? { assignedThreadId: r.assigned_thread_id } : {}),
  ...(r.result_json !== null ? { resultJson: r.result_json } : {}),
  ...(r.last_error !== null ? { lastError: r.last_error } : {}),
  ...(r.completed_at !== null ? { completedAt: r.completed_at } : {}),
})

/** Durable sqlite {@link JobStorePort}. `path` defaults to an in-process db
 *  (`:memory:`) — pass a file path for restart-survival (GAP7-5 resume). */
export class SqliteJobStore implements JobStorePort {
  private readonly db: Database
  constructor(path = ":memory:") {
    this.db = new Database(path)
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run(DDL)
  }

  /** Close the underlying handle (tests / shutdown). */
  close(): void {
    this.db.close()
  }

  createJob(
    job: BatchJob,
    items: ReadonlyArray<BatchJobItem>,
  ): Promise<Result<void, BatchJobError>> {
    try {
      const existing = this.db.query("SELECT id FROM agent_jobs WHERE id = ?").get(job.id)
      if (existing !== null) {
        return Promise.resolve(
          err<BatchJobError>({ kind: "store-failed", reason: `duplicate job id: ${job.id}` }),
        )
      }
      const tx = this.db.transaction(() => {
        this.insertJob(job)
        for (const it of items) this.insertItem(it)
      })
      tx()
      return Promise.resolve(ok(undefined))
    } catch (e) {
      return Promise.resolve(err<BatchJobError>({ kind: "store-failed", reason: errMessage(e) }))
    }
  }

  getJob(jobId: string): Promise<Result<BatchJob, BatchJobError>> {
    try {
      const r = this.db.query("SELECT * FROM agent_jobs WHERE id = ?").get(jobId) as JobRow | null
      return Promise.resolve(
        r === null ? err<BatchJobError>({ kind: "job-not-found", jobId }) : ok(toJob(r)),
      )
    } catch (e) {
      return Promise.resolve(err<BatchJobError>({ kind: "store-failed", reason: errMessage(e) }))
    }
  }

  putJob(job: BatchJob): Promise<Result<void, BatchJobError>> {
    try {
      const changed = this.db
        .query(
          `UPDATE agent_jobs SET name=?, status=?, instruction=?, output_schema_json=?,
             input_headers_json=?, pool_size=?, max_attempts=?, updated_at=?,
             started_at=?, completed_at=?, last_error=? WHERE id=?`,
        )
        .run(
          job.name,
          job.status,
          job.instruction,
          job.outputSchemaJson ?? null,
          job.inputHeadersJson,
          job.poolSize,
          job.maxAttempts,
          job.updatedAt,
          job.startedAt ?? null,
          job.completedAt ?? null,
          job.lastError ?? null,
          job.id,
        )
      if (changed.changes === 0) {
        return Promise.resolve(err<BatchJobError>({ kind: "job-not-found", jobId: job.id }))
      }
      return Promise.resolve(ok(undefined))
    } catch (e) {
      return Promise.resolve(err<BatchJobError>({ kind: "store-failed", reason: errMessage(e) }))
    }
  }

  listItems(jobId: string): Promise<Result<ReadonlyArray<BatchJobItem>, BatchJobError>> {
    try {
      const jobExists = this.db.query("SELECT id FROM agent_jobs WHERE id = ?").get(jobId)
      if (jobExists === null)
        return Promise.resolve(err<BatchJobError>({ kind: "job-not-found", jobId }))
      const rows = this.db
        .query("SELECT * FROM agent_job_items WHERE job_id = ? ORDER BY row_index ASC")
        .all(jobId) as ItemRow[]
      return Promise.resolve(ok(rows.map(toItem)))
    } catch (e) {
      return Promise.resolve(err<BatchJobError>({ kind: "store-failed", reason: errMessage(e) }))
    }
  }

  putItem(item: BatchJobItem): Promise<Result<void, BatchJobError>> {
    try {
      const changed = this.db
        .query(
          `UPDATE agent_job_items SET row_index=?, source_id=?, row_json=?, status=?,
             assigned_thread_id=?, attempt_count=?, result_json=?, last_error=?,
             updated_at=?, completed_at=? WHERE item_id=? AND job_id=?`,
        )
        .run(
          item.rowIndex,
          item.sourceId ?? null,
          item.rowJson,
          item.status,
          item.assignedThreadId ?? null,
          item.attemptCount,
          item.resultJson ?? null,
          item.lastError ?? null,
          item.updatedAt,
          item.completedAt ?? null,
          item.itemId,
          item.jobId,
        )
      if (changed.changes === 0) {
        // Mirror InMemoryJobStore: an unknown item id ⇒ store-failed; an item
        // whose job is gone ⇒ job-not-found.
        const jobExists = this.db.query("SELECT id FROM agent_jobs WHERE id = ?").get(item.jobId)
        return Promise.resolve(
          jobExists === null
            ? err<BatchJobError>({ kind: "job-not-found", jobId: item.jobId })
            : err<BatchJobError>({ kind: "store-failed", reason: `unknown item: ${item.itemId}` }),
        )
      }
      return Promise.resolve(ok(undefined))
    } catch (e) {
      return Promise.resolve(err<BatchJobError>({ kind: "store-failed", reason: errMessage(e) }))
    }
  }

  private insertJob(job: BatchJob): void {
    this.db
      .query(
        `INSERT INTO agent_jobs (id, name, status, instruction, output_schema_json,
           input_headers_json, pool_size, max_attempts, created_at, updated_at,
           started_at, completed_at, last_error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        job.id,
        job.name,
        job.status,
        job.instruction,
        job.outputSchemaJson ?? null,
        job.inputHeadersJson,
        job.poolSize,
        job.maxAttempts,
        job.createdAt,
        job.updatedAt,
        job.startedAt ?? null,
        job.completedAt ?? null,
        job.lastError ?? null,
      )
  }

  private insertItem(it: BatchJobItem): void {
    this.db
      .query(
        `INSERT INTO agent_job_items (job_id, item_id, row_index, source_id, row_json,
           status, assigned_thread_id, attempt_count, result_json, last_error,
           created_at, updated_at, completed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        it.jobId,
        it.itemId,
        it.rowIndex,
        it.sourceId ?? null,
        it.rowJson,
        it.status,
        it.assignedThreadId ?? null,
        it.attemptCount,
        it.resultJson ?? null,
        it.lastError ?? null,
        it.createdAt,
        it.updatedAt,
        it.completedAt ?? null,
      )
  }
}
