/**
 * ADR-0440 — canvas usage source (web-daemon side).
 *
 * Adapts the agent loop's `onPromptAssembled` seam into a subscribe-able
 * `CanvasUsageSource` the server's per-connection canvas emitter reads. It maps
 * each `PromptAssembledSnapshot` through the loop's OWN token estimator
 * (`buildUsageBreakdownDefault`, bound to `estimateTokens`) into the
 * `ContextUsageBreakdown` shape — the EXACT computation the CLI `/context` slash
 * uses (see `repl/context-usage-snapshot.ts`). NO second token heuristic is
 * introduced: the breakdown module owns the single estimator.
 *
 * Default-OFF: the composition root only constructs this when
 * `QUANTA_WEB_CANVAS=1`. Absent that, `onPromptAssembled` is never wired ⇒ no
 * view is ever produced ⇒ no `context.usage` frame ⇒ chat UI unchanged.
 *
 * Slice fence: imports the breakdown helpers from `@/agent/context` (type +
 * the estimator-bound default builder) and the view type from the CLI
 * status-line. NO daemon-internal coupling.
 */

import {
  buildUsageBreakdownDefault,
  type ContextUsageBreakdown,
  type PromptAssembledSnapshot,
  snapshotToBreakdownInput,
} from "@/agent/context/usage-breakdown"

export interface CanvasUsageSourceHandle {
  /** Wire into `AgentConfig.onPromptAssembled`. Computes + fans out the view. */
  readonly sink: (snapshot: PromptAssembledSnapshot) => void
  /** Subscribe to subsequent views. Returns an unsubscribe closure. */
  readonly subscribe: (handler: (view: ContextUsageBreakdown) => void) => () => void
  /** The most recent view, or undefined before the first turn. */
  readonly latest: () => ContextUsageBreakdown | undefined
}

/** Create a fresh canvas usage source. One per daemon (shared across the
 *  daemon's connections, like the shared session). */
export const createCanvasUsageSource = (): CanvasUsageSourceHandle => {
  let latest: ContextUsageBreakdown | undefined
  const subscribers = new Set<(view: ContextUsageBreakdown) => void>()
  return {
    sink: (snapshot) => {
      // Same computation the CLI `/context` slash uses — `buildUsageBreakdownDefault`
      // is bound to the loop's own `estimateTokens`. NO second token heuristic.
      const view = buildUsageBreakdownDefault(snapshotToBreakdownInput(snapshot))
      latest = view
      for (const fn of subscribers) {
        try {
          fn(view)
        } catch {
          // A throwing subscriber must not break the fan-out to siblings.
        }
      }
    },
    subscribe: (handler) => {
      subscribers.add(handler)
      return () => {
        subscribers.delete(handler)
      }
    },
    latest: () => latest,
  }
}
