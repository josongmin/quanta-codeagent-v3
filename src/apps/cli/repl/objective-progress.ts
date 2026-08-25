import {
  asObjectiveAuthority,
  type ObjectivePort,
  type ProgressReceipt,
  type ProgressTurnOutcome,
} from "@/objective"
import type { CliPromptInput } from "./prompt-types"

const outcomeFor = (reason: string | undefined): ProgressTurnOutcome => {
  if (reason === "aborted") return "aborted"
  if (reason === "completed") return "completed"
  return "error"
}

/** Capture an active objective before an agent body starts. */
export const beginObjectiveProgress = (
  objective: ObjectivePort | undefined,
  threadId: string | undefined,
  prompt: CliPromptInput,
):
  | {
      readonly threadId: string
      readonly objectiveId: string
      readonly revision: number
      readonly metIds: readonly string[]
    }
  | undefined => {
  const meta = typeof prompt === "string" ? undefined : prompt.goalContinuation
  if (objective === undefined) return undefined
  if (meta !== undefined && threadId !== undefined && meta.threadId !== threadId) return undefined
  const targetThreadId = meta?.threadId ?? threadId
  if (targetThreadId === undefined) return undefined
  const before = asObjectiveAuthority(objective).readDomain(targetThreadId)
  if (before.state?.objective.status !== "active") return undefined
  return {
    threadId: targetThreadId,
    objectiveId: before.state.objective.objectiveId,
    revision: before.revision,
    metIds: before.state.objective.successCriteria.filter((c) => c.met).map((c) => c.id),
  }
}

/** Persist the verified delta after the same body has settled. */
export const finishObjectiveProgress = (args: {
  readonly objective: ObjectivePort | undefined
  readonly prompt: CliPromptInput
  readonly started: ReturnType<typeof beginObjectiveProgress>
  readonly outcomeReason?: string
  readonly backgrounded?: boolean
}): ProgressReceipt | undefined => {
  const { objective, prompt, started } = args
  if (objective === undefined || started === undefined) return undefined
  const authority = asObjectiveAuthority(objective)
  const after = authority.readDomain(started.threadId)
  if (after.state === null) return undefined
  // GOAL-01 — a receipt never crosses a generation boundary.
  if (after.state.objective.objectiveId !== started.objectiveId) return undefined
  const met = new Set(started.metIds)
  const criteria = after.state.objective.successCriteria
  const verifierReceipts = criteria.flatMap((criterion) =>
    criterion.kind === "checked" &&
    criterion.completion?.source === "verifier" &&
    criterion.completion.verifierResult.passed
      ? [{ criterionId: criterion.id, receipt: criterion.completion }]
      : [],
  )
  const sourceDigests = [...new Set(verifierReceipts.map(({ receipt }) => receipt.sourceDigest))]
  const continuation = typeof prompt === "string" ? undefined : prompt.goalContinuation
  const receipt: ProgressReceipt = {
    objectiveId: started.objectiveId,
    attemptKey:
      continuation?.attemptKey ??
      `foreground:${started.threadId}:${started.revision}:${Date.now()}`,
    objectiveRevisionBefore: started.revision,
    objectiveRevisionAfter: after.revision,
    turnOutcome: args.backgrounded === true ? "backgrounded" : outcomeFor(args.outcomeReason),
    criterionTransitions: criteria.filter((c) => c.met && !met.has(c.id)).map((c) => c.id),
    verifierReceiptRefs: verifierReceipts.map(
      ({ criterionId, receipt }) =>
        `${criterionId}:${receipt.checkId}:${receipt.objectiveRevision}`,
    ),
    ...(sourceDigests.length === 1 ? { sourceDigest: sourceDigests[0] as string } : {}),
    remainingCriterionIds: criteria.filter((c) => !c.met).map((c) => c.id),
    recordedAt: Date.now(),
  }
  return authority.recordProgressReceipt(started.threadId, receipt) ? receipt : undefined
}
