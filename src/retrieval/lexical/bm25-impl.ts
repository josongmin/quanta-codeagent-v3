/**
 * ADR-0260 — pure in-memory BM25 adapter.
 *
 * Suitable for small-to-medium in-memory corpora (loaded conversation
 * transcripts, search-as-you-type widgets, test fixtures). For on-disk
 * monorepo-scale corpora the ripgrep adapter is the right tool.
 *
 * BM25 formula (Robertson & Zaragoza 2009 — "The Probabilistic Relevance
 * Framework: BM25 and Beyond"):
 *
 *   idf(t)  = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
 *   score(d, q) = Σ_t∈q idf(t) * (f_t,d * (k1 + 1)) /
 *                          (f_t,d + k1 * (1 - b + b * |d| / avgdl))
 *
 * Defaults `k1 = 1.5`, `b = 0.75` are Lucene's published baseline, both
 * configurable via factory options. The sibling `rerank/bm25-secondary`
 * uses the same formula but an ASCII-only tokenizer (different axis);
 * THIS adapter's tokenizer is UTF-8 word-boundary using Unicode property
 * classes, so it tokenises CJK / Korean / Cyrillic / Arabic correctly.
 *
 * Stable, deterministic sort:
 *   1. score desc
 *   2. id asc (byteCompare)
 */

import { byteCompare, err, ok, type Result } from "@/shared"
import type { LexicalDoc, LexicalIndexResult, LexicalQueryOptions, LexicalSearch } from "./port"
import type { LexicalError, LexicalHit } from "./types"

/** Lucene-default BM25 saturation. */
const DEFAULT_K1 = 1.5
/** Lucene-default BM25 length normalisation. */
const DEFAULT_B = 0.75
/** Hard cap on raw query length — defends against accidental whole-file
 *  pastes blowing up tokenisation. */
const MAX_QUERY_BYTES = 64 * 1024

export interface Bm25LexicalSearchOptions {
  /** BM25 saturation. Default 1.5. Clamped to [0, 10]. */
  readonly k1?: number
  /** BM25 length normalisation. Default 0.75. Clamped to [0, 1]. */
  readonly b?: number
}

/** UTF-8 word-boundary tokenizer. A token is a run of Unicode letters /
 *  numbers (`\p{L}` / `\p{N}`); lowercased per Unicode case-fold approx
 *  via `String#toLowerCase()` (sufficient for BM25 — full case-folding is
 *  out of scope for first-stage retrieval). CJK / Korean / Cyrillic /
 *  Arabic are included because the property classes match those scripts. */
export const tokenizeUtf8 = (s: string): string[] => {
  const out: string[] = []
  // \p{L} = any letter, \p{N} = any number. Combined as a single
  // character class so "안녕하세요" is one run, "alpha123" is one run.
  const re = /[\p{L}\p{N}]+/gu
  let m: RegExpExecArray | null = re.exec(s)
  while (m !== null) {
    out.push(m[0].toLowerCase())
    m = re.exec(s)
  }
  return out
}

interface IndexedDoc {
  readonly doc: LexicalDoc
  readonly terms: ReadonlyArray<string>
  readonly tf: ReadonlyMap<string, number>
  readonly length: number
}

interface CorpusState {
  readonly docs: ReadonlyArray<IndexedDoc>
  readonly df: ReadonlyMap<string, number>
  readonly avgdl: number
}

const buildCorpus = (docs: ReadonlyArray<LexicalDoc>): CorpusState => {
  const indexed: IndexedDoc[] = []
  const df = new Map<string, number>()
  let totalLen = 0
  for (const d of docs) {
    const terms = tokenizeUtf8(d.text)
    const tf = new Map<string, number>()
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1)
    indexed.push({ doc: d, terms, tf, length: terms.length })
    totalLen += terms.length
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const avgdl = docs.length === 0 ? 0 : totalLen / docs.length
  return { docs: indexed, df, avgdl }
}

const idfOf = (df: number, N: number): number => Math.log(1 + (N - df + 0.5) / (df + 0.5))

