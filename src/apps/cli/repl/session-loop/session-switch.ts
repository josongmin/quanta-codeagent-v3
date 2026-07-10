/**
 * UUX-4-07 — `/fork` switch: move the LIVE session onto the fork.
 *
 * The loop installs {@link performSessionSwitch} (bound to its live kernel
 * session + surface state + the facade-aliased `SessionMeta`) through the
 * surface's session-switch wire (`repl/session-switch-wire.ts`), the same
 * late-install pattern as `registerReplaceMessages`.
 *
 * How the persist identity gets repointed WITHOUT touching the locked
 * host-runtime files: per-turn persistence (`@/runner/orchestrate/persist-turn`
 * → `saveSessionById(idMeta, …)`) reads `options.idMeta` at TURN time from the
 * options object the loop handed to `createRuntimeFacade` — every layer in
 * between (`context.ts` rest-destructure, `context-binding.ts` retention)
 * forwards the SAME `SessionMeta` reference. So mutating that object IN PLACE
 * ({@link repointSessionMeta}) makes the very next persist write under the
 * fork's id — the parent transcript on disk is never clobbered with the
 * fork's truncated history. `tests/unit/apps/cli/repl/session-switch-hellgate`
 * pins the in-place (same-identity) contract; the aliasing itself is pinned
 * by the fork-switch e2e leg asserting the parent stays intact.
 *
 * Ordering (crown invariant): load fork → swap kernel transcript (the
 * reducer's `transcript_replace_unavailable` guard REFUSES mid-turn — reused,
 * not re-implemented) → commit surface state → repoint idMeta. A rejection
 * anywhere earlier leaves EVERYTHING untouched (disk-vs-live honesty).
 */

import type { Message } from "@/llm"
import type { SessionMeta } from "@/session"

/** Receipt the switch hands back to `/fork` so the printed copy states
 *  EXACTLY what the next persist will do (effect-receipt discipline). */
export interface SessionSwitchReceipt {
  /** The session id now live in the surface. */
  readonly sessionId: string
  /** `fork-id` ⇒ per-turn persistence now writes under the fork's id.
   *  `unchanged` ⇒ this surface has no id-mode persistence to repoint. */
  readonly persistTarget: "fork-id" | "unchanged"
  /** Human line for the receipt — printed verbatim by `/fork`. */
  readonly persistNote: string
}

export interface SessionSwitchDeps {
  /** Disk readback for the fork (`loadSessionById`). */
  readonly loadSession: (
    id: string,
  ) => Promise<{ meta: SessionMeta; messages: readonly Message[] } | undefined>
  /** Kernel transcript swap (`session.transcript.replace` adapter). Throws
   *  `transcript_replace_unavailable` mid-turn — propagated to the caller.
   *  Returns the history the kernel actually holds after the swap. */
  readonly replaceTranscript: (msgs: readonly Message[]) => Promise<readonly Message[]>
  /** The facade-aliased id-mode meta (see module doc). `undefined` ⇒ this
   *  surface persists by path/ephemerally; nothing to repoint. */
  readonly idMeta: SessionMeta | undefined
  /** Surface-state commit (`surfaceState = updateSessionState(...)`). Called
   *  ONLY after the kernel swap resolved. */
  readonly commit: (next: { sessionId: string; history: readonly Message[] }) => void
}

/** In-place mirror of `next` onto `target` — SAME object identity (the
 *  aliasing into the runtime facade is the mechanism; a fresh object would
 *  silently detach the persist target). Stale keys absent on `next` are
 *  removed so no parent-only metadata leaks onto the fork's persist. */
export const repointSessionMeta = (target: SessionMeta, next: SessionMeta): void => {
  const t = target as unknown as Record<string, unknown>
  const n = next as unknown as Record<string, unknown>
  for (const key of Object.keys(t)) {
    if (!(key in n)) delete t[key]
  }
  Object.assign(t, n)
}

/** See module doc. Throws on any failure BEFORE mutating anything live. */
export const performSessionSwitch = async (
  deps: SessionSwitchDeps,
  newSessionId: string,
): Promise<SessionSwitchReceipt> => {
  const saved = await deps.loadSession(newSessionId)
  if (saved === undefined) {
    throw new Error(`session not found on disk: ${newSessionId}`)
  }
  // Kernel swap FIRST — its mid-turn guard (transcript_replace_unavailable)
  // is the refusal seam; a throw here leaves surface state + idMeta untouched.
  const nextHistory = await deps.replaceTranscript(saved.messages)
  deps.commit({ sessionId: newSessionId, history: nextHistory })
  if (deps.idMeta !== undefined) {
    repointSessionMeta(deps.idMeta, saved.meta)
    return {
      sessionId: newSessionId,
      persistTarget: "fork-id",
      persistNote: `future turns persist under the fork (${newSessionId}); the parent transcript on disk is untouched`,
    }
  }
  return {
    sessionId: newSessionId,
    persistTarget: "unchanged",
    persistNote: `live history swapped; this surface has no id-mode persistence — run \`quanta --resume ${newSessionId}\` to continue the fork durably`,
  }
}
