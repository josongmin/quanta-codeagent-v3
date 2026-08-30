import type { ObjectiveActor, ObjectiveAttemptSettlement, ObjectiveMutation } from "./mutations"
import type { ObjectiveCore } from "./store"
import type { Objective } from "./types"

type AddBlockerMutation = Extract<ObjectiveMutation, { kind: "addBlocker" }>

const dependencyRef = (mutation: AddBlockerMutation): string | null =>
  mutation.target === undefined
    ? null
    : JSON.stringify([mutation.waitingOn, mutation.target.kind, mutation.target.ref.trim()])

/** Apply immediate trusted blockers or host-attributed model observations. */
export const applyBlockerMutation = (
  core: ObjectiveCore,
  threadId: string,
  mutation: AddBlockerMutation,
  actor: ObjectiveActor,
): Objective | null => {
  if (actor !== "model" && actor !== "continuation") {
    return core.addBlocker(threadId, {
      reason: mutation.reason,
      waitingOn: mutation.waitingOn,
    })
  }
  const ref = dependencyRef(mutation)
  // GOAL P0-A — the attempt id is DOMAIN state, reserved by `beginAttempt`
  // before any paid call. Reading it here (instead of trusting `mutation.attemptId`,
  // which the tool layer could only ever fill from a per-tool-call id) is what
  // makes "three distinct attempts" mean three attempts.
  const attemptId = core.get(threadId)?.attempts.started?.attemptId
  if (ref === null || attemptId === undefined || attemptId.length === 0) return null
  return core.observeBlocker(threadId, {
    dependencyRef: ref,
    reason: mutation.reason,
    waitingOn: mutation.waitingOn,
    attemptId,
  })
}

/** Clear pending observations only after an operation actually gained progress. */
export const clearObservationsAfterProgress = (
  core: ObjectiveCore,
  threadId: string,
  result: Objective | null,
  gainedProgress: boolean,
): Objective | null => {
  if (result === null) return null
  if (gainedProgress) core.clearBlockerObservations(threadId)
  return core.get(threadId)
}

/** Compare host-captured attempt-start evidence against the current objective. */
export const settlementGainedProgress = (
  objective: Objective,
  settlement: ObjectiveAttemptSettlement,
): boolean => {
  const priorCriteria = new Set(settlement.criterionIdsBefore)
  const priorVerifierReceipts = new Set(settlement.verifierReceiptIdsBefore)
  return objective.successCriteria.some((criterion) => {
    if (criterion.met && !priorCriteria.has(criterion.id)) return true
    if (criterion.kind !== "checked" || criterion.completion?.source !== "verifier") return false
    const ref = `${criterion.id}:${criterion.completion.checkId}:${criterion.completion.objectiveRevision}`
    return !priorVerifierReceipts.has(ref)
  })
}
