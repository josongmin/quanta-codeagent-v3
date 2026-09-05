/**
 * Identity reranker — pass-through. Returns candidates unchanged in their
 * incoming order, capped by `limit` if provided. The "no preference" default
 * — wire when the operator has not committed to a rerank strategy yet.
 *
 * Pure. Deterministic. Async only to satisfy the {@link RerankPort} contract.
 */
import type { RerankInput, RerankPort, RetrievalCandidate } from "../types"

export const identityRerankPort: RerankPort = {
  kind: "identity",
  async rerank(input: RerankInput): Promise<readonly RetrievalCandidate[]> {
    const limit = input.limit
    if (typeof limit === "number" && limit >= 0 && limit < input.candidates.length) {
      return input.candidates.slice(0, limit)
    }
    // Defensive copy so callers cannot mutate the slice's view (the input
    // candidates array is readonly but a downcast caller could still try).
    return [...input.candidates]
  },
}
