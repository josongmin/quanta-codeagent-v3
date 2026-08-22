/**
 * Cohere embedding adapter — TYPE-LEVEL STUB (ADR-0159 §Axis D).
 *
 * The port shape is locked here so a later runtime wiring is a one-file
 * substitution. The current `embed()` THROWS so accidental use fails at the
 * boundary, not silently.
 *
 * Real REST contract reference:
 *   POST https://api.cohere.com/v2/embed
 *   Body: { model, texts: string[], input_type: "search_document" | ... }
 *   Resp: { embeddings: { float: number[][] } }
 *
 * To wire at runtime: replace the `embed` body with the HTTP call (mirror
 * the openai.ts / voyage.ts pattern: inject `CohereHttp`).
 */
import type { EmbeddingAdapterOptions, EmbeddingPort } from "../embedding-port"
import { RetrievalError } from "../types"

const DEFAULT_MODEL = "embed-english-v3.0"

export type CohereEmbedderOptions = EmbeddingAdapterOptions

export const createCohereEmbedder = (opts: CohereEmbedderOptions): EmbeddingPort => {
  const model = opts.model ?? DEFAULT_MODEL
  return {
    vendor: "cohere",
    model,
    async embed(
      _texts: readonly string[],
      _opts?: { signal?: AbortSignal },
    ): Promise<readonly (readonly number[])[]> {
      throw new RetrievalError(
        "cohere embedder not yet wired at runtime (ADR-0159 type-level stub)",
      )
    },
  }
}
