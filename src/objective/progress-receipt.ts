/** Bounded, text-free evidence checkpoint for an autonomous objective attempt. */
export const MAX_PROGRESS_RECEIPTS = 16
export const MAX_PROGRESS_REFS = 32
export const MAX_PROGRESS_REF_LENGTH = 512

export type ProgressTurnOutcome = "completed" | "aborted" | "error" | "backgrounded"

export interface ProgressReceipt {
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

const boundedStrings = (values: unknown): readonly string[] =>
  Object.freeze(
    (Array.isArray(values) ? values : [])
      .filter(
        (v): v is string =>
          typeof v === "string" && v.length > 0 && v.length <= MAX_PROGRESS_REF_LENGTH,
      )
      .slice(0, MAX_PROGRESS_REFS),
  )

/** Reject malformed/unbounded packets before they become durable evidence. */
export const normalizeProgressReceipt = (input: unknown): ProgressReceipt | null => {
  if (input === null || typeof input !== "object") return null
  const candidate = input as Partial<ProgressReceipt>
  if (
    typeof candidate.attemptKey !== "string" ||
    candidate.attemptKey.length === 0 ||
    candidate.attemptKey.length > MAX_PROGRESS_REF_LENGTH ||
    !Number.isSafeInteger(candidate.objectiveRevisionBefore) ||
    (candidate.objectiveRevisionBefore as number) < 0 ||
    !Number.isSafeInteger(candidate.objectiveRevisionAfter) ||
    (candidate.objectiveRevisionAfter as number) < (candidate.objectiveRevisionBefore as number) ||
    typeof candidate.turnOutcome !== "string" ||
    !OUTCOMES.has(candidate.turnOutcome) ||
    !Array.isArray(candidate.criterionTransitions) ||
    !Array.isArray(candidate.verifierReceiptRefs) ||
    !Array.isArray(candidate.remainingCriterionIds) ||
    typeof candidate.recordedAt !== "number" ||
    !Number.isFinite(candidate.recordedAt) ||
    candidate.recordedAt < 0 ||
    (candidate.sourceDigest !== undefined &&
      (typeof candidate.sourceDigest !== "string" ||
        candidate.sourceDigest.length === 0 ||
        candidate.sourceDigest.length > MAX_PROGRESS_REF_LENGTH))
  )
    return null
  return Object.freeze({
    attemptKey: candidate.attemptKey,
    objectiveRevisionBefore: candidate.objectiveRevisionBefore as number,
    objectiveRevisionAfter: candidate.objectiveRevisionAfter as number,
    turnOutcome: candidate.turnOutcome as ProgressTurnOutcome,
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
