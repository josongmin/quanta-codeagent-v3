/**
 * RFC-01 — attention state model (DERIVED, leaf, pure).
 *
 * `@/attention` is a PURE leaf: it imports no `@/agent` / `@/subagent` /
 * `@/session` value (structural-mirror discipline, same as
 * `activity/producers/fleet.ts`). The A3 bridge (`@/agent/attention`) DERIVES an
 * `AttentionAgent[]` snapshot by joining the live `TaskRegistry` with the
 * `UserQuestionBroker` and hands it to {@link nextNeedingAttention}. This leaf
 * never reads a registry, a broker, a clock, or `process.env`.
 *
 * v1 minimal slice = awaiting-input only (RFC-01 §Design.1, _review-01 §D). The
 * PARKED fuller model (unread + per-viewer focus cursor) is a follow-up RFC; the
 * priority ordering here is pinned so that extension cannot silently invert it.
 */

/** The pending question a derived agent row is blocked on, if any. Mirrors the
 *  render-relevant subset of `@/session/user-question`'s `PendingQuestion`
 *  (opaque `requestId` + `askedAt` for ordering + a bounded `summary` preview) —
 *  duck-declared here so the leaf stays isolated. */
export interface PendingQuestionView {
  /** Opaque response-correlation key — the ONLY routing authority. */
  readonly requestId: string
  /** When the question was asked (ordering key). */
  readonly askedAt: number
  /** Bounded, secret-scrubbed preview for display. */
  readonly summary: string
}

/** One derived agent row the resolver ranks. `rootId` is the lineage scope key
 *  (derived by the A3 bridge from the existing `parentTaskId`/`depth` chain);
 *  the resolver's lineage gate keys on it to prevent the jul-15 sibling leak. */
export interface AttentionAgent {
  readonly id: string
  readonly label: string
  /** Lineage root this agent belongs to. The resolver only ever selects an
   *  agent whose `rootId` equals the caller's `ownRootId`. */
  readonly rootId: string
  /** The awaiting question, or `null` when the agent is not blocked on input. */
  readonly pendingQuestion: PendingQuestionView | null
}
