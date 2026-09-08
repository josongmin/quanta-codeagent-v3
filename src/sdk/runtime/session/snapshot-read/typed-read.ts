/**
 * SDK resume snapshot adapter (SEP7-D-07).
 *
 * Maps the session-store typed read (`found | missing | corrupt | unreadable`)
 * into the rehydrate refusal boundary. `loadSessionById` stays a convenience
 * wrapper that collapses non-found to `undefined`.
 */
import { readSessionByIdTyped, type SessionSnapshotRead } from "@/session/store"

export type ResumeSnapshotRead = SessionSnapshotRead

export const loadResumeSnapshot = (sessionId: string): Promise<ResumeSnapshotRead> =>
  readSessionByIdTyped(sessionId)
