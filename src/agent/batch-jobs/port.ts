/**
 * Batch-jobs slice — ports + InMemoryJobStore (ADR-0463).
 *
 * Two injected ports keep the runner port-free domain logic:
 *
 *   - {@link JobStorePort}: persists jobs + items. The composition root wires a
 *     sqlite-backed adapter (mirroring the Codex `agent_jobs` /
 *     `agent_job_items` tables + the `(job_id, status, row_index)` index). The
 *     {@link InMemoryJobStore} here doubles as the test fake AND a perfectly
 *     valid production store for ephemeral jobs.
 *   - {@link RowDispatchPort}: given a row's JSON + the job instruction, run ONE
 *     subagent task and return a structured result. The composition root wraps
 *     the real `SubagentRunner` (`@/subagent`) into this — the domain NEVER
 *     imports the subagent slice.
 *
 * SLICE: imports only `@/shared`. NO `@/subagent`, NO `@/storage` runtime — the
 * store is a port, not a concrete sqlite handle, so the domain stays testable
 * and the real adapter is injected at the composition root.
 *
 * Contract:
 *   - NO-THROW: every method returns `Result<…>`. The InMemoryJobStore can
 *     never fail in practice but still returns `Result` so it is a drop-in for
 *     a fallible sqlite adapter.
 *   - DEFAULT-OFF: constructing a store does nothing observable until a job is
 *     submitted through the runner.
 */

import { err, ok, type Result } from "@/shared"
import type { BatchJob, BatchJobError, BatchJobItem, RowDispatchResult } from "./types"

/**
 * Persistence port. The runner reads + mutates jobs/items only through this.
 * Methods are intentionally fine-grained (per-item update) so a sqlite adapter
 * can write a single row without re-serialising the whole job.
 *
 * `listItems` returns items in `(rowIndex)` ascending order — the export column
 * order + the deterministic test assertions depend on it (mirrors the Codex
 * `(job_id, status, row_index)` index ordering for `row_index`).
 */
export interface JobStorePort {
  /** Persist a freshly-built job + its items atomically. */
  createJob(job: BatchJob, items: ReadonlyArray<BatchJobItem>): Promise<Result<void, BatchJobError>>
  /** Fetch a job header by id. */
  getJob(jobId: string): Promise<Result<BatchJob, BatchJobError>>
  /** Overwrite a job header (status / timestamps / lastError). */
  putJob(job: BatchJob): Promise<Result<void, BatchJobError>>
  /** List a job's items in `rowIndex` ascending order. */
  listItems(jobId: string): Promise<Result<ReadonlyArray<BatchJobItem>, BatchJobError>>
  /** Overwrite a single item (status / attemptCount / result / lastError). */
  putItem(item: BatchJobItem): Promise<Result<void, BatchJobError>>
  /**
   * ATOMICALLY claim a `pending` item for dispatch (concurrency-safe): if the
   * item is still `pending`, flip it to `running`, increment `attemptCount`, set
   * `updatedAt = now`, and return the UPDATED item. If it is NOT pending (already
   * claimed by a concurrent worker, or terminal), return `ok(null)` — the caller
   * skips it. This is the single compare-and-set that makes the pump's
   * read-pending→write-running safe under concurrent runners over a SHARED store
   * (without it, two pumps both observe the same `pending` rows and double-
   * dispatch). For a single pump the claim always wins ⇒ byte-identical.
   */
  claimItem(
    jobId: string,
    itemId: string,
    now: number,
  ): Promise<Result<BatchJobItem | null, BatchJobError>>
}

/**
 * Subagent dispatch port. ONE call = ONE row's subagent task. The composition
 * root wires the real `SubagentRunner`; the domain knows nothing about agent
 * loops, depth, or tool registries.
 *
 * NO-THROW: a dispatch failure (child errored, timed out, produced unusable
 * output) resolves `Err`, never rejects. An aborted dispatch resolves
 * `Err({kind:"aborted"})`.
 *
 * `signal` lets `tick`/`await` cancel in-flight dispatches when the job's abort
 * fires; the adapter MUST chain it into the forked child loop's signal.
 */
