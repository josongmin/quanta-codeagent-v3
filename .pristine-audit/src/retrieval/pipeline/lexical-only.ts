/** Preset: lexical-only (BM25 / ripgrep) pipeline. ADR-0265 §4 #1. */

import { compose } from "./compose"
import type { LexicalSearch, SearchPipeline } from "./types"

export interface LexicalOnlyOpts {
  readonly lex: LexicalSearch
}

export const lexicalOnlyPipeline = (opts: LexicalOnlyOpts): SearchPipeline =>
  compose([{ kind: "lexical", impl: opts.lex }])
