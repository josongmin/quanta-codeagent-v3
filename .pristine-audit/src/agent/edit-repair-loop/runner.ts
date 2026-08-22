/**
 * Edit-repair-loop runner (ADR-0472).
 *
 * The gate (`editRepairLoopEnabled`) and the bounded repair loop
 * (`runRepairLoop`). The loop re-drives an INJECTED fast edit model until the
 * INJECTED check goes green, bounded by `maxIters`. Every failure path — port
 * throw, model decline, abort, bad config — collapses to a typed
 * `RepairLoopReport` (NO-THROW). DEFAULT-OFF: callers gate the whole loop on
 * `editRepairLoopEnabled` so the OFF path never references the ports.
 *
 * Slices imported: `@/shared` ONLY (errMessage). No `@/llm`, no sibling slice.
 */

import { errMessage, gateOnStrict } from "@/shared"
import type {
  RepairAttempt,
  RepairFailure,
  RepairIterationLog,
  RepairLoopConfig,
  RepairLoopDeps,
  RepairLoopReport,
  RepairStopReason,
} from "./types"
import { EDIT_REPAIR_LOOP_ENV } from "./types"

/**
 * Pure gate check. `true` ⇒ the repair loop is opted in for this deployment.
 * Reads ONLY the injected env record (never `process.env` — slice boundary).
 * Strict `=== "1"` so an accidental `"0"`/`"true"`/`"on"` keeps it OFF.
 */
export const editRepairLoopEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  gateOnStrict(env, EDIT_REPAIR_LOOP_ENV)

/** Build the terminal report. Centralised so every exit path is consistent. */
const report = (
  cfg: RepairLoopConfig,
  green: boolean,
  stop: RepairStopReason,
  iterations: readonly RepairIterationLog[],
): RepairLoopReport => ({
  file: cfg.file,
  checkKind: cfg.checkKind,
  green,
  stop,
  attempts: iterations.length,
  iterations,
})

/**
 * Run the bounded repair loop.
 *
 * Sequence:
 *   1. Validate `maxIters` (≥ 1) — else `invalid-config` give-up.
 *   2. Run the check. Already green ⇒ `green` with 0 attempts.
 *   3. For each iteration up to `maxIters`: hand the current failure +
 *      per-loop custom instructions to the repair reactor; if it didn't apply
 *      an edit ⇒ `model-declined` give-up; else re-run the check; green ⇒ done.
 *   4. Exhausting all iterations while still failing ⇒ `exhausted` give-up.
 *
 * Abort is honoured before every port call. All port throws are caught.
 */
export const runRepairLoop = async (
  cfg: RepairLoopConfig,
  deps: RepairLoopDeps,
  signal?: AbortSignal,
): Promise<RepairLoopReport> => {
  const iterations: RepairIterationLog[] = []

  const badConfig = validateConfig(cfg, iterations)
  if (badConfig !== null) return badConfig

  if (signal?.aborted === true) {
    return report(cfg, false, { kind: "aborted" }, iterations)
  }

  // Initial check.
  const first = await runCheck(deps, signal)
  if (!first.ok) {
    return report(cfg, false, { kind: "check-error", error: first.error }, iterations)
  }
  if (first.value === null) {
    // Already green before any repair.
    return report(cfg, true, { kind: "green" }, iterations)
  }

  let failure: RepairFailure = first.value

  for (let i = 0; i < cfg.maxIters; i++) {
    if (signal?.aborted) {
      return report(cfg, false, { kind: "aborted" }, iterations)
    }

    // Ask the fast model for ONE repaired edit (throws caught inside).
    const attempt = await runReactor(cfg, deps, failure, i, signal)
    iterations.push({ iteration: i, failure, attempt })

    if (attempt.applied !== true) {
      return report(cfg, false, { kind: "model-declined" }, iterations)
    }

    if (signal?.aborted) {
      return report(cfg, false, { kind: "aborted" }, iterations)
    }

    // Re-run the check after the applied edit.
    const next = await runCheck(deps, signal)
    if (!next.ok) {
      return report(cfg, false, { kind: "check-error", error: next.error }, iterations)
    }
    if (next.value === null) {
      return report(cfg, true, { kind: "green" }, iterations)
    }
    failure = next.value
  }

  // Ran out of iterations while still failing.
  return report(cfg, false, { kind: "exhausted" }, iterations)
}

/** Guard `maxIters` (integer ≥ 1). Returns an `invalid-config` report when bad,
 *  else null. No magic number — the contract is "at least one attempt". */
const validateConfig = (
  cfg: RepairLoopConfig,
  iterations: readonly RepairIterationLog[],
): RepairLoopReport | null => {
  if (Number.isInteger(cfg.maxIters) && cfg.maxIters >= 1) return null
  return report(
    cfg,
    false,
    {
      kind: "invalid-config",
      error: `maxIters must be an integer ≥ 1 (got ${String(cfg.maxIters)})`,
    },
    iterations,
  )
}

/** Invoke the reactor port for one iteration, catching throws into a typed
 *  `applied:false` attempt (NO-THROW). */
const runReactor = async (
  cfg: RepairLoopConfig,
  deps: RepairLoopDeps,
  failure: RepairFailure,
  iteration: number,
  signal?: AbortSignal,
): Promise<RepairAttempt> => {
  try {
    return await deps.reactor(
      {
        file: cfg.file,
        failure,
        customInstructions: cfg.customInstructions ?? "",
        iteration,
      },
      signal,
    )
  } catch (e) {
    return { applied: false, rationale: `repair reactor threw: ${errMessage(e)}` }
  }
}

/** Invoke the check port, catching throws into a typed error Result. */
const runCheck = async (
  deps: RepairLoopDeps,
  signal?: AbortSignal,
): Promise<{ ok: true; value: RepairFailure | null } | { ok: false; error: string }> => {
  try {
    const r = await deps.check(signal)
    if (r.ok) return { ok: true, value: r.value }
    return { ok: false, error: r.error }
  } catch (e) {
    return { ok: false, error: `check port threw: ${errMessage(e)}` }
  }
}
