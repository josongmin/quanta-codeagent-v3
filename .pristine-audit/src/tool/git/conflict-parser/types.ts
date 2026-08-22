/**
 * SSOT forwarder (T13, audit L9 H13) — see ./parse.
 *
 * The conflict-parser type contract has ONE owner: `@/git/conflict-parser`.
 * This module previously re-declared a structurally-identical (but separately
 * maintained) copy. It now re-exports the canonical types so the tool layer and
 * the git library slice share a single source of truth.
 */

export type {
  ConflictBlock,
  ConflictMarkerStyle,
  ConflictParseDiagnostic,
  ConflictParseResult,
} from "@/git/conflict-parser"
export { ALL_MARKER_STYLES, ConflictParserInputError } from "@/git/conflict-parser"
