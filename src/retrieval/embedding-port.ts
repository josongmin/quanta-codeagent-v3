/**
 * Multi-vendor embedding port — generic seam over every embedding provider.
 *
 * Each concrete adapter lives in `src/retrieval/embedders/<vendor>.ts` and
 * implements {@link EmbeddingPort} with its own `vendor` discriminator.
 * V1 runtime: `openai` + `voyage` are wired against the real HTTP/SDK.
 * The remaining 6 (`cohere/gemini/xai/moonshot/nvidia/zai`) are TYPE-LEVEL
 * adapter stubs — typed constructors that THROW `RetrievalError("vendor
 * not yet wired at runtime")` from `embed()` so any code that wires them
 * by accident fails loudly at the boundary.
 *
 * Locking the wire-shape across all 8 vendors now means any later runtime
 * wiring is a one-file substitution, not an architecture change.
 */

export type EmbeddingVendor =
  | "openai"
  | "voyage"
  | "cohere"
  | "gemini"
  | "xai"
  | "moonshot"
  | "nvidia"
  | "zai"

export interface EmbeddingPort {
  readonly vendor: EmbeddingVendor
  readonly model: string
  /**
   * Embed `texts` in input order. Each output vector corresponds to the
   * text at the same index. No padding / trimming — adapters return the
   * vector their provider produced.
   */
  embed(
    texts: readonly string[],
    opts?: { signal?: AbortSignal },
  ): Promise<readonly (readonly number[])[]>
}

/** Common options every vendor adapter accepts. Concrete adapters may add
 *  vendor-specific fields by extending this. */
export interface EmbeddingAdapterOptions {
  apiKey: string
  model?: string
  baseURL?: string
  batchSize?: number
}
