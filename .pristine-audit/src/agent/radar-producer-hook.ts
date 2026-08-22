/**
 * Radar producer hook (ADR-0231 — wire phase).
 *
 * Lives in `@/agent` (NOT `@/radar` — the radar slice is a leaf below every
 * operating slice and must never import `@/agent`). This hook is the ONE
 * bridge that lets the agent loop deposit heuristic-derived proposal cards
 * into a host-wired `RadarStore` at a turn boundary.
 *
 * Conservative by design:
 *   - Fires ONLY on `flushKind === "completed"`. A turn that ended in
 *     `tools` / `aborted` / `interrupted` / `error` / `refusal` does NOT
 *     sample (mid-flight + failed turns are noise for a "next-step" radar).
 *   - Delegates the decision to `proposeOnIdleForLongTask` (the PURE
 *     heuristic). A `null` result ⇒ no card minted, no store touched.
 *   - The whole body is wrapped in try/catch: a radar bug (store throw,
 *     heuristic surprise) MUST NEVER derail the turn it observes. On error
 *     the turn completes exactly as if the hook were absent.
 *
 * Default-OFF byte-identical: the loop only calls this when
 * `AgentConfig.radar !== undefined`. Absent block ⇒ zero sampling, no
 * allocation, no clock read — the turn is byte-for-byte unchanged.
 */

import { type ProposeOpts, proposeOnIdleForLongTask, type RadarStore } from "@/radar"
import { errMessage, logger } from "@/shared"

/**
 * Session-end radar producer block (mirrors the `memoryConsolidator?`
 * "session/turn-end pure hook, absent ⇒ byte-identical" precedent).
 */
export interface RadarProducerBlock {
  /** The host-wired proposal-queue store the hook deposits cards into. */
  readonly store: RadarStore
  /** Idle threshold (ms) fed to the heuristic. */
  readonly idleThresholdMs: number
  /** Long-task threshold (ms) fed to the heuristic. */
  readonly taskDurationThresholdMs: number
  /** Injected wall-clock (epoch ms) used to stamp the proposal. Inject a
   *  fake in tests for determinism; defaults to `Date.now`. */
  readonly now?: () => number
  /** Live idle-ms source for THIS turn boundary. The host adapts its idle
   *  monitor into this getter (e.g. the CLI `IdleMonitor`). Returning `0`
   *  (or a value below `idleThresholdMs`) ⇒ the heuristic declines. Absent
   *  ⇒ treated as `0` (never idle ⇒ never proposes — a missing idle source
   *  silently disables the heuristic rather than firing spuriously). */
  readonly idleMsForTurn?: () => number
}

export interface MaybeProposeRadarCardArgs {
  /** Wall-clock duration of the turn that just finished (ms). */
  readonly lastTaskDurationMs: number
  /** Optional override for the idle-ms reading (tests). When omitted the
   *  block's `idleMsForTurn` getter is consulted. */
  readonly idleMs?: number
  /** Session id to anchor the proposal to (carried onto the card). */
  readonly sessionId?: string
  /** The terminal kind of the turn the loop just flushed. */
  readonly flushKind: "tools" | "completed" | "aborted" | "interrupted" | "error" | "refusal"
}

/**
 * Sample the idle/long-task heuristic at a turn boundary and, when it
 * fires, mint a card on the wired store. Returns the minted card's id (for
 * tests / observability) or `null` when nothing was proposed.
 *
 * NEVER throws — a radar fault is logged and swallowed.
 */
export const maybeProposeRadarCard = (
  block: RadarProducerBlock,
  args: MaybeProposeRadarCardArgs,
): string | null => {
  // Conservative: only completed turns are eligible.
  if (args.flushKind !== "completed") return null
  try {
    const now = (block.now ?? Date.now)()
    const idleMs = args.idleMs ?? block.idleMsForTurn?.() ?? 0
    const proposal: ProposeOpts | null = proposeOnIdleForLongTask({
      idleMs,
      lastTaskDurationMs: args.lastTaskDurationMs,
      idleThresholdMs: block.idleThresholdMs,
      taskDurationThresholdMs: block.taskDurationThresholdMs,
      nowMs: now,
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    })
    if (proposal === null) return null
    const card = block.store.proposeCard(proposal)
    return card.id
  } catch (e) {
    // A radar bug must never derail the turn — log + swallow.
    logger.warn(`radar-producer-hook: proposeCard suppressed: ${errMessage(e)}`)
    return null
  }
}
