import { clearObservationsAfterProgress } from "./blocker-observation"
import { isStrictVerifierExecutionPosture } from "./criteria/model"
import { checkPassed, MAX_CHECKS_PER_BATCH, type VerificationBatch } from "./criteria/ports"
import type { ObjectiveActor } from "./mutations"
import type { CommitRejection } from "./ports"
import type { ObjectiveCore } from "./store"
import type { Objective } from "./types"

export type VerificationBatchApplication =
  | { readonly kind: "applied"; readonly result: Objective }
  | { readonly kind: "rejected"; readonly reason: CommitRejection }

export interface VerificationBatchContext {
  readonly actor: ObjectiveActor
  readonly revision: number
  readonly now: number
}

interface PlannedResult {
  readonly criterionId: string
  readonly passed: boolean
  readonly exitCode: number | null
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0

/** Validate the entire batch before touching the core (all-or-nothing). */
const planVerificationBatch = (
  current: Objective,
  batch: VerificationBatch,
  revision: number,
): PlannedResult[] | CommitRejection => {
  if (batch === null || typeof batch !== "object" || !Array.isArray(batch.results)) return "invalid"
  if (batch.objectiveId !== current.objectiveId) return "objective-mismatch"
  if (batch.expectedRevision !== revision) return "stale"
  if (!isNonEmptyString(batch.sourceDigest) || batch.results.length > MAX_CHECKS_PER_BATCH) {
    return "invalid"
  }
  if (!isStrictVerifierExecutionPosture(batch.executionPosture)) return "invalid"
  const plan: PlannedResult[] = []
  for (const result of batch.results) {
    const criterion = current.successCriteria.find((item) => item.id === result.criterionId)
    if (
      criterion === undefined ||
      criterion.kind !== "checked" ||
      criterion.check.id !== result.checkId
    ) {
      return "invalid"
    }
    plan.push({
      criterionId: criterion.id,
      passed: checkPassed(criterion.check, result),
      exitCode: result.exitCode,
    })
  }
  return plan
}

const applyPlannedResult = (
  core: ObjectiveCore,
  threadId: string,
  current: Objective,
  batch: VerificationBatch,
  context: VerificationBatchContext,
  planned: PlannedResult,
  prior: Objective,
): Objective => {
  const criterion = current.successCriteria.find((item) => item.id === planned.criterionId)
  if (criterion === undefined || criterion.kind !== "checked") return prior
  return planned.passed
    ? (core.applyVerifierCompletion(threadId, criterion.id, {
        source: "verifier",
        objectiveId: current.objectiveId,
        checkId: criterion.check.id,
        objectiveRevision: context.revision,
        sourceDigest: batch.sourceDigest,
        executionPosture: batch.executionPosture,
        verifierResult: { exitCode: planned.exitCode ?? -1, passed: true },
        verifiedAt: Number.isFinite(batch.verifiedAt) ? batch.verifiedAt : context.now,
      }) ?? prior)
    : (core.resetCheckedCriterion(threadId, criterion.id) ?? prior)
}

/** Apply a verifier batch only after identity, revision and posture validation. */
export const applyVerificationBatchMutation = (
  core: ObjectiveCore,
  threadId: string,
  batch: VerificationBatch,
  context: VerificationBatchContext,
): VerificationBatchApplication => {
  if (context.actor !== "verifier") return { kind: "rejected", reason: "actor-forbidden" }
  const current = core.get(threadId)
  if (current === null) return { kind: "rejected", reason: "objective-missing" }
  const plan = planVerificationBatch(current, batch, context.revision)
  if (typeof plan === "string") return { kind: "rejected", reason: plan }
  const gainedProgress = plan.some(
    ({ criterionId, passed }) =>
      passed &&
      current.successCriteria.find((criterion) => criterion.id === criterionId)?.met !== true,
  )
  let result: Objective = current
  for (const planned of plan) {
    result = applyPlannedResult(core, threadId, current, batch, context, planned, result)
  }
  return {
    kind: "applied",
    result: clearObservationsAfterProgress(core, threadId, result, gainedProgress) ?? result,
  }
}
