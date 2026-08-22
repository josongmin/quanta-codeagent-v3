/**
 * Preset: budget-aware gate around an arbitrary inner stage. ADR-0265 §4 #5.
 *
 * The gate consults a caller-injected `BudgetProbe.usdSoFar()` BEFORE the
 * inner stage runs. If `usdSoFar >= maxUsd` the pipeline short-circuits with
 * Err("budget-exceeded"). The integration with `defaultBudgetLedger()`
 * (@/agent/budget-ledger, ADR-0136) is the caller's responsibility — slice
 * fence forbids @/retrieval ↔ @/agent imports, so we accept a duck-typed
 * port.
 */

import { compose } from "./compose"
import type { BudgetProbe, SearchPipeline, Stage } from "./types"

export interface BudgetAwareOpts {
  readonly inner: Stage
  readonly maxUsd: number
  readonly probe: BudgetProbe
}

export const budgetAwarePipeline = (opts: BudgetAwareOpts): SearchPipeline =>
  compose([
    {
      kind: "budget-gate",
      maxUsd: opts.maxUsd,
      probe: opts.probe,
      inner: opts.inner,
    },
  ])
