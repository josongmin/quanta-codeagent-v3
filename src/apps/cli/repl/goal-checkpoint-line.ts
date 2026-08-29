/**
 * GOAL-05A rail 16 — the ONE line an operator sees when an attributed goal turn
 * settles.
 *
 * The progress receipt and the `/goal` renderer both shipped in GOAL-04/05, but
 * nothing announced a settlement: progress was visible only if the operator
 * typed `/goal`. The rail was deferred "to 06/10" and neither honored it, so an
 * autonomous goal ran silently — the exact opposite of the agent-state
 * visibility this product is aiming at.
 *
 * BOUNDED AND TEXT-FREE by construction: outcome, token spend, remaining
 * criterion COUNT, objective revision and receipt count. No goal text, no
 * prompt, no criterion text, no attempt key — the same discipline the
 * observability label allowlist enforces elsewhere, so this line can never
 * become a leak channel.
 */

import type { ObjectiveSettlementNotice } from "@/host/runtime"

/** Render one checkpoint line, or `undefined` when there is nothing worth
 *  saying (a turn that neither spent nor changed anything). */
export const renderGoalCheckpointLine = (notice: ObjectiveSettlementNotice): string => {
  const remaining = notice.remainingCriterionIds.length
  const scope = notice.provenance === "user-requested-goal-work" ? "goal work" : "goal"
  return (
    `${scope}: ${notice.turnOutcome} · ${notice.tokensUsed} tok · ` +
    `${remaining === 0 ? "no criteria remaining" : `${remaining} remaining`} · ` +
    `rev ${notice.objectiveRevision} · ${notice.receiptCount} receipts\n`
  )
}

/** Build the sink the runtime calls after each settled attributed turn.
 *  `write` is the surface's stderr writer (never `console`). */
export const buildGoalCheckpointSink = (
  write: (line: string) => void,
): ((notice: ObjectiveSettlementNotice) => void) => {
  return (notice) => {
    write(renderGoalCheckpointLine(notice))
  }
}
