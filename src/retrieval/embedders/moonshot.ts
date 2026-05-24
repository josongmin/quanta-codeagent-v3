/**
 * Moonshot AI embedding adapter — TYPE-LEVEL STUB (ADR-0159 §Axis D).
 *
 * Moonshot's API is OpenAI-compatible at the wire level:
 *   POST https://api.moonshot.cn/v1/embeddings
 *   Body: { model, input: string[] }
 *   Resp: { data: [{ embedding: number[] }] }
 */
import type { EmbeddingAdapterOptions, EmbeddingPort } from "../embedding-port"
import { RetrievalError } from "../types"

const DEFAULT_MODEL = "moonshot-embed-v1"

export type MoonshotEmbedderOptions = EmbeddingAdapterOptions

export const createMoonshotEmbedder = (opts: MoonshotEmbedderOptions): EmbeddingPort => {
  const model = opts.model ?? DEFAULT_MODEL
  return {
    vendor: "moonshot",
    model,
    async embed(_texts: readonly string[]): Promise<readonly (readonly number[])[]> {
      throw new RetrievalError(
        "moonshot embedder not yet wired at runtime (ADR-0159 type-level stub)",
      )
    },
  }
}
