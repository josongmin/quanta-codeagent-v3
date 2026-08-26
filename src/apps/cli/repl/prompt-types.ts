import type { ImageBlock } from "@/llm"

/** Metadata retained only for an autonomous goal continuation. It lets the
 * interactive loop reject a stale active→active revision at dequeue, before an
 * agent body sees the old pursuit prompt. */
export interface GoalContinuationPromptMeta {
  readonly threadId: string
  readonly objectiveRevision: number
  readonly attemptKey: string
  /** GOAL-06 rail 11 — the wake controller's raw-input epoch at arm time. */
  readonly activityEpoch?: number
  /** GOAL-08 rail 15 — host-minted provenance; absent ⇒ autonomous continuation. */
  readonly provenance?: "autonomous-continuation" | "user-requested-goal-work"
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
