/**
 * P1 Phase 1 (jul-11) — LOSSLESS transcript persistence for the web daemon.
 *
 * The daemon already archives `SessionEvent[]` to sqlite (`server/persistence`)
 * for the read-only history UI, but those events truncate tool args/results to
 * ~256 chars. For a later LIVE THREAD SWAP (Phase 2) the daemon needs the FULL
 * `Message[]`, so on every `turn.completed` it saves the live transcript
 * (`session.transcript.messages()` — the Phase 0 read seam) to the SAME
 * `@/session` SavedSession store the CLI uses. `loadSessionById(id)` then
 * round-trips it with zero truncation.
 *
 * Gate-symmetric with `QUANTA_WEB_DB`: `enabled: false` ⇒ no writes (the
 * sqlite archive is likewise disabled), byte-identical to the legacy daemon.
 *
 * The append id is a MUTABLE `activeThreadId` cell (defaults to the session id)
 * so Phase 2's swap-on-attach can repoint future writes to the opened thread
 * WITHOUT re-subscribing — the same in-place identity repoint the CLI's
 * `performSessionSwitch` does, keeping the parent thread on disk intact.
 */

import type { RuntimeSession } from "@/sdk/runtime"
import { type SessionMeta, type SessionRootProvider, saveSessionById } from "@/session"
import { errMessage, logger } from "@/shared"

export interface TranscriptPersistOptions {
  /** Gate — `QUANTA_WEB_DB` on. Off ⇒ no writes. */
  readonly enabled: boolean
  /** Session-store root (tests inject a temp dir; production omits ⇒ default). */
  readonly rootProvider?: SessionRootProvider
  /** Session cwd for the SavedSession meta. */
  readonly cwd: string
}

export interface TranscriptPersistence {
  /** Repoint future writes at `threadId` (Phase 2 swap). */
  setActiveThreadId(threadId: string): void
  /** Await the in-flight write (tests). */
  flush(): Promise<void>
  unsub(): void
}

const minimalSession = (session: RuntimeSession) =>
  session as RuntimeSession & {
    readonly sessionId: string
    readonly transcript: { messages(): readonly import("@/llm").Message[] }
  }

export const attachTranscriptPersistence = (
  session: RuntimeSession,
  opts: TranscriptPersistOptions,
): TranscriptPersistence => {
  const s = minimalSession(session)
  let activeThreadId = s.sessionId
  let turns = 0
  let inFlight: Promise<void> = Promise.resolve()

  const save = async (): Promise<void> => {
    const meta: SessionMeta = {
      id: activeThreadId,
      title: activeThreadId,
      cwd: opts.cwd,
      createdAt: Date.now(),
      lastTouched: Date.now(),
      archived: false,
    }
    await saveSessionById(
      meta,
      { reason: "web-turn", turns, messages: [...s.transcript.messages()] },
      opts.rootProvider,
    )
  }

  const unsub = opts.enabled
    ? session.subscribe((event) => {
        if (event.type !== "turn.completed") return
        turns += 1
        // Serialize writes so a fast turn burst never races the store; a
        // failure is observable but never crashes the daemon or the turn.
        inFlight = inFlight
          .then(save)
          .catch((error) =>
            logger.warn("web-daemon: transcript persist failed", { error: errMessage(error) }),
          )
      })
    : () => undefined

  return {
    setActiveThreadId: (threadId) => {
      activeThreadId = threadId
    },
    flush: () => inFlight,
    unsub,
  }
}