const scoreDoc = (
  d: IndexedDoc,
  qTerms: ReadonlyArray<string>,
  state: CorpusState,
  k1: number,
  b: number,
): number => {
  if (d.length === 0 || qTerms.length === 0) return 0
  const N = state.docs.length
  const lengthNorm = 1 - b + b * (d.length / (state.avgdl || 1))
  let s = 0
  for (const qt of qTerms) {
    const f = d.tf.get(qt)
    if (f === undefined || f === 0) continue
    const dft = state.df.get(qt) ?? 0
    if (dft === 0) continue
    s += idfOf(dft, N) * ((f * (k1 + 1)) / (f + k1 * lengthNorm))
  }
  return s
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** Validate query — closed-arm return for the typed-error branches.
 *  Pulled out of `query` to keep cognitive complexity under the
 *  project cap. */
const validateQuery = (q: string): LexicalError | null => {
  if (q.trim().length === 0) return { kind: "invalid-query", raw: q, reason: "empty" }
  if (q.length > MAX_QUERY_BYTES) {
    return { kind: "invalid-query", raw: q.slice(0, 64), reason: "too-large" }
  }
  return null
}

/** Build the typed hit record honouring the `metadata` optional slot
 *  (omitted-when-absent per project convention). */
const buildHit = (d: { readonly doc: LexicalDoc }, score: number): LexicalHit =>
  d.doc.metadata
    ? { id: d.doc.id, score, text: d.doc.text, metadata: d.doc.metadata }
    : { id: d.doc.id, score, text: d.doc.text }

/** Score every doc against the query terms and return the sorted slice. */
const rankCorpus = (
  state: CorpusState,
  qTerms: ReadonlyArray<string>,
  k1: number,
  b: number,
  k: number,
): ReadonlyArray<LexicalHit> => {
  const scored: LexicalHit[] = []
  for (const d of state.docs) {
    const s = scoreDoc(d, qTerms, state, k1, b)
    if (s <= 0) continue
    scored.push(buildHit(d, s))
  }
  scored.sort((a, h) => (h.score !== a.score ? h.score - a.score : byteCompare(a.id, h.id)))
  return scored.slice(0, k)
}

/** Build a BM25-backed `LexicalSearch`. Stateless beyond the (k1, b)
 *  pair captured at factory time + the indexed corpus state. */
export const createBm25LexicalSearch = (opts: Bm25LexicalSearchOptions = {}): LexicalSearch => {
  const k1 = clamp(opts.k1 ?? DEFAULT_K1, 0, 10)
  const b = clamp(opts.b ?? DEFAULT_B, 0, 1)
  let state: CorpusState = { docs: [], df: new Map(), avgdl: 0 }
  let totalTokens = 0

  return {
    async index(
      docs: ReadonlyArray<LexicalDoc>,
    ): Promise<Result<LexicalIndexResult, LexicalError>> {
      state = buildCorpus(docs)
      totalTokens = state.docs.reduce((acc, d) => acc + d.length, 0)
      return ok({ docs: state.docs.length, tokens: totalTokens })
    },

    async query(
      q: string,
      k: number,
      queryOpts?: LexicalQueryOptions,
    ): Promise<Result<ReadonlyArray<LexicalHit>, LexicalError>> {
      if (queryOpts?.signal?.aborted === true) return err({ kind: "aborted" })
      const invalid = validateQuery(q)
      if (invalid !== null) return err(invalid)
      if (state.docs.length === 0 || k <= 0) return ok([])
      const qTerms = tokenizeUtf8(q.trim())
      // Query had content but tokeniser produced nothing (e.g. all
      // punctuation). Empty hits — not an error.
      if (qTerms.length === 0) return ok([])
      return ok(rankCorpus(state, qTerms, k1, b, k))
    },

    clear(): void {
      state = { docs: [], df: new Map(), avgdl: 0 }
      totalTokens = 0
    },

    size(): number {
      return state.docs.length
    },
  }
}
