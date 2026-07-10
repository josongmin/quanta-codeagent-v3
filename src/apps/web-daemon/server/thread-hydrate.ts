/**
 * P1 Phase 2 (jul-11) — swap the daemon's ONE live session onto an opened
 * thread.
 *
 * The daemon hosts a single live `RuntimeSession` (all WS clients share it).
 * Opening a persisted thread makes it LIVE: load that thread's lossless
 * SavedSession (Phase 1), `transcript.replace` the live session's working set
 * with it, and repoint future persistence to the thread (Phase 1's mutable
 * `activeThreadId`, the same in-place identity repoint the CLI's
 * `performSessionSwitch` does — the parent thread on disk is never clobbered).
 *
 * Crown ordering / safety (mirrors performSessionSwitch): a mid-turn swap is
 * REFUSED by the kernel's `transcript_replace_unavailable` guard — we map that
 * to `refused-mid-turn` and repoint NOTHING, so the live turn keeps running on
 * the parent thread. Unknown / never-persisted id ⇒ clean `unknown-thread`
 * no-op. Any other error propagates (never silently swallowed).
 *
 * Pure + DOM-free: the ws-handlers wiring injects `loadThread`
 * (`loadSessionById`), `replaceTranscript` (`session.transcript.replace`), and
 * `setActiveThreadId` (the transcript-persistence cell).
 */

import type { Message } from "@/llm"
import { errMessage } from "@/shared"

export interface ThreadHydrateDeps {
  readonly loadThread: (
    id: string,
  ) => Promise<{ readonly messages: readonly Message[] } | undefined>
  readonly replaceTranscript: (messages: readonly Message[]) => Promise<void>
  readonly setActiveThreadId: (id: string) => void
}

export type ThreadHydrateOutcome =
  | { readonly kind: "hydrated"; readonly threadId: string; readonly count: number }
  | { readonly kind: "unknown-thread"; readonly threadId: string }
  | { readonly kind: "refused-mid-turn"; readonly threadId: string }

export const hydrateThreadIntoLiveSession = async (
  threadId: string,
  deps: ThreadHydrateDeps,
): Promise<ThreadHydrateOutcome> => {
  const saved = await deps.loadThread(threadId)
  if (saved === undefined) return { kind: "unknown-thread", threadId }
  try {
    await deps.replaceTranscript(saved.messages)
  } catch (error) {
    // The kernel refuses a transcript replace WHILE a turn runs — that is a
    // clean "try again after the turn", not a failure. Repoint nothing.
    if (/transcript_replace_unavailable/.test(errMessage(error))) {
      return { kind: "refused-mid-turn", threadId }
    }
    throw error
  }
  // Replace succeeded ⇒ future persist writes belong to the opened thread.
  deps.setActiveThreadId(threadId)
  return { kind: "hydrated", threadId, count: saved.messages.length }
}
