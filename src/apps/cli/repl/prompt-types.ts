import type { ImageBlock } from "@/llm"

/** Metadata retained only for an autonomous goal continuation. It lets the
 * interactive loop reject a stale active→active revision at dequeue, before an
 * agent body sees the old pursuit prompt. */
export interface GoalContinuationPromptMeta {
  readonly threadId: string
  readonly objectiveRevision: number
  readonly attemptKey: string
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
