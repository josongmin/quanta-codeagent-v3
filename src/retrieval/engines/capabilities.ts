/**
 * Capability negotiation between `Embedder` and `VectorStore` — ADR-0261.
 *
 * Fails fast at composition time on dim or algorithm mismatch with a typed
 * error — never at query time with a numeric TypeError.
 */
import { err, ok, type Result } from "@/shared"
import type { EmbedderCapabilities } from "./embedder/types"
import type { StoreCapabilities } from "./store/types"

export interface NegotiatedCaps {
  readonly dim: number
  readonly distMetric: "cosine"
  readonly modelTag: string
  readonly persistent: boolean
}

export type MismatchError =
  | { readonly kind: "dim-exceeds-store"; readonly dim: number; readonly storeMax: number }
  | { readonly kind: "alg-incompatible"; readonly embedderAlg: string; readonly storeAlg: string }

export const negotiateCapabilities = (
  embCaps: EmbedderCapabilities,
  storeCaps: StoreCapabilities,
): Result<NegotiatedCaps, MismatchError> => {
  if (embCaps.dim > storeCaps.maxDim) {
    return err({ kind: "dim-exceeds-store", dim: embCaps.dim, storeMax: storeCaps.maxDim })
  }
  // v1: only cosine is supported on the store side; this guard exists so
  // future engines (dot / l2 / hamming) cannot silently mismatch.
  if (storeCaps.distMetric !== "cosine") {
    return err({
      kind: "alg-incompatible",
      embedderAlg: "cosine",
      storeAlg: storeCaps.distMetric,
    })
  }
  return ok({
    dim: embCaps.dim,
    distMetric: "cosine",
    modelTag: embCaps.modelTag,
    persistent: storeCaps.persistent,
  })
}
