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

/** One batch → its vectors, carrying the adapter's whole error contract: an
 *  abort propagates UNTOUCHED (the caller's cancellation must not be disguised
 *  as a vendor failure) while any other vendor error becomes an `LLMError` with
 *  a redacted message. A unit because that abort-vs-failure distinction is the
 *  only judgement in the loop; batching itself has none. */
const embedOneBatch = async (
  http: VoyageHttp,
  model: string,
  batch: readonly string[],
  signal: AbortSignal | undefined,
): Promise<readonly (readonly number[])[]> => {
  try {
    const res = await http.embeddingsCreate(
      { model, input: batch },
      signal === undefined ? undefined : { signal },
    )
    // Iterate rather than `.map` so a malformed `data` fails exactly as it did
    // when this loop lived at the call site.
    const vectors: (readonly number[])[] = []
    for (const d of res.data) vectors.push(d.embedding)
    return vectors
  } catch (e) {
    if (isAbortError(e)) throw e
    throw new LLMError(`Voyage retrieval embeddings failed: ${safeVendorErrMessage(e)}`, {
      cause: e,
    })
  }
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
        for (const vec of await embedOneBatch(opts.http, model, batch, callOpts?.signal)) {
          out.push(vec)
        }
      }
      return out
    },
  }
}
