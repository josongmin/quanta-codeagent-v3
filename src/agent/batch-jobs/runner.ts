/**
 * Batch-jobs slice — the runner (submit / tick / await / export) (ADR-0463).
 *
 * Port-free domain logic. Owns the row state machine
 * (pending→running→{done|failed}), the bounded concurrency pool, retry up to
 * the job's attempt cap, and per-row output-schema enforcement. The subagent
 * dispatcher + the store are INJECTED ports — this file imports neither
 * `@/subagent` nor `@/storage`.
 *
 * SLICE: imports only `@/shared` + this slice's own modules. The
 * {@link RowSchemaValidator} is injected (compiled at the composition root via
 * `schema.ts`) so the runner never imports zod.
 *
 * Contract:
 *   - NO-THROW: every public method returns `Result<…>`. A store failure
 *     surfaces as `Err({kind:"store-failed"})`; an abort surfaces as
 *     `Err({kind:"aborted"})` (the job itself is left in `cancelled`).
 *   - exactOptionalPropertyTypes: optional item/job fields are assigned only
 *     when present, never set to `undefined`.
 *   - DEFAULT-OFF: a job runs ONLY when `submit()` is explicitly called. There
 *     is no auto-trigger, no env flag, no background scheduler in this module.
 *     A process that never calls `submit()` sees zero behaviour from this slice.
 *   - A row that fails the output schema is marked `failed` with a
 *     schema `lastError` and does NOT abort the whole job (Codex semantics).
 *   - Retry: a `dispatch-failed` row is re-queued until `attemptCount` reaches
 *     the job's `maxAttempts`, then it is sticky `failed`.
 */

import { err, ok, type Result } from "@/shared"
import { renderResultsCsv } from "./csv"
import type { JobStorePort, RowDispatchPort } from "./port"
import {
  type BatchJob,
  type BatchJobError,
  type BatchJobItem,
  type BatchJobSpec,
  type ItemFailureKind,
  type JobSnapshot,
  MAX_POOL_SIZE,
  type RowSchemaValidator,
  TERMINAL_ITEM_STATUSES,
} from "./types"

/** Monotonic-clock injection so tests are deterministic and the runner never
 *  reads `Date.now()` directly (mirrors the clock-injection discipline). */
export type Clock = () => number

/** Id minting injection (job id + item ids). Deterministic in tests. */
export type IdGen = () => string

export interface RunnerDeps {
  readonly store: JobStorePort
  readonly dispatch: RowDispatchPort
  readonly clock: Clock
  readonly newId: IdGen
  /** Compiled per-row output-schema validator. OMITTED ⇒ no validation. The
   *  composition root compiles `spec.outputSchemaJson` into this; the runner
   *  never imports zod. */
  readonly schema?: RowSchemaValidator
}

/** Validate a spec before any store write. Fail-closed on programmer-bug input
 *  (encoded as `Err`, never thrown). */
const validateSpec = (spec: BatchJobSpec): BatchJobError | null => {
  if (typeof spec.name !== "string" || spec.name.length === 0) {
    return { kind: "invalid-spec", reason: "spec.name must be a non-empty string" }
  }
  if (typeof spec.instruction !== "string" || spec.instruction.length === 0) {
    return { kind: "invalid-spec", reason: "spec.instruction must be a non-empty string" }
  }
  if (!Array.isArray(spec.rows)) {
    return { kind: "invalid-spec", reason: "spec.rows must be an array" }
  }
  if (!Number.isInteger(spec.poolSize) || spec.poolSize < 1) {
    return { kind: "invalid-spec", reason: "spec.poolSize must be an integer ≥ 1" }
  }
  // GAP7-1: bound concurrent fan-out. An uncapped poolSize over a large CSV would
  // launch one subagent loop per row at once (provider/cost/memory blowup).
  if (spec.poolSize > MAX_POOL_SIZE) {
    return {
      kind: "invalid-spec",
      reason: `spec.poolSize ${spec.poolSize} exceeds MAX_POOL_SIZE ${MAX_POOL_SIZE}`,
    }
  }
  if (!Number.isInteger(spec.maxAttempts) || spec.maxAttempts < 1) {
    return { kind: "invalid-spec", reason: "spec.maxAttempts must be an integer ≥ 1" }
  }
  return null
}

/**
 * The batch-job runner. Stateless between calls except through the injected
 * store — so multiple runners over the same store observe the same job.
 */
