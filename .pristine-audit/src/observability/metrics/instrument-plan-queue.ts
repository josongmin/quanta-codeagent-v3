/**
 * PlanQueueStore instrumentation (ADR-0161 + ADR-0167 + ADR-0221 mutators).
 *
 * Counters:
 *   plan_queue.enqueue.total            labels: source, pausedReason, urgent
 *   plan_queue.enqueue.collapsed.total  (no labels — keep cardinality low)
 *   plan_queue.drain.total              labels: drained_count_bucket ("0"|"1"|"2-5"|"6+")
 *   plan_queue.clear.total
 *   plan_queue.mutate.total             labels: op ("retry"|"edit"|"delete"|"sendNow"), outcome ("ok"|<error>)
 *
 * ADR-0167: `enqueue.total` fires for every enqueue ATTEMPT (collapsed or
 * not — it measures attempts, not commits). `enqueue.collapsed.total`
 * fires only when the call collapsed into an existing live entry. The
 * collapse rate is therefore `collapsed.total / enqueue.total`.
 *
 * ADR-0221: every per-msg mutator (retry/edit/delete/sendNow) emits one
 * counter with the outcome label so operators can spot e.g. a sendNow
 * sink that's silently rejecting (send-not-possible spike).
 *
 * No-throw wrap; slice never imports `@/observability`.
 */

import type { FollowUp, PlanQueueStore } from "@/agent/plan-queue"
import type { MetricsRegistry } from "./port"

const safe = (_m: MetricsRegistry, fn: () => void): void => {
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
      const result = store.enqueue(input)
      if (result.collapsed) {
        safe(metrics, () => metrics.increment(`${prefix}.enqueue.collapsed.total`))
      }
      return result
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

    // ─── ADR-0221 per-msg mutators ──────────────────────────────────
    // Each emits one counter with `op` + `outcome` labels. `outcome` is
    // either "ok" (success) or the typed error string so a dashboard can
    // chart e.g. sendNow.send-not-possible to detect a misconfigured sink.

    findEntry: store.findEntry.bind(store),
    retry(entryId) {
      const r = store.retry(entryId)
      safe(metrics, () =>
        metrics.increment(`${prefix}.mutate.total`, 1, {
          op: "retry",
          outcome: r.ok ? "ok" : r.error,
        }),
      )
      return r
    },
    edit(entryId, newText) {
      const r = store.edit(entryId, newText)
      safe(metrics, () =>
        metrics.increment(`${prefix}.mutate.total`, 1, {
          op: "edit",
          outcome: r.ok ? "ok" : r.error,
        }),
      )
      return r
    },
    delete(entryId) {
      const r = store.delete(entryId)
      safe(metrics, () =>
        metrics.increment(`${prefix}.mutate.total`, 1, {
          op: "delete",
          outcome: r.ok ? "ok" : r.error,
        }),
      )
      return r
    },
    sendNow(entryId) {
      const r = store.sendNow(entryId)
      safe(metrics, () =>
        metrics.increment(`${prefix}.mutate.total`, 1, {
          op: "sendNow",
          outcome: r.ok ? "ok" : r.error,
        }),
      )
      return r
    },
  }
}
