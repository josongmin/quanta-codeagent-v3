import type { ImageBlock } from "@/llm"
import type { ObjectiveAttemptProvenance } from "@/objective"

/** Metadata retained only for an autonomous goal continuation. It lets the
 * interactive loop reject a stale active→active revision at dequeue, before an
 * agent body sees the old pursuit prompt. */
export interface GoalContinuationPromptMeta {
  readonly threadId: string
  readonly objectiveRevision: number
  readonly attemptKey: string
  /** GOAL-05A — host-minted provenance of the attributed turn. Absent ⇒ the
   *  autonomous continuation (the wake controller); `/goal work` mints
   *  `user-requested-goal-work` (charges the turn, not the autonomous cap). */
  readonly provenance?: ObjectiveAttemptProvenance
  /** GOAL-06 — the wake controller's raw-input epoch captured at arm time. A
   *  continuation whose epoch no longer matches at dequeue is dropped (only the
   *  continuation — the user's draft is never touched). */
  readonly activityEpoch?: number
}

export type CliPromptInput =
  | string
  | {
      readonly text: string
      readonly images?: readonly ImageBlock[]
      readonly goalContinuation?: GoalContinuationPromptMeta
    }

export interface CliPromptSource {
  next(signal?: AbortSignal): Promise<CliPromptInput | null>
}

export const normalizeCliPromptInput = (
  input: CliPromptInput,
): {
  readonly text: string
  readonly images: readonly ImageBlock[]
  readonly goalContinuation?: GoalContinuationPromptMeta
} =>
  typeof input === "string"
    ? { text: input, images: [] }
    : {
        text: input.text,
        images: input.images ?? [],
        ...(input.goalContinuation === undefined
          ? {}
          : { goalContinuation: input.goalContinuation }),
      }
