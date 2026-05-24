/**
 * BudgetLedger instrumentation (ADR-0161 + ADR-0162).
 *
 * Counters:
 *   budget.record.total                  labels: model
 *   budget.breach.total                  labels: kind, scope (sessionId | "YYYY-MM-DD")
 *
 * Histograms:
 *   budget.event.cost_usd                labels: model
 *     (ADR-0162: per-event USD cost surfaced via the new 2-field RecordResult)
 *
 * No-throw wrap.
 */

import type { BudgetLedger, BudgetSnapshot, RecordResult, UsageEvent } from "@/agent/budget-ledger"
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
    record(event: UsageEvent): RecordResult {
      const result = ledger.record(event)
      safe(metrics, () =>
        metrics.increment(`${prefix}.record.total`, 1, { model: event.model }),
      )
      // ADR-0162: per-event cost histogram. `result.cost` is required on
      // every return (defensive swallow path emits cost=0).
      safe(metrics, () =>
        metrics.observe(`${prefix}.event.cost_usd`, result.cost, { model: event.model }),
      )
      for (const b of result.breaches) {
        safe(metrics, () =>
          metrics.increment(`${prefix}.breach.total`, 1, { kind: b.kind, scope: b.scope }),
        )
      }
      return result
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
