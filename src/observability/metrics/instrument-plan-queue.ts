/**
 * PlanQueueStore instrumentation (ADR-0161).
 *
 * Counters:
 *   plan_queue.enqueue.total      labels: source, pausedReason, urgent
 *   plan_queue.drain.total        labels: drained_count_bucket ("0"|"1"|"2-5"|"6+")
 *   plan_queue.clear.total
 *
 * No-throw wrap; slice never imports `@/observability`.
 */

import type { FollowUp, PlanQueueStore } from "@/agent/plan-queue"
import type { MetricsRegistry } from "./port"

const safe = (m: MetricsRegistry, fn: () => void): void => {
  try {
    fn()
  } catch {
    /* metrics emission must not break the wrapped call */
  }
}

const bucketDrainCount = (n: number): string =>
  n === 0 ? "0" : n === 1 ? "1" : n <= 5 ? "2-5" : "6+"

export interface PlanQueueInstrumentOpts {
  readonly namePrefix?: string
}

export const instrumentPlanQueue = (
  store: PlanQueueStore,
  metrics: MetricsRegistry,
  opts?: PlanQueueInstrumentOpts,
): PlanQueueStore => {
  const prefix = opts?.namePrefix ?? "plan_queue"

  return {
    enqueue(input) {
      safe(metrics, () =>
        metrics.increment(`${prefix}.enqueue.total`, 1, {
          source: input.source,
          pausedReason: input.pausedReason,
          urgent: String(input.urgent),
        }),
      )
      return store.enqueue(input)
    },
    drain(threadId, currentTurn): ReadonlyArray<FollowUp> {
      const r = store.drain(threadId, currentTurn)
      safe(metrics, () =>
        metrics.increment(`${prefix}.drain.total`, 1, { count_bucket: bucketDrainCount(r.length) }),
      )
      return r
    },
    peek: store.peek.bind(store),
    clear(threadId) {
      const removed = store.clear(threadId)
      safe(metrics, () => metrics.increment(`${prefix}.clear.total`))
      return removed
    },
    inspect: store.inspect.bind(store),
  }
}
