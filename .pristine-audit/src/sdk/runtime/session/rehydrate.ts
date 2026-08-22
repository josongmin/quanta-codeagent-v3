import type { Message } from "@/llm"
import { loadSessionById, type SavedSession } from "@/session"

/**
 * RFC01-4 — A1 cold-start rehydrate (INJECTION, not event-fold).
 *
 * The confirmed-correction (docs/plans/aug-02-absorption/README.md §"RFC-01
 * A1") is explicit: `SessionEvent` (the kernel JSONL rail) carries seq/wire
 * continuity but CANNOT exact-restore the semantic transcript / tool-use +
 * result / approval / artifact / revision. `rehydrateState(events)` is DROPPED.
 * The SOLE lossless durable authority for those is the existing `SavedSession`
 * snapshot (`messages: Message[]` = the full transcript, plus rollback/workspace
 * records) loaded by `loadSessionById`. This module INJECTS that snapshot into
 * the SDK runtime cold-start — it creates NO new checkpoint schema/store/writer
 * and folds NO events.
 *
 * TWO-RAIL INDEPENDENCE (README §A1-b). The durable JSONL event log
 * (`QUANTA_SESSION_EVENT_LOG_DIR`) is the seq/wire-continuity rail; the
 * `@/session` `SavedSession` snapshot is an INDEPENDENT transcript rail. A
 * durable log can legitimately exist with NO `SavedSession` (a pure
 * SDK-embedded/wire-replay session that never touched the `@/session` CLI
 * store — the transport-unified ticket-05 seq-only resume). So the ABSENCE of a
 * snapshot is NOT tamper — it is the byte-identical "resume seq only, start
 * with an empty transcript exactly as today" path.
 *
 * FAIL-CLOSED CONTRACT (only when a snapshot EXISTS). When `loadSessionById`
 * returns a snapshot for the resuming session id, it is the lossless transcript
 * owner and MUST be consistent, or the runtime REFUSES to start
 * (operator-visible throw) rather than partial-merging a corrupt transcript.
 * Refusal is triggered by:
 *   - IDENTITY MISMATCH: `snapshot.meta.id !== sessionId` (the snapshot on disk
 *     is for a DIFFERENT session — a swapped/tampered file);
 *   - TAMPERED TRANSCRIPT: any entry in `snapshot.messages` is not a
 *     structurally-valid `Message` (role ∈ {user,assistant}, `content` an
 *     array) — a corrupted/hand-edited transcript. (The `@/session` store's own
 *     `savedSessionSchema` already refuses to LOAD a badly-corrupt file — that
 *     manifests here as `snapshot === undefined` ⇒ byte-identical fresh — so
 *     this branch is the defense-in-depth boot-time re-check for a snapshot
 *     that parses but still violates the Message contract.)
 *
 * ABSENT-SNAPSHOT / ABSENT-LOG BYTE-IDENTICAL. This module is consulted ONLY
 * when a durable tip exists (see `runtime.ts` `createSession`); with the
 * in-memory log (default, `QUANTA_SESSION_EVENT_LOG_DIR` unset) `tip === 0`, so
 * rehydrate never runs. And when it DOES run but no snapshot exists, it returns
 * `undefined` ⇒ the created state's empty transcript is untouched — byte-
 * identical to the pre-feature runtime.
 */

/** Operator-visible refusal. A resumable durable log exists AND its lossless
 *  `SavedSession` transcript owner is present but INCONSISTENT (identity
 *  mismatch or a tampered transcript), so the runtime fails closed instead of
 *  partial-merging a corrupt transcript. (Absent snapshot is NOT a refusal —
 *  it is the byte-identical fresh path; see the module header.) */
export class ResumeRehydrateRefusedError extends Error {
  readonly sessionId: string
  readonly component: "identity" | "transcript"
  constructor(sessionId: string, component: "identity" | "transcript", detail: string) {
    super(
      `refusing to resume session ${sessionId}: ${detail} ` +
        "(the durable event log is resumable but its lossless SavedSession " +
        "transcript owner is missing or tampered — refusing to start fresh or " +
        "partial-merge; RFC01-4 fail-closed)",
    )
    this.name = "ResumeRehydrateRefusedError"
    this.sessionId = sessionId
    this.component = component
  }
}

/** Structural `Message` validation — the tamper gate. A rehydrate authority
 *  must round-trip to a real transcript, so anything that is not a
 *  `{role, content[]}` Message is a tampered snapshot, NOT a "start fresh"
 *  invitation. */
const isMessage = (value: unknown): value is Message => {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { role?: unknown; content?: unknown }
  if (candidate.role !== "user" && candidate.role !== "assistant") return false
  return Array.isArray(candidate.content)
}

/**
 * Validate a loaded `SavedSession` against the resumable identity. Returns the
 * lossless transcript when the snapshot is present and consistent; returns
 * `undefined` when NO snapshot exists (the byte-identical fresh path — the two
 * rails are independent, so an absent transcript rail is not tamper); THROWS a
 * fail-closed refusal when a snapshot IS present but INCONSISTENT
 * (identity/transcript tamper). Pure over the already-loaded snapshot so it is
 * unit-testable without disk.
 */
export const validateResumeSnapshot = (
  sessionId: string,
  snapshot: SavedSession | undefined,
): readonly Message[] | undefined => {
  if (snapshot === undefined) return undefined
  if (snapshot.meta.id !== sessionId) {
    throw new ResumeRehydrateRefusedError(
      sessionId,
      "identity",
      `snapshot identity mismatch (snapshot is for ${snapshot.meta.id})`,
    )
  }
  if (!Array.isArray(snapshot.messages)) {
    throw new ResumeRehydrateRefusedError(
      sessionId,
      "transcript",
      "snapshot transcript is not an array",
    )
  }
  for (let i = 0; i < snapshot.messages.length; i += 1) {
    if (!isMessage(snapshot.messages[i])) {
      throw new ResumeRehydrateRefusedError(
        sessionId,
        "transcript",
        `snapshot transcript entry #${i} is not a valid Message`,
      )
    }
  }
  return snapshot.messages
}

/**
 * Cold-start injection entry point. Load the lossless `SavedSession` snapshot
 * for a resumable session id and return its validated transcript, or THROW a
 * `ResumeRehydrateRefusedError` (fail-closed). Called by `runtime.ts`
 * `createSession` ONLY when `durableLog.tip() > 0`.
 *
 * `loader` is an injectable seam (defaults to the production `loadSessionById`)
 * so tests drive missing/identity/tamper without touching the on-disk store.
 */
export const rehydrateResumeTranscript = async (
  sessionId: string,
  loader: (id: string) => Promise<SavedSession | undefined> = loadSessionById,
): Promise<readonly Message[] | undefined> => {
  const snapshot = await loader(sessionId)
  return validateResumeSnapshot(sessionId, snapshot)
}
