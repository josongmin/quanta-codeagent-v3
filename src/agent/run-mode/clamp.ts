/**
 * Dial clamping — propositional only.
 *
 * `clampDials(dials, caps)` returns a new `BudgetDials` whose every set field
 * is `min(dials[k], caps[k])`. When a cap binds (i.e. requested > cap), a
 * `[budget-cap]` log line is emitted via `@/shared` logger so the operator
 * sees the clamp — silent clamping is forbidden by the run-mode contract
 * (RFC §8.3, §6 decision).
 *
 * NO numerical literals in this file. The comparison is purely `requested >
 * cap` against caller-supplied values.
 */

import { logger } from "@/shared"
import type { BudgetClampEvent } from "../budget/events"
import { makeClampEvent } from "../budget/events"
import type { BudgetCaps, BudgetDials } from "../budget/types"

/** Field names common to `BudgetDials` and `BudgetCaps`. */
const DIAL_FIELDS = [
  "maxTurns",
  "maxWallClockMs",
  "maxModelCalls",
  "maxToolCalls",
  "maxShellCommands",
  "maxTestRuns",
  "maxInputTokens",
  "maxOutputTokens",
  "maxReasoningTokens",
  "maxTotalTokens",
  "maxCostUsd",
  "maxCostPerTurnUsd",
  "maxFilesChanged",
  "maxPatchBytes",
  "maxRetries",
  "maxConsecutiveFailures",
  "compactionTokenThreshold",
] as const satisfies readonly (keyof BudgetDials)[]
// Drift guard, BOTH directions. `satisfies` proves every DIAL_FIELDS entry is a
// BudgetDials key; this Assert proves the REVERSE (every key is listed). Without
// it, adding a dial to BudgetDials but forgetting it here means that dial is
// NEVER clamped against its cap — a silent budget-bypass (a safety property, not
// cosmetic). Add a dial, forget the array → build error.
type _AssertDial<T extends true> = T
export type _DialFieldsDriftGuard = _AssertDial<
  keyof BudgetDials extends (typeof DIAL_FIELDS)[number] ? true : false
>

/** Treat a NaN / ±Infinity / negative value as "not a valid dial". Dials are
 *  all non-negative finite budgets; a non-finite or negative requested/cap is a
 *  programmer/config error that, if let through, would either propagate `NaN`
 *  into the meter's comparisons (silently disabling the gate — see
 *  `budget/meter.ts#tick`) or set a nonsensical negative budget. Mirror the
 *  `Number.isFinite` guard pattern: a bad value is dropped (treated as absent)
 *  rather than clamped to it. */
const isValidDial = (n: number | undefined): n is number =>
  n !== undefined && Number.isFinite(n) && n >= 0

/** Resolve one (requested, cap) pair into the effective value + clamp signal.
 *  Pure — no I/O. Non-finite / negative requested or cap values are treated as
 *  absent (defensive: see {@link isValidDial}). */
const resolveDial = (
  requested: number | undefined,
  cap: number | undefined,
): { value: number | undefined; clamped: boolean } => {
  // Defensive normalization: collapse any invalid (NaN/±Inf/negative) input to
  // `undefined` so the propositional logic below never sees a poison value.
  const req = isValidDial(requested) ? requested : undefined
  const c = isValidDial(cap) ? cap : undefined
  if (req === undefined && c === undefined) return { value: undefined, clamped: false }
  if (req === undefined) return { value: c, clamped: false }
  if (c === undefined) return { value: req, clamped: false }
  if (req > c) return { value: c, clamped: true }
  return { value: req, clamped: false }
}

/**
 * Clamp every set dial against the corresponding cap. Pure function — emits
 * a SURFACE log line for each clamp (operator-visible). Returns a fresh
 * object; the inputs are never mutated.
 *
 * The optional `onClamp` callback is invoked with a structured event for each
 * clamp — useful for tests + trajectory emission. Independent of the log
 * line.
 */
export const clampDials = (
  dials: BudgetDials,
  caps: BudgetCaps,
  onClamp?: (event: BudgetClampEvent) => void,
): BudgetDials => {
  const out: BudgetDials = {}
  for (const field of DIAL_FIELDS) {
    const requested = dials[field]
    const cap = caps[field]
    const { value, clamped } = resolveDial(requested, cap)
    if (value !== undefined) out[field] = value
    if (clamped && requested !== undefined && cap !== undefined) {
      logger.warn(`[budget-cap] ${field} clamped: requested=${requested} cap=${cap}`, {
        dial: field,
        requested,
        cap,
      })
      onClamp?.(makeClampEvent(field, requested, cap))
    }
  }
  return out
}

/** Test-only: enumerate the field list (used by clamp tests). */
export const __TEST_DIAL_FIELDS = DIAL_FIELDS
