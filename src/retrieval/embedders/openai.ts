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
        try {
          const res = await opts.http.embeddingsCreate(
            { model, input: batch },
            callOpts?.signal === undefined ? undefined : { signal: callOpts.signal },
          )
          for (const d of res.data) out.push(d.embedding)
        } catch (e) {
          if (isAbortError(e)) throw e
          throw new LLMError(`OpenAI retrieval embeddings failed: ${safeVendorErrMessage(e)}`, {
            cause: e,
          })
        }
      }
      return out
    },
  }
}
