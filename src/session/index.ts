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

// ADR-0034: JSONL envelope (additive rail, not used by the snapshot store).
export type {
  EventMsgRecord,
  ResponseItemRecord,
  SessionEnvelopeRecord,
  SessionMetaRecord,
  ThreadSpawnRecord,
  TurnContextRecord,
} from "./envelope"
export {
  ApprovalPolicySchema,
  CollaborationModeSchema,
  EffortSchema,
  EventMsgRecordSchema,
  PermissionProfileSchema,
  ResponseItemKindSchema,
  ResponseItemRecordSchema,
  SandboxPolicySchema,
  SESSION_ENVELOPE_VERSION,
  SessionEnvelopeRecordSchema,
  SessionMetaRecordSchema,
  ThreadRoleSchema,
  ThreadSpawnRecordSchema,
  TruncationPolicySchema,
  TurnContextRecordSchema,
} from "./envelope"
export type { EnvelopeDecodeErrorKind } from "./envelope-encoder"
export {
  appendSessionLine,
  decodeSessionLine,
  EnvelopeDecodeError,
  encodeSessionLine,
  iterateSessionFile,
} from "./envelope-encoder"
export { listSessions, removeFromIndex, upsertMeta } from "./index-store"
export {
  archivedFilePath,
  archivedFilePathAsync,
  indexFilePath,
  indexFilePathAsync,
  SessionIdError,
  sanitizeId,
  sessionFilePath,
  sessionFilePathAsync,
  sessionsRoot,
  sessionsRootAsync,
} from "./paths"
export type { SessionRootProvider } from "./root-port"
export { defaultSessionRootProvider, staticSessionRootProvider } from "./root-port"
export {
  appendEnvelope,
  archiveSession,
  assignMessageIds,
  deleteSession,
  forkSession,
  loadSessionById,
  renameSession,
  rewindToMessage,
  saveSessionById,
  sessionEnvelopePath,
  sessionEnvelopePathAsync,
  unarchiveSession,
} from "./store"
export type { SavedSession, SavePayload, SessionMeta } from "./types"
export { SESSION_VERSION } from "./types"
