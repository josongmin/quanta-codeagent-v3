/**
 * RFC-01 — pure attention resolver (`@/attention`).
 *
 * `nextNeedingAttention` picks the single agent the operator should go to next.
 * PURE + stateless: same inputs → same output, no I/O, no clock, no env.
 *
 * Two load-bearing invariants (each pinned by a red-on-injection fixture in
 * `tests/unit/attention/attention-resolver.test.ts`):
 *
 *   1. LINEAGE GATE FIRST (R2 / jul-15 sibling-leak class): only agents whose
 *      `rootId === ownRootId` are eligible. A foreign-lineage agent is NEVER
 *      selected, even when it is the globally oldest awaiting agent. The CLI's
 *      injected session-local registry is the scope; a future cross-session/web
 *      plane carries explicit session identity from its composition root.
 *
 *   2. PRIORITY DETERMINISM: among own-lineage awaiting agents, oldest-first by
 *      (askedAt, then `requestId` via `byteCompare`). v1 has only the awaiting
 *      bucket; the PARKED fuller resolver would drain awaiting fully before an
 *      unread bucket — the ordering is pinned here so that extension cannot
 *      silently invert it.
 */

import { byteCompare } from "@/shared"
import type { AttentionAgent, PendingQuestionView } from "./model"

/** An own-lineage agent narrowed to a non-null pending question. */
type AwaitingAgent = AttentionAgent & { readonly pendingQuestion: PendingQuestionView }

/**
 * The next agent needing attention for `ownRootId`, or `undefined` when nothing
 * in this lineage is awaiting input (caller shows "all caught up").
 *
 * @param agents  derived snapshot (immutable; never mutated here)
 * @param ownRootId  the caller's lineage scope — the ONLY selectable root
 * @param afterRequestId  optional cursor: advance to the awaiting agent that
 *   follows the one holding this request id. Unknown id ⇒ fall back to oldest.
 */
export const nextNeedingAttention = (
  agents: readonly AttentionAgent[],
  ownRootId: string,
  afterRequestId?: string,
): AttentionAgent | undefined => {
  const awaiting = agents
    // (1) lineage gate FIRST, then (2) the awaiting-input bucket.
    .filter((a): a is AwaitingAgent => a.rootId === ownRootId && a.pendingQuestion !== null)
    // deterministic oldest-first ordering.
    .sort(
      (a, b) =>
        a.pendingQuestion.askedAt - b.pendingQuestion.askedAt ||
        byteCompare(a.pendingQuestion.requestId, b.pendingQuestion.requestId),
    )

  if (afterRequestId === undefined) return awaiting[0]
  const idx = awaiting.findIndex((a) => a.pendingQuestion.requestId === afterRequestId)
  // Unknown cursor ⇒ oldest; otherwise the strictly-next awaiting agent.
  return idx === -1 ? awaiting[0] : awaiting[idx + 1]
}
