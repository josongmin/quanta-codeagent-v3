/**
 * Playbook composition-root wire helper (ADR-0240).
 *
 * Bridges `AgentConfig.playbookTrigger` (defined in `@/agent/types`) and the
 * `startPlaybookAutoDispatch` orchestrator, AND adapts a real
 * `PlanQueueStore.enqueue(...)` to the {@link PlaybookPlanQueueSink} shape
 * the dispatcher expects. The host's composition-root (`apps/agent/index.ts`,
 * REPL bootstrap, ci-bot wiring) calls one of the two helpers below:
 *
 *   - {@link startPlaybookFromTrigger} — when the host has ALREADY built a
 *     `playbookTrigger` slot (whatever shape; same as the AgentConfig slot
 *     defined in `@/agent/types`). One-line wire.
 *   - {@link adaptPlanQueueStoreToSink} — adapt a `PlanQueueStore` instance
 *     to the dispatcher's smaller {@link PlaybookPlanQueueSink} port. Use
 *     this when the host has a real `PlanQueueStore` and wants the
 *     dispatcher to enqueue follow-ups for the next-turn drain.
 *
 * Slice posture: leaf-level. Imports `./auto-dispatch`, `./port`, and types
 * from `@/agent/plan-queue` ONLY. Does NOT import the loop (`@/agent`
 * boundary on `loop.ts` is OFF-LIMITS for this slice — the wire-up MUST be
 * inert at session-start when `enabled !== true`).
 *
 * Default-OFF contract: when {@link PlaybookAutoDispatchInput.enabled} is
 * not `true`, {@link startPlaybookFromTrigger} returns the orchestrator's
 * NOOP controller (`active() === 0`, `stop()` is a no-op) — same shape as
 * a real run, byte-identical observable behavior. The composition root may
 * always call this helper; the gating is here.
 */

import { errMessage } from "@/shared"
import type { PlanQueueStore } from "../../agent/plan-queue"
import {
  type PlaybookAutoDispatchController,
  type PlaybookFollowUpInput,
  type PlaybookPlanQueueSink,
  type PlaybookRegistry,
  startPlaybookAutoDispatch,
} from "./auto-dispatch"
import type { InlineTriggerWatcherPort } from "./port"

/** Input shape mirrors the `AgentConfig.playbookTrigger` slot (defined in
 *  `@/agent/types`) — kept in sync structurally so a host can pass the slot
 *  verbatim. Defined here (rather than importing from `@/agent/types`) to
 *  keep this slice off the `@/agent` boundary. */
export interface PlaybookAutoDispatchInput {
  readonly watcher: InlineTriggerWatcherPort
  readonly enabled?: boolean
  readonly registry?: PlaybookRegistry
  readonly planQueueSink?: PlaybookPlanQueueSink
  readonly debounceMs?: number
  readonly watchGlobs?: readonly string[]
  /** Thread id stamped on every enqueued follow-up. Hosts that have a
   *  session id pass it through here; absent ⇒ the dispatcher uses
   *  `"default"` so the follow-up routes to the unique session. */
  readonly threadId?: string
  /** Optional fs root override (default: process.cwd() at start time). */
  readonly defaultRoot?: string
}

/** Default thread id when the host did not supply one. Keeps a single-
 *  session host wired without forcing the operator to materialize a thread
 *  id at every call site. */
const DEFAULT_THREAD_ID = "default"

/** Bridge a host's `playbookTrigger` slot to the orchestrator. Default-OFF
 *  byte-identical: when `enabled !== true` or the slot is absent, returns
 *  the orchestrator's NOOP controller and never starts the watcher. */
export const startPlaybookFromTrigger = (
  input: PlaybookAutoDispatchInput | undefined,
): PlaybookAutoDispatchController => {
  if (input === undefined) {
    return startPlaybookAutoDispatch({
      enabled: false,
      watcher: NOOP_WATCHER,
      registry: EMPTY_REGISTRY,
      threadId: DEFAULT_THREAD_ID,
    })
  }
  // Build the orchestrator opts with conditional spreads so
  // `exactOptionalPropertyTypes` never sees a literal `undefined`.
  const opts: Parameters<typeof startPlaybookAutoDispatch>[0] = {
    enabled: input.enabled === true,
    watcher: input.watcher,
    registry: input.registry ?? EMPTY_REGISTRY,
    threadId: input.threadId ?? DEFAULT_THREAD_ID,
  }
  if (input.planQueueSink !== undefined) {
    ;(opts as { planQueueSink?: PlaybookPlanQueueSink }).planQueueSink = input.planQueueSink
  }
  if (input.debounceMs !== undefined) {
    ;(opts as { debounceMs?: number }).debounceMs = input.debounceMs
  }
  if (input.watchGlobs !== undefined) {
    ;(opts as { watchGlobs?: readonly string[] }).watchGlobs = input.watchGlobs
  }
  if (input.defaultRoot !== undefined) {
    ;(opts as { defaultRoot?: string }).defaultRoot = input.defaultRoot
  }
  return startPlaybookAutoDispatch(opts)
}

/** Adapt a real {@link PlanQueueStore} to the dispatcher's narrower
 *  {@link PlaybookPlanQueueSink} port. The store's `enqueue` accepts a
 *  richer `FollowUp`-shaped input (with `pausedReason` /
 *  `arrivedDuringTurn` / `urgent`); we synthesize sensible defaults for the
 *  fields the dispatcher cannot know:
 *
 *    - `pausedReason: "other"` — the inline trigger fires from a saved file
 *      while a turn is in flight, but the dispatcher has no visibility into
 *      WHY the turn was paused (it's a side-channel, not a turn-state
 *      observer). `"other"` is the explicit "no info" sentinel.
 *    - `arrivedDuringTurn: 0` — same reason. `0` is the canonical "before
 *      any in-flight turn knowledge" value.
 *    - `urgent: false` — playbook auto-dispatch is by definition author-
 *      controlled background routing; the operator did not flag it urgent.
 *
 *  The store's `enqueue` may THROW (it's not a typed sink — it returns an
 *  `EnqueueResult`); we catch and surface as `{ok:false, reason}` so the
 *  dispatcher's no-throw contract holds. */
export const adaptPlanQueueStoreToSink = (store: PlanQueueStore): PlaybookPlanQueueSink => ({
  enqueue: (input: PlaybookFollowUpInput): { ok: true } | { ok: false; reason: string } => {
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
      return { ok: false, reason: errMessage(e) }
    }
  },
})

// ─── Internal NOOP fallbacks (only used when the host did not supply a
//     `playbookTrigger` slot at all — the orchestrator still wants a
//     watcher + registry to satisfy its typed shape, but with
//     `enabled: false` neither is read). ────────────────────────────────

const EMPTY_REGISTRY: PlaybookRegistry = {
  list: () => [],
}

const NOOP_WATCHER: InlineTriggerWatcherPort = {
  start: () => ({
    ok: true,
    handle: {
      stop: () => {
        /* noop */
      },
      isStopped: () => true,
    },
  }),
}
