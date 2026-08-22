/**
 * Ledger-bridged BudgetProbe (ADR-0274).
 *
 * `createBudgetProbeFromLedger(ledger, { maxUsd })` returns a
 * `BudgetProbe` backed by a duck-typed ledger shape
 * (`{ snapshot(): { totalUsd: number } }`). The slice fence (ADR-0159)
 * forbids `@/retrieval` → `@/agent`, so we NEVER import
 * `@/agent/budget-ledger` — callers translate the real ledger's
 * `totalCost` accessor at the assembly site (one-line:
 * `{ snapshot: () => ({ totalUsd: l.snapshot().totalCost }) }`).
 *
 * Construction-time validation:
 *   - `maxUsd < 0` → throws `BudgetProbeException(invalid-budget)` so
 *     the programmer notices at construction (fail-fast); we will not
 *     silently accept an unsatisfiable budget.
 *   - `maxUsd === 0` is ALLOWED. The resulting probe always reports
 *     `remaining() === 0`; callers always trip the gate. Useful for
 *     "test that the gate fires" assemblies (HELL-BP-07).
 *
 * Call-time error surface:
 *   - `ledger.snapshot()` throws → `usdSoFar()` re-throws as
 *     `BudgetProbeException(ledger-unavailable, cause)`. The pipeline's
 *     budget-gate stage catches at its own boundary.
 *   - `ledger.snapshot()` returns a non-numeric `totalUsd` → coerced
 *     to 0 (defensive; a poisoned ledger snapshot cannot poison the
 *     probe — same posture as `budget-ledger.ts` `tokensToUsd`).
 */

import type { BudgetProbe } from "./port"
import { BudgetProbeException } from "./types"

/** Duck-typed ledger shape — the structural minimum the probe needs. */
export interface LedgerSnapshotSource {
  snapshot(): { totalUsd: number }
}

export interface FromLedgerOpts {
  readonly maxUsd: number
}

const isFiniteNonNeg = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0

export const createBudgetProbeFromLedger = (
  ledger: LedgerSnapshotSource,
  opts: FromLedgerOpts,
): BudgetProbe => {
  if (typeof opts.maxUsd !== "number" || !Number.isFinite(opts.maxUsd) || opts.maxUsd < 0) {
    throw new BudgetProbeException({
      kind: "invalid-budget",
      reason: `maxUsd must be a finite number >= 0; got ${String(opts.maxUsd)}`,
    })
  }
  const max = opts.maxUsd

  const readUsdSoFar = (): number => {
    let snap: { totalUsd: number }
    try {
      snap = ledger.snapshot()
    } catch (cause) {
      throw new BudgetProbeException({ kind: "ledger-unavailable", cause })
    }
    const t = snap?.totalUsd
    return isFiniteNonNeg(t) ? t : 0
  }

  return {
    usdSoFar(): number {
      return readUsdSoFar()
    },
    maxAllowed(): number {
      return max
    },
    remaining(): number {
      const r = max - readUsdSoFar()
      return r > 0 ? r : 0
    },
  }
}
