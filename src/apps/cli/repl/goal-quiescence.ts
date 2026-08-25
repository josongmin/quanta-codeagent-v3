/**
 * GOAL-06 — goal QUIESCENCE projection (CLI surface).
 *
 * Projects EXISTING live stores into one typed answer the wake controller
 * checks both before arming and immediately before enqueue: is the surface
 * quiet enough for an autonomous continuation? Nothing here owns state; every
 * probe is a closure over a live store the session loop already holds
 * (active turn ref, plan mode, external prompt queue, text inbox, background
 * turn portal, session switch, close). Probe precedence is fixed so the busy
 * reason a renderer shows is deterministic. A throwing probe counts as BUSY
 * (fail-closed: never wake into an unknown state).
 */

import type { GoalQuiescence } from "@/objective"

export interface GoalQuiescenceProbes {
  /** The thread is not idle (surface-specific idle signal). Optional. */
  readonly notIdle?: (() => boolean) | undefined
  readonly turnActive: () => boolean
  readonly planModeActive: () => boolean
  readonly approvalPending?: (() => boolean) | undefined
  readonly queuedInputPending: () => boolean
  readonly mailboxInputPending: () => boolean
  /** A partially typed local draft is waiting in the composer. Optional. */
  readonly draftPending?: (() => boolean) | undefined
  /** A detached (Ctrl+B) body is still live. Optional. */
  readonly backgroundTurnActive?: (() => boolean) | undefined
  readonly sessionSwitching?: (() => boolean) | undefined
  readonly closing?: (() => boolean) | undefined
  readonly isEphemeral: () => boolean
}

type ProbeRow = readonly [
  reason: Extract<GoalQuiescence, { quiescent: false }>["reason"],
  probe: (() => boolean) | undefined,
]

/** Fixed precedence: the FIRST busy probe names the reason. */
export const projectGoalQuiescence = (probes: GoalQuiescenceProbes): GoalQuiescence => {
  const rows: readonly ProbeRow[] = [
    ["ephemeral", probes.isEphemeral],
    ["closing", probes.closing],
    ["session-switching", probes.sessionSwitching],
    ["turn-active", probes.turnActive],
    ["background-turn", probes.backgroundTurnActive],
    ["approval-pending", probes.approvalPending],
    ["plan-mode", probes.planModeActive],
    ["queued-input", probes.queuedInputPending],
    ["mailbox-input", probes.mailboxInputPending],
    ["draft-pending", probes.draftPending],
    ["not-idle", probes.notIdle],
  ]
  for (const [reason, probe] of rows) {
    if (probe === undefined) continue
    let busy: boolean
    try {
      busy = probe() === true
    } catch {
      busy = true
    }
    if (busy) return { quiescent: false, reason }
  }
  return { quiescent: true }
}
