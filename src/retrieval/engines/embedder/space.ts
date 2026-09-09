/**
 * Embedding-space identity (W0.6 / E-EMBED-01).
 *
 * Index and query must share this identity. Same-dimension hash vectors are
 * a different space from a provider model.
 */
import { createHash } from "node:crypto"

export interface EmbeddingSpace {
  readonly model: string
  readonly revision: string
  readonly dimensions: number
  readonly normalization: "l2" | "none"
}

export const HASH_EMBEDDING_SPACE: EmbeddingSpace = {
  model: "legacy:hash-embed",
  revision: "1",
  dimensions: 64,
  normalization: "l2",
}

export const embeddingSpaceKey = (space: EmbeddingSpace): string =>
  `${space.model}|${space.revision}|${space.dimensions}|${space.normalization}`

/** Stable, bounded identifier suitable for remote table/collection names. */
export const embeddingSpaceFingerprint = (space: EmbeddingSpace): string =>
  createHash("sha256").update(embeddingSpaceKey(space)).digest("hex").slice(0, 24)

/**
 * Derive a physical remote namespace from the operator's logical base and the
 * complete embedding-space identity. A new model/revision never overwrites the
 * old index; rollback resolves the original namespace again.
 */
export const embeddingSpaceNamespace = (base: string, space: EmbeddingSpace): string =>
  `qes_${createHash("sha256")
    .update(base)
    .update("\0")
    .update(embeddingSpaceKey(space))
    .digest("hex")
    .slice(0, 32)}`

export const embeddingSpacesEqual = (a: EmbeddingSpace, b: EmbeddingSpace): boolean =>
  embeddingSpaceKey(a) === embeddingSpaceKey(b)

export const embeddingSpaceFromCaps = (
  caps: { readonly dim: number; readonly modelTag: string },
  revision = "1",
  normalization: EmbeddingSpace["normalization"] = "l2",
): EmbeddingSpace => ({
  model: caps.modelTag,
  revision,
  dimensions: caps.dim,
  normalization,
})
