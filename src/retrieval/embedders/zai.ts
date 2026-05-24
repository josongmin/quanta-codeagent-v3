/**
 * Z.ai (Zhipu) embedding adapter — TYPE-LEVEL STUB (ADR-0159 §Axis D).
 *
 * Z.ai's embeddings endpoint:
 *   POST https://open.bigmodel.cn/api/paas/v4/embeddings
 *   Body: { model, input: string[] }
 *   Resp: { data: [{ embedding: number[] }] }
 */
import type { EmbeddingAdapterOptions, EmbeddingPort } from "../embedding-port"
import { RetrievalError } from "../types"

const DEFAULT_MODEL = "embedding-2"

export type ZaiEmbedderOptions = EmbeddingAdapterOptions

export const createZaiEmbedder = (opts: ZaiEmbedderOptions): EmbeddingPort => {
  const model = opts.model ?? DEFAULT_MODEL
  return {
    vendor: "zai",
    model,
    async embed(_texts: readonly string[]): Promise<readonly (readonly number[])[]> {
      throw new RetrievalError("zai embedder not yet wired at runtime (ADR-0159 type-level stub)")
    },
  }
}
