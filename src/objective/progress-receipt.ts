/** Bounded, text-free evidence checkpoint for an autonomous objective attempt.
 *
 *  GOAL-01: every receipt is bound to the `objectiveId` generation it was
 *  produced against; the authority refuses a receipt whose id is not the live
 *  objective's, so evidence never migrates across `replace`/`clear`. */
export const MAX_PROGRESS_RECEIPTS = 16
export const MAX_PROGRESS_REFS = 32
export const MAX_PROGRESS_REF_LENGTH = 512

export type ProgressTurnOutcome = "completed" | "aborted" | "error" | "backgrounded"

export interface ProgressReceipt {
  readonly objectiveId: string
  readonly attemptKey: string
  readonly objectiveRevisionBefore: number
  readonly objectiveRevisionAfter: number
  readonly turnOutcome: ProgressTurnOutcome
  readonly criterionTransitions: readonly string[]
  readonly verifierReceiptRefs: readonly string[]
  readonly sourceDigest?: string
  readonly remainingCriterionIds: readonly string[]
  readonly recordedAt: number
}

const OUTCOMES: ReadonlySet<string> = new Set<ProgressTurnOutcome>([
  "completed",
  "aborted",
  "error",
  "backgrounded",
])

export const isProgressTurnOutcome = (v: unknown): v is ProgressTurnOutcome =>
  typeof v === "string" && OUTCOMES.has(v)

const boundedStrings = (values: unknown): readonly string[] =>
  Object.freeze(
    (Array.isArray(values) ? values : [])
      .filter(
        (v): v is string =>
          typeof v === "string" && v.length > 0 && v.length <= MAX_PROGRESS_REF_LENGTH,
      )
      .slice(0, MAX_PROGRESS_REFS),
  )

const isRef = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_PROGRESS_REF_LENGTH

/** Reject malformed/unbounded packets before they become durable evidence. */
export const normalizeProgressReceipt = (input: unknown): ProgressReceipt | null => {
  if (input === null || typeof input !== "object") return null
  const candidate = input as Partial<ProgressReceipt>
  if (
    !isRef(candidate.objectiveId) ||
    !isRef(candidate.attemptKey) ||
    !Number.isSafeInteger(candidate.objectiveRevisionBefore) ||
    (candidate.objectiveRevisionBefore as number) < 0 ||
    !Number.isSafeInteger(candidate.objectiveRevisionAfter) ||
    (candidate.objectiveRevisionAfter as number) < (candidate.objectiveRevisionBefore as number) ||
    !isProgressTurnOutcome(candidate.turnOutcome) ||
    !Array.isArray(candidate.criterionTransitions) ||
    !Array.isArray(candidate.verifierReceiptRefs) ||
    !Array.isArray(candidate.remainingCriterionIds) ||
    typeof candidate.recordedAt !== "number" ||
    !Number.isFinite(candidate.recordedAt) ||
    candidate.recordedAt < 0 ||
    (candidate.sourceDigest !== undefined && !isRef(candidate.sourceDigest))
  )
    return null
  return Object.freeze({
    objectiveId: candidate.objectiveId,
    attemptKey: candidate.attemptKey,
    objectiveRevisionBefore: candidate.objectiveRevisionBefore as number,
    objectiveRevisionAfter: candidate.objectiveRevisionAfter as number,
    turnOutcome: candidate.turnOutcome,
    criterionTransitions: boundedStrings(candidate.criterionTransitions),
    verifierReceiptRefs: boundedStrings(candidate.verifierReceiptRefs),
    ...(candidate.sourceDigest !== undefined ? { sourceDigest: candidate.sourceDigest } : {}),
    remainingCriterionIds: boundedStrings(candidate.remainingCriterionIds),
    recordedAt: candidate.recordedAt,
  })
}

export const appendProgressReceipt = (
  receipts: readonly ProgressReceipt[],
  receipt: ProgressReceipt,
): readonly ProgressReceipt[] => Object.freeze([...receipts, receipt].slice(-MAX_PROGRESS_RECEIPTS))

/** The stable reference of a verifier completion receipt as it appears in
 *  `verifierReceiptRefs` (and in a settlement's `verifierReceiptIdsBefore`). */
export const verifierReceiptRef = (input: {
  readonly criterionId: string
  readonly checkId: string
  readonly objectiveRevision: number
}): string => `${input.criterionId}:${input.checkId}:${input.objectiveRevision}`
