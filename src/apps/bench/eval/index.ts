/**
 * `apps/bench/eval` — single-instance evaluation sub-slice barrel.
 *
 * The public surface is intentionally narrow: the bench CLI / harness tests
 * call `runInstance` and `finalizeRun`, and may construct a `NullStream` for
 * silent runs. Internal helpers (sandbox / snapshot / verdict / env-prep /
 * report) are accessed via their individual modules.
 */

export {
  type AttemptObservation,
  finalizeRun,
  type RunObservation,
  type RunSummary,
  resolvedTotals,
} from "../observe"
export { type RunInstanceDeps, runInstance } from "./driver"
export { NullStream } from "./report"
