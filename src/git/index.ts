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
// RFC-02 — review diff-source semantics (closed union resolver + generated-file
// filter). Pure leaf; all git reads arrive through injected ports whose concrete
// impls live in `@/tool/git/review-source-adapter`.
export type {
  CheckAttrResult,
  DiffSource,
  DiffSourceResolution,
  DiffSourceUnavailableReason,
  GeneratedAttributePort,
  GeneratedFilterResult,
  GitDiffOperation,
  GitReadPort,
} from "./review-source"
export {
  applyGeneratedFilter,
  DIFF_SOURCE_KINDS,
  diffSourceSchema,
  EMPTY_TREE_OID,
  LINGUIST_GENERATED,
  parseCheckAttrZ,
  partitionGenerated,
  resolveDiffSource,
} from "./review-source"
