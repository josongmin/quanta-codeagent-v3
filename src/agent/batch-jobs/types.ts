/**
 * Batch-jobs slice — domain types (ADR-0463).
 *
 * CSV batch-job runner: fan a CSV (or row list) out over subagents, one row =
 * one subagent task. 2-vendor convergence (Codex `agent_jobs` sqlite schema +
 * Cursor batch fan-out). The domain types here mirror the Codex sqlite schema
 * VERBATIM in spirit:
 *
 *   agent_jobs(id, name, status, instruction, output_schema_json,
 *     input_headers_json, input_csv_path, output_csv_path, auto_export,
 *     max_runtime_seconds, created_at, updated_at, started_at, completed_at,
 *     last_error)
 *   agent_job_items(job_id, item_id, row_index, source_id, row_json, status,
 *     assigned_thread_id, attempt_count, result_json, last_error, created_at,
 *     updated_at, completed_at, reported_at)
 *
 * SLICE: `@/agent` may import everything below it, but this module is
 * deliberately PORT-FREE domain logic — it imports only `@/shared`. The
 * subagent dispatcher is INVERTED behind {@link RowDispatchPort}; persistence
 * is inverted behind {@link JobStorePort} (see `port.ts`). The composition
 * root in `@/apps` wires the real subagent runner + store into these ports.
 *
 * Contract:
 *   - NO-THROW: every port method returns `Result<…>` from `@/shared`.
 *     Programmer-bug inputs are encoded as `Err`, never thrown past the
 *     boundary.
 *   - exactOptionalPropertyTypes: optional fields are OMITTED when absent,
 *     never set to `undefined`.
 *   - Closed status unions so every consumer branches exhaustively.
 *   - DEFAULT-OFF: nothing here auto-runs. A batch job exists only when a
 *     caller explicitly constructs + submits a {@link BatchJobSpec}. No
 *     auto-trigger, no env-driven activation.
 */

/** Job lifecycle status. Mirrors the Codex `agent_jobs.status` enum.
 *  `pending` → `running` → terminal (`completed` | `failed` | `cancelled`).
 *  `completed` = every item reached a terminal state and at least the job ran
 *  to the end (items may individually be `failed`); `failed` is reserved for a
 *  job-level fault (store failure surfaced at submit/tick); `cancelled` = an
 *  abort fired mid-job. */
export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled"

/** Per-item lifecycle status. Mirrors `agent_job_items.status`.
 *  `pending` → `running` → (`done` | `failed`). `failed` is sticky once the
 *  attempt cap is exhausted; a row that fails the output schema is `failed`
 *  with a schema `last_error` and does NOT abort the job. */
export type ItemStatus = "pending" | "running" | "done" | "failed"

/** All job statuses in lifecycle order — authoritative allow-list for any
 *  exhaustive enumeration / fixed-set validation (no heuristic thresholds). */
export const JOB_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const

/** All item statuses in lifecycle order. */
export const ITEM_STATUSES = ["pending", "running", "done", "failed"] as const

/** Terminal item states — `tick` stops scheduling an item once it is here. */
export const TERMINAL_ITEM_STATUSES: ReadonlySet<ItemStatus> = new Set<ItemStatus>([
  "done",
  "failed",
])

/**
 * The caller-authored job spec. The runner derives a {@link BatchJob} +
 * {@link BatchJobItem}[] from this at submit time.
 *
 * `rows` is the parsed CSV body (header → value maps) OR an explicit row list.
 * The runner does NOT read a file itself (slice isolation: no FS in the domain
 * module) — the caller parses the CSV via `parseRowsFromCsv` (this slice's pure
 * helper, which wraps the `csv-parse` lib) and hands the rows in.
 */
export interface BatchJobSpec {
  /** Human-facing name (Codex `agent_jobs.name`). */
  readonly name: string
  /** The instruction template handed to EACH row's subagent task. The row's
   *  JSON is appended by the runner so the child sees both. Codex
   *  `agent_jobs.instruction`. */
  readonly instruction: string
  /** Parsed rows. One row → one item → one subagent task. May be empty (an
   *  empty job completes immediately with zero items). */
  readonly rows: ReadonlyArray<JobRow>
  /** Header order, preserved for a deterministic CSV export column order.
   *  Codex `agent_jobs.input_headers_json`. */
  readonly headers: ReadonlyArray<string>
  /** Max concurrent in-flight items. REQUIRED (not a magic constant) — the
   *  spec author picks it. {@link DEFAULT_POOL_SIZE} is offered as a documented
   *  default for callers that want one, but the field itself is mandatory. */
  readonly poolSize: number
  /** Per-item attempt cap. Attempt 1 + (cap-1) retries. A failure short of the
   *  cap re-queues the item; at the cap the item is sticky `failed`. Codex
   *  drives this via the worker loop; we make it explicit per job. Must be ≥ 1.
   */
  readonly maxAttempts: number
  /** Optional zod-shaped schema (as a JSON-schema-ish marker). When present the
   *  runner validates EACH row's dispatched result against it; a row whose
   *  result fails validation is marked `failed` with a schema `last_error` and
   *  does NOT abort the job. Encoded as the raw schema string (Codex
   *  `agent_jobs.output_schema_json`) — the runner is handed a compiled
   *  {@link RowSchemaValidator} so the domain module never imports zod's
   *  runtime directly through a port boundary. OMITTED ⇒ no per-row validation.
   */
  readonly outputSchemaJson?: string
}

