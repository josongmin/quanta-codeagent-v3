/**
 * Session slice — id-addressable persistence (V2 schema).
 *
 * NEW rail alongside `src/agent/state.ts` (V1, path-based). V1 stays exactly
 * as-is for legacy callers; new flows mint an opaque id and use this slice.
 *
 * Layout on disk:
 *   <root>/<id>.json              — active session file
 *   <root>/archived/<id>.json     — archived session file
 *   <root>/index.jsonl            — lightweight directory (one meta per line)
 *
 * `<root>` is `~/.quanta/sessions` by default, overridable via
 * `QUANTA_SESSIONS_DIR` (same convention as `QUANTA_MEMORY_PATH`).
 */

export { listSessions, removeFromIndex, upsertMeta } from "./index-store"
export {
  archivedFilePath,
  indexFilePath,
  SessionIdError,
  sanitizeId,
  sessionFilePath,
  sessionsRoot,
} from "./paths"
export {
  archiveSession,
  deleteSession,
  forkSession,
  loadSessionById,
  renameSession,
  saveSessionById,
  unarchiveSession,
} from "./store"
export type { SavedSession, SavePayload, SessionMeta } from "./types"
export { SESSION_VERSION } from "./types"
