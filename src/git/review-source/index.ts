/** RFC-02 — `@/git/review-source` sub-barrel. Pure diff-source semantics +
 *  generated-file filter. Consumed by `@/tool/git` (the adapter/tool layer). */

export {
  applyGeneratedFilter,
  type GeneratedFilterResult,
  LINGUIST_GENERATED,
  parseCheckAttrZ,
  partitionGenerated,
} from "./generated-attributes"
export type { CheckAttrResult, GeneratedAttributePort, GitReadPort } from "./ports"
export { resolveDiffSource } from "./resolve"
export type {
  DiffSource,
  DiffSourceResolution,
  DiffSourceUnavailableReason,
  GitDiffOperation,
} from "./types"
export { DIFF_SOURCE_KINDS, diffSourceSchema, EMPTY_TREE_OID } from "./types"
