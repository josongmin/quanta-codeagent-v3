/**
 * `@/git` — pure / library-slice git utilities. Importers must inject any
 * subprocess access via the closed ports declared here.
 *
 * No upward deps. The existing `src/tool/git/*` first-class tools are
 * unrelated (they live downstream in `@/tool`); this slice hosts SHARED
 * git plumbing that both the tools and higher-layer flows (reactor,
 * babysit) can reuse without each owning their own subprocess seam.
 */

export type {
  FileLockPort,
  GitProcessPort,
  GitProcessResult,
  SnapshotClock,
  SnapshotError,
  SnapshotOpts,
  SnapshotResult,
  SnapshotStage,
} from "./cloud-branch-snapshot"
export {
  createInMemoryFileLock,
  SnapshotErrorThrown,
  snapshotDirtyToCloudBranch,
} from "./cloud-branch-snapshot"

export type {
  ConflictBlock,
  ConflictParseDiagnostic,
  ConflictParseResult,
} from "./conflict-parser"
export { ConflictParserInputError, parseConflicts } from "./conflict-parser"
