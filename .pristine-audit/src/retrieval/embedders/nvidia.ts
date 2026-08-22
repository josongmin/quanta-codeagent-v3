/**
 * NVIDIA NIM embedding adapter — TYPE-LEVEL STUB (ADR-0159 §Axis D).
 *
 * NVIDIA NIM embeddings (OpenAI-compatible):
 *   POST https://integrate.api.nvidia.com/v1/embeddings
 *   Body: { model, input: string[] }
 *   Resp: { data: [{ embedding: number[] }] }
 */
import type { EmbeddingAdapterOptions, EmbeddingPort } from "../embedding-port"
import { RetrievalError } from "../types"

const DEFAULT_MODEL = "nvidia/nv-embedqa-e5-v5"

export type NvidiaEmbedderOptions = EmbeddingAdapterOptions

export const createNvidiaEmbedder = (opts: NvidiaEmbedderOptions): EmbeddingPort => {
  const model = opts.model ?? DEFAULT_MODEL
  return {
    vendor: "nvidia",
    model,
    async embed(
      _texts: readonly string[],
      _opts?: { signal?: AbortSignal },
    ): Promise<readonly (readonly number[])[]> {
      throw new RetrievalError(
        "nvidia embedder not yet wired at runtime (ADR-0159 type-level stub)",
      )
    },
  }
}
