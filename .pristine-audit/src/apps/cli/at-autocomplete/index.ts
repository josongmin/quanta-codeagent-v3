/**
 * RFC-12 / ADR-0439 — `@`-mention autocomplete leaf barrel.
 *
 * Closed surface for the CLI `@`-completion dropdown. Default-OFF: nothing
 * here runs unless the composition root (gated by `atAutocompleteEnabled`)
 * constructs a provider and threads it into the prompt-pipeline `ux`. With
 * no provider, `raw-line-reader` is byte-identical.
 *
 * Slice-fence: this leaf imports only `@/agent/mention-injection` (the
 * `MentionKind` / `SymbolLookupLspPort` types) + `@/shared` idioms (incl.
 * `@/shared/ignore-matcher` for the recursive file walk) + node builtins.
 * It does NOT import the agent loop or `@/llm`.
 */

export { atAutocompleteEnabled } from "./env"
export { matchTier, rankByTier } from "./fuzzy"
export type { AtCandidate, AtCandidateProvider } from "./port"
export {
  type CompositeAtProviderDeps,
  createCompositeAtProvider,
  type NamedEntry,
} from "./provider"
export {
  createRecursiveFileLister,
  type RecursiveFileListerOptions,
} from "./recursive-file-list"
export {
  type AcceptEdit,
  type AtState,
  acceptSelected,
  atQuery,
  type BackspaceResult,
  type CharResult,
  classifyBackspace,
  classifyChar,
  createAtState,
  dismiss,
  isAtTriggerBoundaryOk,
  selectNext,
  selectPrev,
} from "./state-machine"
export { createSymbolLister, type SymbolListerOptions } from "./symbol-list"
