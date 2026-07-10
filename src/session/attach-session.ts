/**
 * WS-1 (jul-11) — the UNIFIED session-attach SSOT.
 *
 * "Make an existing saved session the LIVE one" is a single crown-ordered op
 * that BOTH surfaces perform: the CLI `/fork` switch (`performSessionSwitch`)
 * and the web daemon's open-thread swap (`hydrateThreadIntoLiveSession`). They
 * used to be two copies with two guards + two orderings; this owns the ONE
 * crown invariant, and each surface injects its effects + owns its presentation.
 *
 * Crown ordering (a rejection anywhere leaves EVERYTHING untouched — disk-vs-live
 * honesty):
 *   load saved  → absent ⇒ `unknown-session` (nothing touched)
 *   replace transcript → the kernel's `transcript_replace_unavailable` guard
 *     REFUSES mid-turn ⇒ `refused-mid-turn`, NOTHING repointed (the live turn
 *     keeps running on the parent); any OTHER error propagates (never swallowed)
 *   onReplaced(history) → surface-state commit hook (optional; CLI commits its
 *     REPL surface here, web has no such step) — runs AFTER the swap, BEFORE the
 *     persist repoint (so a commit failure can't leave persist pointing at a
 *     half-applied swap)
 *   setPersistTarget({id, meta}) → repoint future persistence to the attached
 *     session, IN PLACE (CLI mirrors onto the facade-aliased SessionMeta; web
 *     mutates its activeThreadId cell). The seam takes a CALLBACK — it never owns
 *     or replaces the identity object.
 */

import type { Message } from "@/llm"
import { errMessage } from "@/shared"
import type { SessionMeta } from "./types"

/** The typed outcome of an attach. Surfaces map this onto their own receipt /
 *  ws-response — the core carries the OPERATION, not the presentation. */
export type AttachOutcome =
  | { readonly kind: "attached"; readonly sessionId: string; readonly messageCount: number }
  | { readonly kind: "unknown-session"; readonly sessionId: string }
  | { readonly kind: "refused-mid-turn"; readonly sessionId: string }

export interface AttachSessionDeps {
  /** Disk readback (`loadSessionById`) — returns the lossless SavedSession
   *  fields the op needs. `undefined` ⇒ `unknown-session`. */
  readonly loadSession: (
    id: string,
  ) => Promise<{ readonly meta: SessionMeta; readonly messages: readonly Message[] } | undefined>
  /** Kernel transcript swap (`session.transcript.replace` adapter). Throws
   *  `transcript_replace_unavailable` mid-turn (mapped to `refused-mid-turn`).
   *  Returns the history the kernel actually holds after the swap (drives the
   *  attached `messageCount`). */
  readonly replaceTranscript: (msgs: readonly Message[]) => Promise<readonly Message[]>
  /** Surface-state commit — runs after the swap resolved, BEFORE persist
   *  repoint. Optional: the web daemon has no per-connection surface state. */
  readonly onReplaced?: (ctx: { readonly sessionId: string; readonly history: readonly Message[] }) => void
  /** Repoint future persistence at the attached session (in-place; surface owns
   *  the mechanism — CLI mirrors `meta`, web takes only `id`). */
  readonly setPersistTarget: (target: { readonly id: string; readonly meta: SessionMeta }) => void
}

/** @see module doc. Nothing live is touched until the transcript swap resolves. */
export const attachSessionToLive = async (
  sessionId: string,
  deps: AttachSessionDeps,
): Promise<AttachOutcome> => {
  const saved = await deps.loadSession(sessionId)
  if (saved === undefined) return { kind: "unknown-session", sessionId }

  let history: readonly Message[]
  try {
    history = await deps.replaceTranscript(saved.messages)
  } catch (error) {
    if (/transcript_replace_unavailable/.test(errMessage(error))) {
      return { kind: "refused-mid-turn", sessionId }
    }
    throw error
  }

  deps.onReplaced?.({ sessionId, history })
  deps.setPersistTarget({ id: sessionId, meta: saved.meta })
  return { kind: "attached", sessionId, messageCount: history.length }
}