export type RowDispatchPort = (req: {
  readonly instruction: string
  readonly rowJson: string
  readonly rowIndex: number
  readonly attempt: number
  readonly signal?: AbortSignal
}) => Promise<Result<RowDispatchResult, BatchJobError>>

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryJobStore — test fake + ephemeral-job production store
// ─────────────────────────────────────────────────────────────────────────────

/** Deep-ish copy so callers can't mutate the store's internal records by ref
 *  (mirrors a sqlite row read returning a fresh object each time). */
const cloneJob = (j: BatchJob): BatchJob => ({ ...j })
const cloneItem = (i: BatchJobItem): BatchJobItem => ({ ...i })

/**
 * In-memory {@link JobStorePort}. Used by tests and as a valid production store
 * for jobs that don't need to survive a restart. Never fails — but still
 * returns `Result` so it is a structural drop-in for the sqlite adapter.
 */
export class InMemoryJobStore implements JobStorePort {
  private readonly jobs = new Map<string, BatchJob>()
  private readonly items = new Map<string, BatchJobItem[]>()

  createJob(
    job: BatchJob,
    items: ReadonlyArray<BatchJobItem>,
  ): Promise<Result<void, BatchJobError>> {
    if (this.jobs.has(job.id)) {
      return Promise.resolve(
        err<BatchJobError>({ kind: "store-failed", reason: `duplicate job id: ${job.id}` }),
      )
    }
    this.jobs.set(job.id, cloneJob(job))
    this.items.set(job.id, items.map(cloneItem))
    return Promise.resolve(ok(undefined))
  }

  getJob(jobId: string): Promise<Result<BatchJob, BatchJobError>> {
    const j = this.jobs.get(jobId)
    return Promise.resolve(
      j ? ok(cloneJob(j)) : err<BatchJobError>({ kind: "job-not-found", jobId }),
    )
  }

  putJob(job: BatchJob): Promise<Result<void, BatchJobError>> {
    if (!this.jobs.has(job.id)) {
      return Promise.resolve(err<BatchJobError>({ kind: "job-not-found", jobId: job.id }))
    }
    this.jobs.set(job.id, cloneJob(job))
    return Promise.resolve(ok(undefined))
  }

  listItems(jobId: string): Promise<Result<ReadonlyArray<BatchJobItem>, BatchJobError>> {
    const list = this.items.get(jobId)
    if (!list) return Promise.resolve(err<BatchJobError>({ kind: "job-not-found", jobId }))
    const sorted = [...list].sort((a, b) => a.rowIndex - b.rowIndex).map(cloneItem)
    return Promise.resolve(ok(sorted))
  }

  putItem(item: BatchJobItem): Promise<Result<void, BatchJobError>> {
    const list = this.items.get(item.jobId)
    if (!list) {
      return Promise.resolve(err<BatchJobError>({ kind: "job-not-found", jobId: item.jobId }))
    }
    const idx = list.findIndex((i) => i.itemId === item.itemId)
    if (idx < 0) {
      return Promise.resolve(
        err<BatchJobError>({ kind: "store-failed", reason: `unknown item: ${item.itemId}` }),
      )
    }
    list[idx] = cloneItem(item)
    return Promise.resolve(ok(undefined))
  }

  claimItem(
    jobId: string,
    itemId: string,
    now: number,
  ): Promise<Result<BatchJobItem | null, BatchJobError>> {
    const list = this.items.get(jobId)
    if (!list) return Promise.resolve(err<BatchJobError>({ kind: "job-not-found", jobId }))
    const idx = list.findIndex((i) => i.itemId === itemId)
    if (idx < 0) {
      return Promise.resolve(
        err<BatchJobError>({ kind: "store-failed", reason: `unknown item: ${itemId}` }),
      )
    }
    const cur = list[idx] as BatchJobItem
    // Compare-and-set is atomic here because JS is single-threaded: this whole
    // method runs to completion within one microtask tick — no `await` between
    // the status read and the write, so two concurrent claims cannot interleave.
    if (cur.status !== "pending") return Promise.resolve(ok(null)) // lost / not claimable
    const claimed: BatchJobItem = {
      ...cur,
      status: "running",
      attemptCount: cur.attemptCount + 1,
      updatedAt: now,
    }
    list[idx] = cloneItem(claimed)
    return Promise.resolve(ok(cloneItem(claimed)))
  }
}
