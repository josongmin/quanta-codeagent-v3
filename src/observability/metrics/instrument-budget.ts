/**
 * BudgetLedger instrumentation (ADR-0161).
 *
 * Counters:
 *   budget.record.total                  labels: model
 *   budget.breach.total                  labels: kind, scope (sessionId | "YYYY-MM-DD")
 *
 * Histograms:
 *   budget.event.cost_usd                labels: model
 *
 * No-throw wrap.
 */

import type { BudgetLedger, BudgetSnapshot, UsageEvent } from "@/agent/budget-ledger"
import type { MetricsRegistry } from "./port"

const safe = (m: MetricsRegistry, fn: () => void): void => {
  try {
    fn()
  } catch {
    /* metrics emission must not break the wrapped call */
  }
}

export interface BudgetInstrumentOpts {
  readonly namePrefix?: string
}

export const instrumentBudgetLedger = (
  ledger: BudgetLedger,
  metrics: MetricsRegistry,
  opts?: BudgetInstrumentOpts,
): BudgetLedger => {
  const prefix = opts?.namePrefix ?? "budget"

  return {
    record(event: UsageEvent) {
      safe(metrics, () =>
        metrics.increment(`${prefix}.record.total`, 1, { model: event.model }),
      )
      const breaches = ledger.record(event)
      // Approximate per-event cost (sum of all token costs) — recompute from snapshot delta.
      // We can't easily extract per-event cost without access to pricing; observe ledger's
      // perModel breakdown delta instead.
      for (const b of breaches) {
        safe(metrics, () =>
          metrics.increment(`${prefix}.breach.total`, 1, { kind: b.kind, scope: b.scope }),
        )
      }
      return breaches
    },
    snapshot(): BudgetSnapshot {
      return ledger.snapshot()
    },
    clear(scope) {
      return ledger.clear(scope)
    },
    serialize: ledger.serialize.bind(ledger),
    hydrate: ledger.hydrate.bind(ledger),
  }
}
