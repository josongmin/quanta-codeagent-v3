/**
 * OpenAI embedding adapter for the `@/retrieval` slice.
 *
 * Distinct from `src/agent/memory-embedder.ts` — that adapter implements
 * `@/memory`'s `EmbedderPort` (a different interface tied to the memory
 * recall pipeline). This adapter implements `@/retrieval`'s
 * {@link EmbeddingPort} (generic multi-vendor seam, vendor discriminator)
 * and lives entirely within the retrieval slice so it can be wired without
 * crossing into `@/memory`.
 *
 * Transport is INJECTED — `EmbeddingsHttp` is a tiny structural seam
 * exposing only `embeddingsCreate`. Production wires the real OpenAI SDK
 * by passing an adapter; tests inject a fake. The slice never imports the
 * `openai` package directly (the assembler/caller does).
 */
import { LLMError } from "@/shared"
import { chunkBatches } from "@/shared/chunk"
import type { EmbeddingAdapterOptions, EmbeddingPort } from "../embedding-port"
import { isAbortError, safeVendorErrMessage, throwIfAborted } from "./_abort"

const DEFAULT_MODEL = "text-embedding-3-small"
const DEFAULT_BATCH = 96

export interface EmbeddingsHttp {
  embeddingsCreate(
    body: {
      model: string
      input: readonly string[]
    },
    opts?: { signal?: AbortSignal },
  ): Promise<{ data: { embedding: readonly number[] }[] }>
}

export interface OpenAIRetrievalEmbedderOptions extends EmbeddingAdapterOptions {
  http: EmbeddingsHttp
}

/** One batch → its vectors, carrying the adapter's whole error contract: an
 *  abort propagates UNTOUCHED (the caller's cancellation must not be disguised
 *  as a vendor failure) while any other vendor error becomes an `LLMError` with
 *  a redacted message. A unit because that abort-vs-failure distinction is the
 *  only judgement in the loop; batching itself has none. */
const embedOneBatch = async (
  http: EmbeddingsHttp,
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
    throw new LLMError(`OpenAI retrieval embeddings failed: ${safeVendorErrMessage(e)}`, {
      cause: e,
    })
  }
}

export const createOpenAIEmbedder = (opts: OpenAIRetrievalEmbedderOptions): EmbeddingPort => {
  const model = opts.model ?? DEFAULT_MODEL
  const batchSize = opts.batchSize ?? DEFAULT_BATCH
  return {
    vendor: "openai",
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
