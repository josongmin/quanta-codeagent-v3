export type { FileSystemPort, JailedPath } from "./service"
export {
  clearFsJailDecisionSink,
  defaultFileSystemPort,
  deleteFile,
  enforceJail,
  FsJailError,
  fileExists,
  parentDir,
  readFile,
  renameFile,
  resolveJailed,
  resolvePath,
  setFsJailDecisionSink,
  statFile,
  writeFile,
} from "./service"
export type {
  RewindOptions,
  ShadowInitResult,
  ShadowOdb,
  ShadowOdbConfig,
  ShadowOdbErrorCode,
  SnapshotMetadata,
} from "./shadow-odb"
// Shadow git ODB (ADR-0108) — closed-port snapshot store separate from
// the user's `.git`. Default-OFF: consumers must explicitly instantiate
// `defaultShadowOdb()` to opt in.
export {
  DEFAULT_SHADOW_ODB_MAX_BYTES,
  defaultShadowOdb,
  evictLru,
  SHADOW_LAST_REF,
  SHADOW_LAST_VERIFIED_REF,
  SHADOW_PRE_REWIND_REF_PREFIX,
  ShadowOdbError,
  workspaceHash,
} from "./shadow-odb"
export type { FileInfo } from "./types"
