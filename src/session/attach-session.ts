/**
 * WS-1 (jul-11) — the UNIFIED session-attach SSOT.
 *
 * "Make an existing saved session the LIVE one" is a single crown-ordered op
 * that BOTH surfaces perform: the CLI `/fork` switch (`performSessionSwitch`)
 * and the web daemon's open-thread swap (`hydrateThreadIntoLiveSession`). They
 * used to be two copies with two guards + two orderings; this owns the ONE
 * crown invariant, and each surface injects its effects + owns its presentation.
 *
 * Crown ordering (eligibility refusals leave every live owner untouched):
 *   load saved  → absent ⇒ `unknown-session` (nothing touched)
 *   prepare attached state → invalid ⇒ reject before any live mutation
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
  | { readonly kind: "invalid-attached-state"; readonly sessionId: string }

export interface AttachSessionDeps {
  /** Disk readback (`loadSessionById`) — returns the lossless SavedSession
   *  fields the op needs. `undefined` ⇒ `unknown-session`. */
  readonly loadSession: (id: string) => Promise<
    | {
        readonly meta: SessionMeta
        readonly messages: readonly Message[]
        readonly objective?: import("./types").PersistedObjectiveSnapshot | undefined
        readonly usageAccounting?: string | undefined
      }
    | undefined
  >
  /** Cancel autonomous work before any attach eligibility check or disk read. */
  readonly onAttachStart?: (() => void) | undefined
  /** Validate and stage attached state without mutation. Null rejects before
   * transcript/persistence changes; commit runs synchronously after both succeed.
   * A prepared commit must apply validated state, not perform a second admission
   * check. Unexpected adapter faults propagate; this is not a rollback API. */
  readonly prepareAttachedState?:
    | ((saved: {
        readonly meta: SessionMeta
        readonly messages: readonly Message[]
        readonly objective?: import("./types").PersistedObjectiveSnapshot | undefined
        readonly usageAccounting?: string | undefined
      }) => { readonly commit: () => boolean } | null)
    | undefined
  /** Kernel transcript swap (`session.transcript.replace` adapter). Throws an
   *  error whose message matches `/transcript_replace_unavailable/` mid-turn
   *  (mapped to `refused-mid-turn`). The catch block in `attachSessionToLive`
   *  narrows by that message contract — implementations MUST use this sentinel
   *  string so the pattern match is reliable. Any OTHER error propagates.
   *  Returns the history the kernel actually holds after the swap (drives the
   *  attached `messageCount`). */
  readonly replaceTranscript: (msgs: readonly Message[]) => Promise<readonly Message[]>
  /** Surface-state commit — runs after the swap resolved, BEFORE persist
   *  repoint. Optional: the web daemon has no per-connection surface state. */
  readonly onReplaced?: (ctx: {
    readonly sessionId: string
    readonly history: readonly Message[]
  }) => void
  /** Repoint future persistence at the attached session (in-place; surface owns
   *  the mechanism — CLI mirrors `meta`, web takes only `id`). */
  readonly setPersistTarget: (target: { readonly id: string; readonly meta: SessionMeta }) => void
  /** Re-arm against the resulting live identity after every exit path. */
  readonly onAttachSettled?: (() => void) | undefined
  readonly onAttached?: (() => void) | undefined
}

/** @see module doc. Nothing live is touched until the transcript swap resolves. */
export const attachSessionToLive = async (
  sessionId: string,
  deps: AttachSessionDeps,
): Promise<AttachOutcome> => {
  deps.onAttachStart?.()
  try {
    const saved = await deps.loadSession(sessionId)
    if (saved === undefined) return { kind: "unknown-session", sessionId }
    const attachedState = deps.prepareAttachedState?.(saved)
    if (attachedState === null) return { kind: "invalid-attached-state", sessionId }

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
    if (attachedState !== undefined && !attachedState.commit()) {
      throw new Error("attached_state_commit_failed")
    }
    deps.onAttached?.()
    return { kind: "attached", sessionId, messageCount: history.length }
  } finally {
    deps.onAttachSettled?.()
  }
}
