/**
 * `@/retrieval/lexical` slice barrel — ADR-0260.
 *
 * Re-exports the closed `LexicalSearch` port + two production adapter
 * factories (`createBm25LexicalSearch`, `createRipgrepLexicalSearch`)
 * + the deterministic test stub (`headlessLexicalStub`) + every public
 * type. Composition roots import from the top-level `@/retrieval` barrel,
 * which re-exports these names.
 */

export type { Bm25LexicalSearchOptions } from "./bm25-impl"
export { createBm25LexicalSearch, tokenizeUtf8 } from "./bm25-impl"
export type { HeadlessLexicalStubOptions } from "./headless-stub"
export { headlessLexicalStub } from "./headless-stub"
export type {
  LexicalDoc,
  LexicalIndexResult,
  LexicalQueryOptions,
  LexicalSearch,
} from "./port"
export type {
  RipgrepLexicalSearchOptions,
  RipgrepSpawner,
  RipgrepSpawnOptions,
  RipgrepSpawnResult,
} from "./ripgrep-impl"
export { createBunRipgrepSpawner, createRipgrepLexicalSearch } from "./ripgrep-impl"
export type {
  LexicalDegradeReason,
  LexicalError,
  LexicalErrorKind,
  LexicalHit,
} from "./types"
export { ALL_LEXICAL_ERROR_KINDS } from "./types"
