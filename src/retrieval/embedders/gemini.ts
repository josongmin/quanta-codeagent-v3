/**
 * Gemini embedding adapter — TYPE-LEVEL STUB (ADR-0159 §Axis D).
 *
 * Real REST contract reference (Google Generative AI):
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:batchEmbedContents
 *   Body: { requests: [{ content: { parts: [{ text }] } }] }
 *   Resp: { embeddings: [{ values: number[] }] }
 *
 * To wire at runtime: replace the `embed` body with the HTTP call.
 */
import type { EmbeddingAdapterOptions, EmbeddingPort } from "../embedding-port"
import { RetrievalError } from "../types"

const DEFAULT_MODEL = "text-embedding-004"

export type GeminiEmbedderOptions = EmbeddingAdapterOptions

export const createGeminiEmbedder = (opts: GeminiEmbedderOptions): EmbeddingPort => {
  const model = opts.model ?? DEFAULT_MODEL
  return {
    vendor: "gemini",
    model,
    async embed(_texts: readonly string[]): Promise<readonly (readonly number[])[]> {
      throw new RetrievalError(
        "gemini embedder not yet wired at runtime (ADR-0159 type-level stub)",
      )
    },
  }
}
