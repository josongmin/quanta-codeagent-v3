export type { FileSystemPort, JailedPath } from "./service"
export {
  defaultFileSystemPort,
  deleteFile,
  FsJailError,
  fileExists,
  parentDir,
  readFile,
  renameFile,
  resolveJailed,
  resolvePath,
  statFile,
  writeFile,
} from "./service"
export type { FileInfo } from "./types"
// Shadow git ODB (ADR-0108) — closed-port snapshot store separate from
// the user's `.git`. Default-OFF: consumers must explicitly instantiate
// `defaultShadowOdb()` to opt in.
export {
  DEFAULT_SHADOW_ODB_MAX_BYTES,
  SHADOW_LAST_REF,
  ShadowOdbError,
  defaultShadowOdb,
  evictLru,
  workspaceHash,
} from "./shadow-odb"
export type {
  ShadowInitResult,
  ShadowOdb,
  ShadowOdbConfig,
  ShadowOdbErrorCode,
} from "./shadow-odb"