export class BatchJobRunner {
  constructor(private readonly deps: RunnerDeps) {}

  /**
   * Build a job + its items from a spec and persist them as `pending`.
   * Does NOT start dispatching — call {@link runToEnd} (or `tick`) to drive
   * execution. Returns the new job id.
   */
  async submit(spec: BatchJobSpec): Promise<Result<string, BatchJobError>> {
    const invalid = validateSpec(spec)
    if (invalid) return err(invalid)

    const now = this.deps.clock()
    const jobId = this.deps.newId()
    const job: BatchJob = {
      id: jobId,
      name: spec.name,
      status: "pending",
      instruction: spec.instruction,
      inputHeadersJson: JSON.stringify(spec.headers),
      poolSize: spec.poolSize,
      maxAttempts: spec.maxAttempts,
      createdAt: now,
      updatedAt: now,
      ...(spec.outputSchemaJson !== undefined ? { outputSchemaJson: spec.outputSchemaJson } : {}),
    }
    const items: BatchJobItem[] = spec.rows.map((row, rowIndex) => ({
      jobId,
      itemId: this.deps.newId(),
      rowIndex,
      rowJson: JSON.stringify(row),
      status: "pending",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    }))

    const created = await this.deps.store.createJob(job, items)
    if (!created.ok) return err(created.error)
    return ok(jobId)
  }

  /**
   * Drive a job to a terminal state with a bounded concurrency pool. Re-reads
   * the items from the store, schedules `pending` items up to `poolSize` in
   * flight, retries `dispatch-failed` rows until the attempt cap, and enforces
   * the output schema per row. Resolves a final {@link JobSnapshot}.
   *
   * Abort: when `signal` fires, in-flight dispatches are cancelled (the port
   * receives the signal) and the job is marked `cancelled`; resolves
   * `Err({kind:"aborted"})` with the job already persisted as `cancelled`.
   */
  async runToEnd(jobId: string, signal?: AbortSignal): Promise<Result<JobSnapshot, BatchJobError>> {
    const jobRes = await this.deps.store.getJob(jobId)
    if (!jobRes.ok) return err(jobRes.error)
    const job = jobRes.value

    if (signal?.aborted) {
      await this.finalize(job, "cancelled")
      return err<BatchJobError>({ kind: "aborted" })
    }

    // Mark running.
    if (job.status === "pending") {
      job.status = "running"
      job.startedAt = this.deps.clock()
      job.updatedAt = this.deps.clock()
      const put = await this.deps.store.putJob(job)
      if (!put.ok) return err(put.error)
    }

    const outcome = await this.pump(job, signal)
    if (outcome === "aborted") {
      await this.finalize(job, "cancelled")
      return err<BatchJobError>({ kind: "aborted" })
    }
    if (outcome === "store-failed") {
      // A store fault mid-pump is the exact "job-level fault surfaced at tick"
      // that the `failed` job status is reserved for (types.ts). The job is
      // driven to `failed` (NOT `completed`) so the fault is never masked as a
      // clean run; `job.lastError` carries the cause.
      await this.finalize(job, "failed")
      // Do NOT route through snapshot() here — the store is faulting, so its
      // listItems would fault AGAIN and the job-level failure would be masked
      // behind a store-read error (the caller would never learn the job
      // failed). Surface the in-memory `job` (already finalized to `failed`
      // with lastError) directly, with best-effort items: if the item read
      // still faults, return what we have rather than discarding the verdict.
      const itemsRes = await this.deps.store.listItems(jobId)
      const items = itemsRes.ok ? itemsRes.value : []
      return ok({ job, items })
    }

    await this.finalize(job, "completed")
    const snap = await this.snapshot(jobId)
    return snap
  }

