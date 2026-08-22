/**
 * RerankRegistry — keyed lookup for {@link RerankPort} instances.
 *
 * Closed by default: registration is explicit. The assembler decides which
 * reranker kinds are wired in the build. Looking up an unregistered kind
 * throws {@link RetrievalError} (NEVER fall back silently — the operator
 * asked for a specific strategy by name).
 *
 * Independent of any concrete reranker — `identityReranker`, `rrfReranker`,
 * `createBm25SecondaryReranker(...)`, `createTierAwareReranker(...)` are all
 * registered the same way: `register(port)`.
 */
import type { RerankerKind, RerankPort } from "./types"
import { RetrievalError } from "./types"

export class RerankRegistry {
  private readonly byKind = new Map<RerankerKind, RerankPort>()

  /** Idempotent — re-registering the same kind replaces (used by tests). */
  register(port: RerankPort): void {
    this.byKind.set(port.kind, port)
  }

  /** Throws {@link RetrievalError} if kind is not registered. */
  get(kind: RerankerKind): RerankPort {
    const found = this.byKind.get(kind)
    if (found === undefined) {
      throw new RetrievalError(`reranker not registered: ${kind}`)
    }
    return found
  }

  /** True iff the kind has been registered. */
  has(kind: RerankerKind): boolean {
    return this.byKind.has(kind)
  }

  /** Deterministic list of registered kinds (sorted for stable output). */
  kinds(): readonly RerankerKind[] {
    return [...this.byKind.keys()].sort()
  }
}
