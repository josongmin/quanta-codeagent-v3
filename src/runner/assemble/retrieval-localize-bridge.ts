/**
 * Localize ↔ Retrieval bridge — surface-agnostic adapter that funnels
 * lexical (BM25-style) and embedding-style search hits through the ADR-0159
 * retrieval stack's `runHybridQuery` funnel.
 *
 * The `localize` tool (`src/tool/localize/index.ts`) is UNTOUCHED — its BM25
 * default path stays the byte-identical entry every existing caller sees.
 * This bridge provides the opt-in funnel for consumers (CLI surface, test
 * harness, future tool) who want to compose BM25 + embedding sources with
 * an RRF or BM25-secondary reranker on top.
 *
 * Default-OFF: when `stack` is undefined, the bridge passes lexical hits
 * through unchanged (identity wire). The retrieval stack opt-in is the
 * SINGLE knob that flips behavior.
 *
 * Slice fence: lives under `@/runner` (not `@/tool`) because `@/tool` is
 * forbidden from reaching `@/retrieval`. Callers thread the bridge result
 * onto the model's view via the surface (e.g. CLI output, future
 * `hybrid_localize` tool that takes the stack via dispatch seam).
 */
import {
  type HybridQueryInput,
  type QueryType,
  type RetrievalCandidate,
  runHybridQuery,
} from "@/retrieval"
import type { RetrievalStack } from "./retrieval"

/** A single lexical hit — minimum shape the bridge needs to wrap a localize-
 *  style row as a {@link RetrievalCandidate}. Callers may pass any object
 *  that exposes these fields (BM25 hit, ripgrep row, MCP search result).
 *  Structural type so `@/tool/localize/Hit` is assignable without import. */
export interface LexicalHit {
  readonly file: string
  readonly line: number
  readonly text: string
  readonly score?: number
}

/** Convert a lexical hit to a {@link RetrievalCandidate} keyed by `file:line`.
 *  Source is `bm25` (so RRF treats it as a single ranked list of that source).
 *  Score defaults to 0 — the reranker will recompute if it cares about
 *  similarity. */
export const lexicalHitToCandidate = (hit: LexicalHit, ordinal: number): RetrievalCandidate => ({
  id: `${hit.file}:${hit.line}`,
  text: hit.text,
  // Use ordinal-derived score when caller did not supply one, so RRF gets a
  // monotone rank-position signal rather than constant zeros.
  score: typeof hit.score === "number" ? hit.score : 1 / (ordinal + 1),
  source: "bm25",
  metadata: { file: hit.file, line: hit.line, list: "bm25" },
})

/** Convert a list of lexical hits to retrieval candidates, preserving input
 *  order via the `ordinal` slot. Pure. */
export const lexicalHitsToCandidates = (
  hits: readonly LexicalHit[],
): readonly RetrievalCandidate[] => hits.map((h, i) => lexicalHitToCandidate(h, i))

/** Input shape for {@link runLocalizeHybrid}. Callers supply BOTH sources;
 *  the funnel picks which to call based on `type`. The `stack` carries the
 *  rerank port (final stage). */
export interface LocalizeHybridInput {
  readonly query: string
  readonly type: QueryType
  readonly bm25Source: () => Promise<readonly LexicalHit[]>
  readonly embeddingSource?: () => Promise<readonly RetrievalCandidate[]>
  readonly stack?: RetrievalStack
  readonly limit?: number
}

/** Default no-op embedding source. Used when the caller did not supply one
 *  but the type was `embeddings` or `hybrid`; produces an empty list so the
 *  funnel stays well-defined (RRF over [bm25, []] is just BM25 reranked by
 *  rank). */
const EMPTY_EMBED_SOURCE = async (): Promise<readonly RetrievalCandidate[]> => []

/**
 * Run the localize-shaped query through the retrieval funnel.
 *
 * Default-OFF: `stack` absent ⇒ identity behavior. The lexical hits are
 * converted to candidates and returned in input order (no rerank pass).
 *
 * On opt-in: the funnel runs the configured stages (BM25 / embedding /
 * both) and applies the stack's `defaultReranker` as the final pass. RRF is
 * automatic in the `hybrid` type (the funnel fuses BM25 + embedding before
 * the final rerank).
 */
export const runLocalizeHybrid = async (
  input: LocalizeHybridInput,
): Promise<readonly RetrievalCandidate[]> => {
  const bm25SourceCands = async (): Promise<readonly RetrievalCandidate[]> => {
    const hits = await input.bm25Source()
    return lexicalHitsToCandidates(hits)
  }
  const embeddingSource = input.embeddingSource ?? EMPTY_EMBED_SOURCE
  if (input.stack === undefined) {
    // Identity path — just run BM25, skip embedding/RRF/rerank. Byte-
    // identical to what the localize tool would surface if it had been
    // called directly (modulo metadata.list / source fields, which are
    // additive — no caller mutation).
    return bm25SourceCands()
  }
  const funnel: HybridQueryInput = {
    query: input.query,
    type: input.type,
    bm25Source: bm25SourceCands,
    embeddingSource,
    rerank: input.stack.defaultReranker,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  }
  return runHybridQuery(funnel)
}
