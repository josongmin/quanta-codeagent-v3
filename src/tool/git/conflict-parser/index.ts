/**
 * Public barrel for the pure git merge-conflict parser.
 *
 * Slice isolation: this module is consumed by the `git_conflict_inspect` tool
 * (its sibling) and any future fix-merge-conflicts skill / tool — pure, no I/O,
 * only `@/shared` deps. See `./types.ts` for the contract doc-comments.
 */

export { parseConflicts } from "./parse"
export type {
  ConflictBlock,
  ConflictMarkerStyle,
  ConflictParseDiagnostic,
  ConflictParseResult,
} from "./types"
export { ALL_MARKER_STYLES, ConflictParserInputError } from "./types"
