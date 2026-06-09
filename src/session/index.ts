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
  DynamicToolRecord,
  EventMsgRecord,
  ResponseItemRecord,
  SessionEnvelopeRecord,
  SessionMetaRecord,
  ThreadSpawnRecord,
  TurnContextRecord,
} from "./envelope"
export {
  ApprovalModeSchema,
  ApprovalPolicySchema,
  ApprovalPolicyStructSchema,
  CollaborationModeSchema,
  ControlManagedBySchema,
  ControlPolicySchema,
  // Debug/developer-mode (Track A, 2026-05-25): gate-decision event schemas.
  DecisionGateSchema,
  DecisionOutcomeSchema,
  DynamicToolActionSchema,
  DynamicToolRecordSchema,
  EffortSchema,
  EventDecisionSchema,
  EventMsgRecordSchema,
  FileSystemAccessSchema,
  FileSystemEntrySchema,
  FileSystemPathSchema,
  FileSystemPolicyTypeSchema,
  FileSystemSandboxPolicySchema,
  NetworkModeSchema,
  NetworkPolicySchema,
  OsSandboxKindSchema,
  type PermissionProfileField,
  PermissionProfileFieldSchema,
  PermissionProfileSchema,
  PermissionProfileStructSchema,
  ResponseItemKindSchema,
  ResponseItemRecordSchema,
  SandboxPolicySchema,
  SandboxPolicyStructSchema,
  SESSION_ENVELOPE_VERSION,
  SessionEnvelopeRecordSchema,
  SessionMetaRecordSchema,
  SpecialPathKindSchema,
  SUPPORTED_SESSION_ENVELOPE_VERSIONS,
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
// ADR-0157 + ADR-0170: typed import/export envelope (pure serialization port).
export type {
  AnySessionExportEnvelope,
  SessionExportEnvelope,
  SessionExportEnvelopeV2,
  SessionExportOpts,
  SessionImportErrorCode,
  SessionImportOpts,
  SessionImportResult,
} from "./import-export"
export {
  exportSession,
  exportSessionToJson,
  importSession,
  importSessionFromJson,
  SessionImportError,
} from "./import-export"
// ADR-0157: FS adapter (Bun.file/Bun.write).
export { exportSessionToFile, importSessionFromFile } from "./import-export-fs"
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
// Claude-pattern rewind/fork wrappers (typed result shapes + prefix-id +
// optional git restore). Built on top of `rewindToMessage` + `forkSession`
// from `./store` — no envelope mutation, no new on-disk shape.
export type {
  ForkOptions,
  ForkResult,
  RewindGitPort,
  RewindOptions,
  RewindResult,
} from "./rewind"
export { forkSessionAtMessage, resolveMessageIdPrefix, rewindSession } from "./rewind"
export type { SessionRootProvider } from "./root-port"
export { defaultSessionRootProvider, staticSessionRootProvider } from "./root-port"
// §13.2 (jun-08): persisted interrupted-turn marker + crash resume (default-OFF
// behind QUANTA_CRASH_RESUME; pure offer builders).
export type { CrashResumeOffer, InterruptedSessionDetection } from "./crash-resume"
export {
  buildCrashResumeMessage,
  buildCrashResumeOffer,
  clearSessionInterrupted,
  CRASH_RESUME_GATE,
  CRASH_RESUME_PARTIAL_GATE,
  crashResumeEnabled,
  crashResumePartialEnabled,
  detectInterruptedSessions,
  markSessionInterrupted,
} from "./crash-resume"
// §13.1 (jun-08): store-level aggregate corruption detection + operator
// recovery guidance (diagnostic; never on the hot path).
export type {
  SessionFileHealth,
  SessionFileStatus,
  StoreHealthReport,
  StoreHealthVerdict,
} from "./store-health"
export { buildRecoveryGuidance, checkSessionStoreHealth } from "./store-health"
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
export type {
  PersistedInterruptedTurn,
  SavedSession,
  SavePayload,
  SessionMeta,
} from "./types"
export { SESSION_VERSION } from "./types"