/** One CSV row as a header→value map. Codex `agent_job_items.row_json`. */
export type JobRow = Readonly<Record<string, string>>

/** A submitted job's persisted header record. Mirrors `agent_jobs`. */
export interface BatchJob {
  readonly id: string
  readonly name: string
  status: JobStatus
  readonly instruction: string
  readonly outputSchemaJson?: string
  readonly inputHeadersJson: string
  readonly poolSize: number
  readonly maxAttempts: number
  readonly createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  lastError?: string
}

/** A persisted per-row item. Mirrors `agent_job_items`. */
export interface BatchJobItem {
  readonly jobId: string
  readonly itemId: string
  readonly rowIndex: number
  /** Codex `source_id` — opaque provenance handle (e.g. the source CSV line or
   *  an external record id). OMITTED when the caller has none. */
  readonly sourceId?: string
  readonly rowJson: string
  status: ItemStatus
  /** Thread id of the subagent that ran (or is running) this item. Set by the
   *  runner from the dispatch result. OMITTED until first dispatch. */
  assignedThreadId?: string
  attemptCount: number
  /** The dispatched + schema-validated structured result, JSON-encoded.
   *  Present only when `status === "done"`. */
  resultJson?: string
  lastError?: string
  readonly createdAt: number
  updatedAt: number
  completedAt?: number
}

/** The structured result a {@link RowDispatchPort} returns for one row. */
export interface RowDispatchResult {
  /** Thread id of the subagent that produced this (for `assigned_thread_id`). */
  readonly threadId?: string
  /** The structured payload (already parsed from the child's final text by the
   *  composition-root adapter). Validated against the job's output schema when
   *  one is set. */
  readonly value: unknown
}

/** Closed-union dispatch / domain errors. Consumers branch on `kind`. */
export type BatchJobError =
  | { readonly kind: "invalid-spec"; readonly reason: string }
  | { readonly kind: "store-failed"; readonly reason: string }
  | { readonly kind: "job-not-found"; readonly jobId: string }
  | { readonly kind: "aborted" }

/** Per-item failure cause, recorded on the item's `lastError`. Closed union so
 *  the export + reporting code branches exhaustively. */
export type ItemFailureKind = "dispatch-failed" | "schema-rejected" | "aborted"

/**
 * Compiled output-schema validator. PORT-shaped (no zod import in the domain
 * module) — the composition root compiles the job's `outputSchemaJson` into one
 * of these (typically via `zodFromJsonish` in this slice's `schema.ts`, which
 * DOES import zod, but is wired, not domain).
 *
 * NO-THROW: returns a typed `Result`. A schema-rejected value resolves
 * `Err({kind:"schema-rejected"})`, never throws.
 */
export type RowSchemaValidator = (
  value: unknown,
) =>
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string }

/**
 * Documented default pool size. NOT used as a silent fallback — `poolSize` is a
 * REQUIRED spec field. This constant exists only so CLI / composition callers
 * have a single named default to reference. Rationale: Codex's batch worker and
 * Cursor's fan-out both default to a small bounded pool (single-digit) to keep
 * provider rate-limit pressure and local memory bounded; 4 is the midpoint that
 * both vendors land near. Documented constant, not a heuristic threshold.
 */
export const DEFAULT_POOL_SIZE = 4

/**
 * HARD ceiling on `poolSize` — the max items a job may run concurrently (GAP7-1).
 * The pump launches `slice(0, poolSize)` rows at once, so without a cap a job over
 * a 1000-row CSV would fan out 1000 simultaneous subagent loops (provider rate-
 * limit blowup + cost spike + local memory exhaustion — the DoS vector the audit
 * flagged: `poolSize ≤ MAX_SAFE_INTEGER`). 32 = 8× {@link DEFAULT_POOL_SIZE},
 * generous headroom for legitimate parallelism while keeping concurrent provider
 * pressure bounded. A safety ceiling, NOT a tuned throughput threshold; a spec
 * over it is rejected at submit (`invalid-spec`) rather than silently clamped, so
 * the caller learns its request was unsafe.
 */
export const MAX_POOL_SIZE = 32

/** A snapshot of a job + its items, returned by `await()` / `tick()`. */
export interface JobSnapshot {
  readonly job: BatchJob
  readonly items: ReadonlyArray<BatchJobItem>
}
