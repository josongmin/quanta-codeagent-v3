/** ADR-0398 — atomic single-file commit + sha256 hash helper. Re-exported so
 *  the tool slice can compute / compare precondition hashes WITHOUT crossing
 *  the slice fence into `@/llm`. */
export type { AtomicWriteSync } from "./atomic-write"
export { defaultAtomicWriteSync, sha256Hex, writeFileAtomic } from "./atomic-write"
export { canonicalizePath } from "./fs-jail-lib"
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
  readFileBytes,
  renameFile,
  resolveJailed,
  resolvePath,
  setFsJailDecisionSink,
  statFile,
  writeFile,
} from "./service"
export type {
  RewindOptions,
  RewindToRefOptions,
  ShadowInitResult,
  ShadowOdb,
  ShadowOdbConfig,
  ShadowOdbErrorCode,
  SnapshotDiff,
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
