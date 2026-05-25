/**
 * ADR-0241 — host adapters bridging the playbook auto-dispatch slice to the
 * agent's `PlanQueueStore`. Default-OFF, no-throw, pure adapter functions.
 *
 * Why a separate file: the auto-dispatch slice stays plane-clean (zero
 * `@/agent` imports). This file is the explicit bridge — when a host wires
 * the playbook trigger, it imports `adaptPlanQueueStoreToSink` to convert
 * the real `PlanQueueStore.enqueue` into the structural
 * `PlaybookPlanQueueSink` shape, and `startPlaybookFromTrigger` as the
 * idempotent NOOP-safe controller factory.
 */

import type { PlanQueueStore } from "@/agent/plan-queue"
import {
  type PlaybookAutoDispatchController,
  type PlaybookAutoDispatchOptions,
  type PlaybookPlanQueueSink,
  startPlaybookAutoDispatch,
} from "./auto-dispatch"

/** Wrap a real {@link PlanQueueStore} into the structural
 *  {@link PlaybookPlanQueueSink} shape the auto-dispatch slice expects.
 *  All required `FollowUp` defaults that the trigger flow doesn't carry
 *  (`pausedReason`, `arrivedDuringTurn`, `urgent`) are stamped here so
 *  `dispatchPlaybook` callers don't need to know about queue internals.
 *
 *  No-throw: store.enqueue throwing surfaces as `{ ok: false, reason }`. */
export const adaptPlanQueueStoreToSink = (store: PlanQueueStore): PlaybookPlanQueueSink => ({
  enqueue: (input) => {
    try {
      store.enqueue({
        threadId: input.threadId,
        text: input.text,
        source: input.source,
        pausedReason: "other",
        arrivedDuringTurn: 0,
        urgent: false,
        metadata: input.metadata,
      })
      return { ok: true }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      return { ok: false, reason }
    }
  },
})

/** Idempotent NOOP-safe controller factory. When `opts` is `undefined` (host
 *  did not wire `playbookTrigger`), returns an inert controller whose
 *  `active()` / `dispatchCount()` always return 0 and whose `stop()` is a
 *  no-op. Otherwise delegates to {@link startPlaybookAutoDispatch}. */
export const startPlaybookFromTrigger = (
  opts: PlaybookAutoDispatchOptions | undefined,
): PlaybookAutoDispatchController => {
  if (opts === undefined) {
    return {
      active: () => 0,
      dispatchCount: () => 0,
      stop: () => {
        /* noop */
      },
    }
  }
  return startPlaybookAutoDispatch(opts)
}
