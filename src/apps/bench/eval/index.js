/**
 * `apps/bench/eval` — single-instance evaluation sub-slice barrel.
 *
 * The public surface is intentionally narrow: the bench CLI / harness tests
 * call `runInstance` and `finalizeRun`, and may construct a `NullStream` for
 * silent runs. Internal helpers (sandbox / snapshot / verdict / env-prep /
 * report) are accessed via their individual modules.
 */
export { finalizeRun, resolvedTotals, } from "../observe";
export { runInstance } from "./driver";
export { NullStream } from "./report";
