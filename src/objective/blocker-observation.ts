import { type BlockerDependencyResolverPort, resolveBlockerDependency } from "./blocker-dependency"
import type { ObjectiveActor, ObjectiveAttemptSettlement, ObjectiveMutation } from "./mutations"
import type { ObjectiveCore } from "./store"
import type { Objective } from "./types"

type AddBlockerMutation = Extract<ObjectiveMutation, { kind: "addBlocker" }>

export type BlockerMutationResult =
  | { readonly kind: "applied"; readonly objective: Objective }
  | { readonly kind: "refused"; readonly reason: "dependency-unresolved" | "invalid" }

/** Apply immediate trusted blockers or host-attributed model observations. */
export const applyBlockerMutation = (
  core: ObjectiveCore,
  threadId: string,
  mutation: AddBlockerMutation,
  actor: ObjectiveActor,
  resolver: BlockerDependencyResolverPort | undefined,
): BlockerMutationResult => {
  if (actor !== "model" && actor !== "continuation") {
    const objective = core.addBlocker(threadId, {
      reason: mutation.reason,
      waitingOn: mutation.waitingOn,
    })
    return objective === null
      ? { kind: "refused", reason: "invalid" }
      : { kind: "applied", objective }
  }
  // GOAL P0-A — the attempt id is DOMAIN state, reserved by `beginAttempt`
  // before any paid call. Reading it here (instead of trusting `mutation.attemptId`,
  // which the tool layer could only ever fill from a per-tool-call id) is what
  // makes "three distinct attempts" mean three attempts.
  const attemptId = core.get(threadId)?.attempts.started?.attemptId
  if (mutation.target === undefined || attemptId === undefined || attemptId.length === 0) {
    return { kind: "refused", reason: "invalid" }
  }
  const resolution = resolveBlockerDependency(resolver, {
    threadId,
    attemptId,
    waitingOn: mutation.waitingOn,
    target: mutation.target,
  })
  if (resolution.kind !== "resolved") {
    return { kind: "refused", reason: "dependency-unresolved" }
  }
  const objective = core.observeBlocker(threadId, {
    dependencyId: resolution.dependencyId,
    occurrenceEvidenceId: resolution.occurrenceEvidenceId,
    reason: mutation.reason,
    waitingOn: mutation.waitingOn,
    attemptId,
  })
  return objective === null
    ? { kind: "refused", reason: "invalid" }
    : { kind: "applied", objective }
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
