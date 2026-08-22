import type { Message } from "@/llm"

/** Per-turn render and state side-effects owned by the interactive surface. */
export interface SessionLoopSinks {
  readonly renderTurnDashboard: () => void
  readonly renderAndResetSummary: (outcome: { messages: readonly Message[] }) => void
  readonly flushLifecyclePills: (live?: { readonly externalQueued: number }) => void
  readonly renderTurnError: (err: unknown) => void
}
