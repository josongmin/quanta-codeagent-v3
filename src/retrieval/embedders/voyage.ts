/**
 * Voyage AI embedding adapter for the `@/retrieval` slice.
 *
 * Voyage's REST contract (v1):
 *   POST https://api.voyageai.com/v1/embeddings
 *   Body: { model, input: string[] }
 *   Resp: { data: [{ embedding: number[] }] }
 *
 * Transport is INJECTED via {@link VoyageHttp} so tests can avoid network
 * and the slice never imports a vendor SDK.
 */
import { LLMError } from "@/shared"
import { chunkBatches } from "@/shared/chunk"
import type { EmbeddingAdapterOptions, EmbeddingPort } from "../embedding-port"
import { isAbortError, safeVendorErrMessage, throwIfAborted } from "./_abort"

const DEFAULT_MODEL = "voyage-3"
const DEFAULT_BATCH = 128

export interface VoyageHttp {
  embeddingsCreate(
    body: {
      model: string
      input: readonly string[]
    },
    opts?: { signal?: AbortSignal },
  ): Promise<{ data: { embedding: readonly number[] }[] }>
}

export interface VoyageEmbedderOptions extends EmbeddingAdapterOptions {
  http: VoyageHttp
}

export const createVoyageEmbedder = (opts: VoyageEmbedderOptions): EmbeddingPort => {
  const model = opts.model ?? DEFAULT_MODEL
  const batchSize = opts.batchSize ?? DEFAULT_BATCH
  return {
    vendor: "voyage",
    model,
    async embed(
      texts: readonly string[],
      callOpts?: { signal?: AbortSignal },
    ): Promise<readonly (readonly number[])[]> {
      if (texts.length === 0) return []
      const out: (readonly number[])[] = []
      for (const batch of chunkBatches(texts, batchSize)) {
        throwIfAborted(callOpts?.signal)
        try {
          const res = await opts.http.embeddingsCreate(
            { model, input: batch },
            callOpts?.signal === undefined ? undefined : { signal: callOpts.signal },
          )
          for (const d of res.data) out.push(d.embedding)
        } catch (e) {
          if (isAbortError(e)) throw e
          throw new LLMError(`Voyage retrieval embeddings failed: ${safeVendorErrMessage(e)}`, {
            cause: e,
          })
        }
      }
      return out
    },
  }
}
