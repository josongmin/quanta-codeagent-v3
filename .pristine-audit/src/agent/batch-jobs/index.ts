/**
 * Batch-jobs slice barrel (ADR-0463).
 *
 * CSV batch-job runner: fan a CSV (or row list) out over subagents, one row =
 * one subagent task, collect structured results, retry failures, export a
 * results CSV. 2-vendor convergence (Codex `agent_jobs` + Cursor batch
 * fan-out).
 *
 * DEFAULT-OFF: this barrel is NOT imported by any apps/agent or apps/cli wire
 * today. A batch job runs ONLY when a caller explicitly constructs a
 * {@link BatchJobRunner} and calls `submit()` + `runToEnd()`. There is no
 * auto-trigger, env flag, or background scheduler — a deployment that never
 * touches this slice sees zero behaviour change.
 *
 * Plane-clean: the domain modules (`types`, `port`, `runner`) import only
 * `@/shared`; `csv.ts` additionally uses the vendored `csv-parse` lib;
 * `schema.ts` additionally uses zod (the ONLY runtime-zod file — the runner
 * receives a compiled validator, never imports zod). The real `SubagentRunner`
 * + sqlite store are wired into the {@link RowDispatchPort} / {@link JobStorePort}
 * at the composition root.
 */

export { type ParsedCsv, parseRowsFromCsv, renderResultsCsv } from "./csv"
export { InMemoryJobStore, type JobStorePort, type RowDispatchPort } from "./port"
export {
  BatchJobRunner,
  type Clock,
  type IdGen,
  isItemTerminal,
  type RunnerDeps,
} from "./runner"
export { compileRowSchema } from "./schema"
export {
  type BatchJob,
  type BatchJobError,
  type BatchJobItem,
  type BatchJobSpec,
  DEFAULT_POOL_SIZE,
  ITEM_STATUSES,
  type ItemFailureKind,
  type ItemStatus,
  JOB_STATUSES,
  type JobRow,
  type JobSnapshot,
  type JobStatus,
  MAX_POOL_SIZE,
  type RowDispatchResult,
  type RowSchemaValidator,
  TERMINAL_ITEM_STATUSES,
} from "./types"
