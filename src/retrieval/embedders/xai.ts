/**
 * xAI embedding adapter — TYPE-LEVEL STUB (ADR-0159 §Axis D).
 *
 * xAI's embedding API is OpenAI-compatible at the wire level:
 *   POST https://api.x.ai/v1/embeddings
 *   Body: { model, input: string[] }
 *   Resp: { data: [{ embedding: number[] }] }
 *
 * To wire at runtime, reuse the openai.ts pattern with `baseURL =
 * "https://api.x.ai/v1"` and an injected HTTP seam.
 */
import type { EmbeddingAdapterOptions, EmbeddingPort } from "../embedding-port"
import { RetrievalError } from "../types"

const DEFAULT_MODEL = "v1"

export type XaiEmbedderOptions = EmbeddingAdapterOptions

export const createXaiEmbedder = (opts: XaiEmbedderOptions): EmbeddingPort => {
  const model = opts.model ?? DEFAULT_MODEL
  return {
    vendor: "xai",
    model,
    async embed(_texts: readonly string[]): Promise<readonly (readonly number[])[]> {
      throw new RetrievalError("xai embedder not yet wired at runtime (ADR-0159 type-level stub)")
    },
  }
}
