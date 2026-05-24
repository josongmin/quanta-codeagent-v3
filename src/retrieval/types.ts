/**
 * @/retrieval public types — Phase A core (ADR-0159).
 *
 * Every primitive in this slice (rerank registry, chunk-bucket, commit-embedder,
 * multi-vendor embedding port, hybrid query) consumes / produces values from
 * this module. Keeping the types here lets concrete adapter files reach a
 * SINGLE source of truth without back-edges from rerank → embedders → rerank
 * etc.
 *
 * The slice is a leaf — depends on `@/shared` only. No `@/llm`, no `@/memory`,
 * no `@/storage`. External vendors (OpenAI, Voyage, git) enter via closed
 * ports declared at the file that needs them.
 */
import { QuantaError } from "@/shared"

/**
 * A unit of retrievable text with provenance. Sources:
 *   - `bm25`     — first-stage lexical hit (e.g. ripgrep / Lucene)
 *   - `embedding` — first-stage vector hit (cosine over query embedding)
 *   - `lexical`   — non-BM25 lexical (substring, fuzzy)
 *   - `hybrid`    — already-fused candidate (from RRF or other fuser)
 *   - `external`  — a candidate supplied by the caller's own retrieval
 *                   pipeline (e.g. an external vector store the agent
 *                   doesn't own); rerank can still re-score it.
 *
 * Scores are NOT comparable across sources without normalization. A reranker
 * is responsible for putting them on the same scale before it sorts.
 */
export interface RetrievalCandidate {
  readonly id: string
  readonly text: string
  readonly score: number
  readonly source: "bm25" | "embedding" | "lexical" | "hybrid" | "external"
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Input shape every {@link RerankPort} accepts. LSP — uniform contract. */
export interface RerankInput {
  readonly query: string
  readonly candidates: readonly RetrievalCandidate[]
  /** Cap the output length. Default: keep all (no truncation). */
  readonly limit?: number
}

/**
 * Discriminated union of built-in reranker strategies. Adding a new kind
 * here is the OCP signal — every consumer (registry, type-narrowing) gets
 * an exhaustive-check fail at compile time.
 */
export type RerankerKind = "identity" | "bm25-secondary" | "tier-aware" | "score-fusion-rrf"

/**
 * A reranker strategy. Pure async (no I/O, no clock) — every dependency
 * (tokenizer, scorer, tier classifier) is injected at construction. The
 * `kind` is the discriminator the registry uses to look the instance up.
 */
export interface RerankPort {
  readonly kind: RerankerKind
  rerank(input: RerankInput): Promise<readonly RetrievalCandidate[]>
}

/**
 * Slice-local error. Extends `QuantaError` so the existing error taxonomy
 * (`.code`) keeps working — downstream handlers branch on `code` not class.
 */
export class RetrievalError extends QuantaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("retrieval", message, options)
  }
}
