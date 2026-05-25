/**
 * Closed `Reranker` port — vendor-aware sibling to `RerankPort` (ADR-0262).
 *
 * Single method (`rerank`) + introspection (`capabilities`). `Result`-shaped
 * because vendor failures (rate-limit, auth, transport) are expected
 * domain events; the existing pure `RerankPort` throws because its
 * strategies CANNOT fail at the domain level.
 *
 * Boundary contract (enforced by every adapter, sealed by hellgate):
 *   - `query` empty/whitespace                 → `err({ kind: "empty-query" })`
 *   - `hits.length === 0` or `k === 0`         → `ok([])` without any HTTP
 *   - `hits.length > maxDocsPerCall`           → `err({ kind: "too-many-docs" })`
 *   - `k > hits.length`                        → caller receives all hits ranked
 *   - `originalIndex`                          → always the index in INPUT `hits`
 *
 * The port is leaf-pure — no `@/agent`, no `@/llm`, no `@/memory`. The slice
 * isolation rule allows `@/shared` only.
 */
import type { Result } from "@/shared"
import type { RerankError, RerankedHit, RerankerCapabilities } from "./types"

export interface Reranker<T = unknown> {
  /**
   * Rerank `hits` against `query`, returning at most `k` results in
   * descending relevance.
   */
  rerank(
    query: string,
    hits: readonly T[],
    k: number,
  ): Promise<Result<readonly RerankedHit<T>[], RerankError>>

  capabilities(): RerankerCapabilities
}
