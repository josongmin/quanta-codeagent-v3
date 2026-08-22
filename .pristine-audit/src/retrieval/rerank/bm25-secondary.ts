/**
 * BM25-secondary reranker — re-score first-stage hits with BM25 against the
 * query so an embedding-first pipeline can recover from a paraphrase that
 * embedded the wrong topic. Composes WITH first-stage scores rather than
 * replacing them (final = α·first + (1-α)·bm25). α defaults to 0.5.
 *
 * BM25 parameters k1=1.5, b=0.75 are the Lucene defaults (Robertson &
 * Zaragoza 2009, "The Probabilistic Relevance Framework: BM25 and Beyond")
 * — published baseline, NOT invented. Self-measured corpus statistics
 * (avgdl, df) are computed from the candidate set itself (no global IDF
 * corpus needed — the reranker is self-contained).
 *
 * Pure. Deterministic for a fixed candidate set + query. Stable sort:
 *   1. fused score desc
 *   2. id ASC (lexical) — stable tiebreak
 */
import { byteCompare } from "@/shared"
import type { RerankInput, RerankPort, RetrievalCandidate } from "../types"

/** Lucene-default BM25 saturation. */
const K1 = 1.5
/** Lucene-default BM25 length normalization. */
const B = 0.75
/** Default first-stage / second-stage blend. Equal weight. */
const DEFAULT_ALPHA = 0.5

/** Lowercased, alpha-numeric tokenizer — matches what `localize` does so
 *  rerank semantics agree with the foundation. */
const tokenize = (s: string): string[] => {
  const out: string[] = []
  const re = /[A-Za-z0-9]+/g
  let m: RegExpExecArray | null = re.exec(s)
  while (m !== null) {
    out.push(m[0].toLowerCase())
    m = re.exec(s)
  }
  return out
}

/** Per-term doc-frequency over the candidate set. */
const computeDf = (docs: readonly string[][]): Map<string, number> => {
  const df = new Map<string, number>()
  for (const doc of docs) {
    const seen = new Set<string>()
    for (const t of doc) {
      if (seen.has(t)) continue
      seen.add(t)
      df.set(t, (df.get(t) ?? 0) + 1)
    }
  }
  return df
}

/** BM25 IDF with Lucene's +0.5 / +0.5 / +1 smoothing — non-negative even
 *  when df > N/2. */
const idfOf = (df: number, N: number): number => Math.log(1 + (N - df + 0.5) / (df + 0.5))

/** Score one doc against the query terms. */
const scoreDoc = (
  doc: readonly string[],
  qTerms: readonly string[],
  df: Map<string, number>,
  N: number,
  avgdl: number,
): number => {
  if (doc.length === 0 || qTerms.length === 0) return 0
  const tf = new Map<string, number>()
  for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1)
  let s = 0
  const lengthNorm = 1 - B + B * (doc.length / (avgdl || 1))
  for (const qt of qTerms) {
    const f = tf.get(qt)
    if (f === undefined || f === 0) continue
    const dft = df.get(qt) ?? 0
    if (dft === 0) continue
    const idf = idfOf(dft, N)
    s += idf * ((f * (K1 + 1)) / (f + K1 * lengthNorm))
  }
  return s
}

export interface Bm25SecondaryOptions {
  /** Blend weight on the first-stage score. Default 0.5. Clamped to [0,1]. */
  alpha?: number
}

/**
 * Build a BM25-secondary reranker. Stateless beyond `alpha` — every call
 * recomputes corpus statistics from the candidate set, so it works the same
 * across changing pipelines without external corpus state.
 */
export const createBm25SecondaryReranker = (opts: Bm25SecondaryOptions = {}): RerankPort => {
  const aRaw = opts.alpha ?? DEFAULT_ALPHA
  const alpha = aRaw < 0 ? 0 : aRaw > 1 ? 1 : aRaw
  return {
    kind: "bm25-secondary",
    async rerank(input: RerankInput): Promise<readonly RetrievalCandidate[]> {
      const cands = input.candidates
      if (cands.length === 0) return []
      const docs = cands.map((c) => tokenize(c.text))
      const qTerms = tokenize(input.query)
      const N = docs.length
      const df = computeDf(docs)
      const totalLen = docs.reduce((acc, d) => acc + d.length, 0)
      const avgdl = N > 0 ? totalLen / N : 0
      const scored = cands.map((c, i): RetrievalCandidate => {
        const d = docs[i]
        const bm25 = d === undefined ? 0 : scoreDoc(d, qTerms, df, N, avgdl)
        const fused = alpha * c.score + (1 - alpha) * bm25
        return { ...c, score: fused }
      })
      scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : byteCompare(a.id, b.id)))
      const limit = input.limit
      if (typeof limit === "number" && limit >= 0 && limit < scored.length) {
        return scored.slice(0, limit)
      }
      return scored
    },
  }
}