  /**
   * Resume an interrupted job (GAP7-5). After a crash/restart over a durable
   * store, a job may be left `pending`/`running` with items stranded `running`
   * (the attempt was started but never settled). This:
   *   1. no-ops on a job already terminal (`completed`/`failed`/`cancelled`) —
   *      returns its snapshot;
   *   2. resets every stranded `running` item back to `pending`, rolling the
   *      interrupted attempt back by one (mirrors the abort roll-back) so it gets
   *      a fresh try and the attempt cap is honored;
   *   3. drives the job to completion via {@link runToEnd}.
   * NO-THROW: a store fault surfaces as `Err`.
   */
  async resume(jobId: string, signal?: AbortSignal): Promise<Result<JobSnapshot, BatchJobError>> {
    const jobRes = await this.deps.store.getJob(jobId)
    if (!jobRes.ok) return err(jobRes.error)
    const job = jobRes.value
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return this.snapshot(jobId)
    }
    const itemsRes = await this.deps.store.listItems(jobId)
    if (!itemsRes.ok) return err(itemsRes.error)
    for (const it of itemsRes.value) {
      if (it.status !== "running") continue
      const reset: BatchJobItem = {
        ...it,
        status: "pending",
        attemptCount: Math.max(0, it.attemptCount - 1),
        lastError: "resumed after interruption",
        updatedAt: this.deps.clock(),
      }
      const put = await this.deps.store.putItem(reset)
      if (!put.ok) return err(put.error)
    }
    return this.runToEnd(jobId, signal)
  }

  /**
   * The bounded pool. Repeatedly loads the work queue from the store and runs
   * up to `poolSize` items concurrently until none remain `pending`/retryable.
   * Returns the pump outcome:
   *   - `"aborted"`  — the signal fired (job → `cancelled`);
   *   - `"store-failed"` — a store read/write faulted (job → `failed`);
   *   - `"drained"`  — every item reached a terminal state (job → `completed`).
   */
  private async pump(
    job: BatchJob,
    signal?: AbortSignal,
  ): Promise<"aborted" | "store-failed" | "drained"> {
    for (;;) {
      if (signal?.aborted) return "aborted"
      const itemsRes = await this.deps.store.listItems(job.id)
      if (!itemsRes.ok) {
        job.lastError = `store failure during pump: ${itemsRes.error.kind}`
        return "store-failed"
      }
      const runnable = itemsRes.value.filter((i) => i.status === "pending")
      if (runnable.length === 0) return "drained"

      const batch = runnable.slice(0, job.poolSize)
      const results = await Promise.all(batch.map((item) => this.runItem(job, item, signal)))
      if (results.some((r) => r === "aborted")) return "aborted"
      if (results.some((r) => r === "store-failed")) {
        job.lastError = "store failure during item persistence"
        return "store-failed"
      }
    }
  }

  /** Run one item once: dispatch → validate → persist terminal-or-retry.
   *  `"store-failed"` propagates a store-write fault up so the job is driven to
   *  `failed` instead of masking the lost write as a clean run. */
  private async runItem(
    job: BatchJob,
    snapshotItem: BatchJobItem,
    signal?: AbortSignal,
  ): Promise<"done" | "retry" | "failed" | "aborted" | "store-failed" | "skip"> {
    if (signal?.aborted) return "aborted"

    // ATOMICALLY claim the item (pending→running, attempt+1). Concurrency-safe:
    // if a sibling pump (or another runner over a shared store) already claimed
    // it, `claimItem` returns null and we SKIP — never double-dispatch a row.
    const claim = await this.deps.store.claimItem(
      snapshotItem.jobId,
      snapshotItem.itemId,
      this.deps.clock(),
    )
    if (!claim.ok) return "store-failed"
    if (claim.value === null) return "skip" // lost the claim — another worker owns it
    const item: BatchJobItem = { ...claim.value }

    const dispatched = await this.deps.dispatch({
      instruction: job.instruction,
      rowJson: item.rowJson,
      rowIndex: item.rowIndex,
      attempt: item.attemptCount,
      ...(signal ? { signal } : {}),
    })

    if (!dispatched.ok) {
      if (dispatched.error.kind === "aborted") {
        // Roll the in-flight attempt back to `pending` (and un-count it) so the
        // item is left in a RESUMABLE state, never stranded `running`. The
        // pump's abort path then finalizes the job as `cancelled`. A best-effort
        // persist failure here cannot mask the abort, so its Result is ignored.
        item.status = "pending"
        item.attemptCount -= 1
        item.lastError = "aborted before completion"
        item.updatedAt = this.deps.clock()
        await this.persist(item)
        return "aborted"
      }
      return this.recordDispatchFailure(job, item, dispatched.error)
    }

    if (dispatched.value.threadId !== undefined) {
      item.assignedThreadId = dispatched.value.threadId
    }

    // Schema enforcement per row.
    if (this.deps.schema !== undefined) {
      const validated = this.deps.schema(dispatched.value.value)
      if (!validated.ok) {
        return this.markFailed(item, "schema-rejected", validated.reason)
      }
      item.resultJson = JSON.stringify(validated.value)
    } else {
      item.resultJson = JSON.stringify(dispatched.value.value)
    }

    item.status = "done"
    item.completedAt = this.deps.clock()
    item.updatedAt = item.completedAt
    delete item.lastError
    return (await this.persist(item)) ? "done" : "store-failed"
  }

  /** A dispatch error: retry if under the attempt cap, else sticky failed. */
  private async recordDispatchFailure(
    job: BatchJob,
    item: BatchJobItem,
    error: BatchJobError,
  ): Promise<"retry" | "failed" | "store-failed"> {
    const reason =
      error.kind === "store-failed"
        ? error.reason
        : error.kind === "job-not-found"
          ? `job not found: ${error.jobId}`
          : error.kind === "invalid-spec"
            ? error.reason
            : "dispatch failed"
    if (item.attemptCount < job.maxAttempts) {
      // Re-queue: back to pending so the pump schedules it again.
      item.status = "pending"
      item.lastError = `attempt ${item.attemptCount} failed: ${reason}`
      item.updatedAt = this.deps.clock()
      return (await this.persist(item)) ? "retry" : "store-failed"
    }
    return this.markFailed(item, "dispatch-failed", reason)
  }

  /** Mark an item terminally failed with a typed failure cause. */
  private async markFailed(
    item: BatchJobItem,
    kind: ItemFailureKind,
    reason: string,
  ): Promise<"failed" | "store-failed"> {
    item.status = "failed"
    item.lastError = `${kind}: ${reason}`
    item.completedAt = this.deps.clock()
    item.updatedAt = item.completedAt
    return (await this.persist(item)) ? "failed" : "store-failed"
  }

  /** Persist a single item; returns `false` (never throws) on a store fault so
   *  callers can surface it as a job-level `store-failed` outcome. */
  private async persist(item: BatchJobItem): Promise<boolean> {
    const res = await this.deps.store.putItem(item)
    return res.ok
  }

  /** Set the job's terminal status + timestamps. */
  private async finalize(job: BatchJob, status: BatchJob["status"]): Promise<void> {
    job.status = status
    job.completedAt = this.deps.clock()
    job.updatedAt = job.completedAt
    await this.deps.store.putJob(job)
  }

  /** Snapshot a job + its items (items in rowIndex order). */
  async snapshot(jobId: string): Promise<Result<JobSnapshot, BatchJobError>> {
    const jobRes = await this.deps.store.getJob(jobId)
    if (!jobRes.ok) return err(jobRes.error)
    const itemsRes = await this.deps.store.listItems(jobId)
    if (!itemsRes.ok) return err(itemsRes.error)
    return ok({ job: jobRes.value, items: itemsRes.value })
  }

  /**
   * Export a job's items to a results CSV string. Columns: the input headers
   * (rebuilt from each item's `rowJson`) + `_status`, `_result`, `_error`.
   * Deterministic row order = `rowIndex` ascending. Pure with respect to the
   * store read; the caller writes the file.
   */
  async exportCsv(jobId: string): Promise<Result<string, BatchJobError>> {
    const jobRes = await this.deps.store.getJob(jobId)
    if (!jobRes.ok) return err(jobRes.error)
    const itemsRes = await this.deps.store.listItems(jobId)
    if (!itemsRes.ok) return err(itemsRes.error)

    const headers = this.parseHeaders(jobRes.value.inputHeadersJson)
    const extra = ["_status", "_result", "_error"] as const
    const rows = itemsRes.value.map((item) => {
      const rowData = this.parseRowJson(item.rowJson)
      return {
        ...rowData,
        _status: item.status,
        _result: item.resultJson ?? "",
        _error: item.lastError ?? "",
      }
    })
    return ok(renderResultsCsv(headers, [...extra], rows))
  }

  private parseHeaders(headersJson: string): ReadonlyArray<string> {
    try {
      const parsed = JSON.parse(headersJson)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }

  private parseRowJson(rowJson: string): Record<string, string> {
    try {
      const parsed = JSON.parse(rowJson)
      if (typeof parsed === "object" && parsed !== null) {
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(parsed)) out[k] = String(v)
        return out
      }
    } catch {
      // fall through
    }
    return {}
  }
}

/** Predicate re-exported for callers that want to test whole-job completion
 *  without re-deriving the terminal-status set. */
export const isItemTerminal = (item: BatchJobItem): boolean =>
  TERMINAL_ITEM_STATUSES.has(item.status)
