/** All host-owned activity that must be absent before an autonomous goal wake. */
export interface GoalQuiescenceSnapshot {
  readonly turnActive: boolean
  readonly planModeActive: boolean
  readonly externalPromptPending: boolean
  readonly textPending: boolean
  readonly imagePending: boolean
  readonly planPending: boolean
  readonly followupPending: boolean
  readonly approvalPending: boolean
  readonly attachingOrClosing: boolean
}

/** Pure fail-closed projection used both when arming and immediately before fire. */
export const isQuiescent = (snapshot: GoalQuiescenceSnapshot): boolean =>
  !snapshot.turnActive &&
  !snapshot.planModeActive &&
  !snapshot.externalPromptPending &&
  !snapshot.textPending &&
  !snapshot.imagePending &&
  !snapshot.planPending &&
  !snapshot.followupPending &&
  !snapshot.approvalPending &&
  !snapshot.attachingOrClosing
