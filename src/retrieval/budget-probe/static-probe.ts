/**
 * Static (constant-valued) BudgetProbe (ADR-0274).
 *
 * For tests and dev sandboxing. Pure — no ledger, no I/O, no clock. The
 * returned probe wraps the two configured values; `remaining()` clamps
 * to 0 just like the ledger-bridged variant for math parity.
 *
 * `maxAllowed <= 0` is ALLOWED here (callers test boundary cases). The
 * fail-fast `invalid-budget` posture is reserved for the ledger-bridged
 * factory where the source of truth is harder to swap.
 */

import type { BudgetProbe } from "./port"

export interface StaticBudgetProbeOpts {
  readonly usdSoFar: number
  readonly maxAllowed: number
}

export const createStaticBudgetProbe = (opts: StaticBudgetProbeOpts): BudgetProbe => {
  const usd = opts.usdSoFar
  const max = opts.maxAllowed
  return {
    usdSoFar(): number {
      return usd
    },
    maxAllowed(): number {
      return max
    },
    remaining(): number {
      const r = max - usd
      return r > 0 ? r : 0
    },
  }
}
