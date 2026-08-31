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
import { attachSessionToLive, type PersistedObjectiveSnapshot, type SessionMeta } from "@/session"

export interface ThreadHydrateDeps {
  readonly loadThread: (id: string) => Promise<
    | {
        readonly meta: SessionMeta
        readonly messages: readonly Message[]
        // RFC-03 C2 (web parity) — the reopened thread's durable objective snapshot
        // (from `SavedSession.objective`). Optional: a thread that never had a goal
        // reads back absent. Surfaced so the success path can restore it.
        readonly objective?: PersistedObjectiveSnapshot | undefined
        readonly usageAccounting?: string | undefined
      }
    | undefined
  >
  readonly replaceTranscript: (messages: readonly Message[]) => Promise<void>
  readonly setActiveThreadId: (id: string) => void
  /** Publish earlier completed turns before reading a possibly just-saved target. */
  readonly flushPersistence?: (() => Promise<void>) | undefined
  /**
   * RFC-03 C2 (web parity) — restore the reopened thread's durable objective into
   * the live objective authority. Called ONLY on the `attached`/`hydrated` success
   * path (AFTER the transcript swap resolved and persistence repointed) so a
   * `refused-mid-turn` / `unknown-thread` outcome restores NOTHING (parity with the
   * transcript guard). Absent (TOOLS off / non-persisting daemon) ⇒ omitted ⇒ no
   * restore, byte-identical.
   */
  readonly prepareObjectiveAttach?:
    | ((
        snapshot: PersistedObjectiveSnapshot | undefined,
      ) => { readonly commit: () => boolean } | null)
    | undefined
  readonly prepareUsageAccountingAttach?:
    | ((snapshot: string | undefined) => { readonly commit: () => boolean })
    | undefined
  readonly cancelGoalWake?: (() => void) | undefined
  readonly rearmGoalWake?: (() => void) | undefined
}

export type ThreadHydrateOutcome =
  | { readonly kind: "hydrated"; readonly threadId: string; readonly count: number }
  | { readonly kind: "unknown-thread"; readonly threadId: string }
  | { readonly kind: "refused-mid-turn"; readonly threadId: string }
  | { readonly kind: "invalid-objective"; readonly threadId: string }

/**
 * Web adapter over the unified `attachSessionToLive` (WS-1). The crown ordering
 * + mid-turn guard live in the core; this maps the daemon's void-returning
 * `transcript.replace` + id-only persist cell onto it, and re-expresses the
 * outcome in thread-vocabulary for the ws layer.
 */
export const hydrateThreadIntoLiveSession = async (
  threadId: string,
  deps: ThreadHydrateDeps,
): Promise<ThreadHydrateOutcome> => {
  const outcome = await attachSessionToLive(threadId, {
    // Shared core cancels wake first. Drain prior completion snapshots before
    // the ONE disk read used by transcript, objective, and accounting together.
    loadSession: async (id) => {
      await deps.flushPersistence?.()
      return deps.loadThread(id)
    },
    onAttachStart: deps.cancelGoalWake,
    prepareAttachedState:
      deps.prepareObjectiveAttach === undefined && deps.prepareUsageAccountingAttach === undefined
        ? undefined
        : (saved) => {
            const objective = deps.prepareObjectiveAttach?.(saved.objective)
            if (objective === null) return null
            const accounting = deps.prepareUsageAccountingAttach?.(saved.usageAccounting)
            return {
              commit: () => {
                if (objective !== undefined && !objective.commit()) return false
                return accounting?.commit() ?? true
              },
            }
          },
    replaceTranscript: async (messages) => {
      await deps.replaceTranscript(messages)
      return messages
    },
    // The daemon repoints by thread id only (the activeThreadId cell); the
    // core's `meta` is unused here (no per-connection SessionMeta identity).
    setPersistTarget: ({ id }) => deps.setActiveThreadId(id),
    onAttachSettled: deps.rearmGoalWake,
  })
  switch (outcome.kind) {
    case "attached":
      return { kind: "hydrated", threadId, count: outcome.messageCount }
    case "unknown-session":
      return { kind: "unknown-thread", threadId }
    case "refused-mid-turn":
      return { kind: "refused-mid-turn", threadId }
    case "invalid-attached-state":
      return { kind: "invalid-objective", threadId }
  }
}
