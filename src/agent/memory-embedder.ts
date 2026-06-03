import OpenAI from "openai"
import type { EmbedderPort } from "@/memory"
import { errMessage, LLMError } from "@/shared"
import { chunkBatches } from "@/shared/chunk"

/**
 * Concrete {@link EmbedderPort} implementations (RFC §6.3, long-term memory).
 * The memory slice owns the port but cannot import @/llm or `openai`; the
 * concrete providers live here in @/agent (the only cross-slice importer).
 *
 *  - {@link OpenAIEmbedder}  : real provider, batched.
 *  - {@link NullEmbedder}    : offline/no-op (empty vectors ⇒ lexical-only).
 *  - {@link CachingEmbedder} : in-proc memoisation wrapper.
 */

export interface OpenAIEmbedderOptions {
  apiKey: string
  model?: string
  baseURL?: string
  batchSize?: number
}

/**
 * Minimal structural seam over the part of the OpenAI client we use. Lets
 * tests inject a fake without network or the real SDK constructor.
 */
export interface EmbeddingsClient {
  embeddings: {
    create(body: { model: string; input: string[] }): Promise<{ data: { embedding: number[] }[] }>
  }
}

/** Re-export of the canonical batch chunker (`@/shared/chunk`). The
 *  definition was hoisted to `@/shared` to kill three drifted copies; this
 *  re-export preserves the historical `@/agent/memory-embedder` import surface
 *  (e.g. `tests/unit/memory-embedder.test.ts`). */
export { chunkBatches }

const DEFAULT_MODEL = "text-embedding-3-small"
const DEFAULT_BATCH = 96

/**
 * OpenAI-backed embedder. Batches inputs by `batchSize`, preserves input
 * order, and wraps transport failures in {@link LLMError} so callers can
 * degrade to lexical recall uniformly. Does not pad/trim vectors —
 * dimension drift is tolerated downstream by `normalizeEntry`.
 */
export class OpenAIEmbedder implements EmbedderPort {
  private readonly client: EmbeddingsClient
  private readonly model: string
  private readonly batchSize: number

  /** `client` is an injectable seam (defaults to a real OpenAI client). */
  constructor(opts: OpenAIEmbedderOptions, client?: EmbeddingsClient) {
    this.model = opts.model ?? DEFAULT_MODEL
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH
    this.client =
      client ??
      (new OpenAI({
        apiKey: opts.apiKey,
        baseURL: opts.baseURL,
      }) as unknown as EmbeddingsClient)
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const out: number[][] = []
    for (const batch of chunkBatches(texts, this.batchSize)) {
      try {
        const res = await this.client.embeddings.create({
          model: this.model,
          input: batch,
        })
        for (const d of res.data) out.push(d.embedding)
      } catch (e) {
        throw new LLMError(`OpenAI embeddings failed: ${errMessage(e)}`, {
          cause: e,
        })
      }
    }
    return out
  }
}

/** Offline embedder: one empty vector per input (downstream drops them). */
export class NullEmbedder implements EmbedderPort {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [])
  }
}

/**
 * Memoising wrapper over any {@link EmbedderPort}. Cache is keyed by exact
 * input text; misses are delegated in a single batched call for only the
 * uncached texts. Simple FIFO eviction at `max` entries.
 */
export class CachingEmbedder implements EmbedderPort {
  private readonly cache = new Map<string, number[]>()

  constructor(
    private readonly inner: EmbedderPort,
    private readonly max = 2000,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const missIdx: number[] = []
    const missText: string[] = []
    for (let i = 0; i < texts.length; i++) {
      if (!this.cache.has(texts[i] as string)) {
        missIdx.push(i)
        missText.push(texts[i] as string)
      }
    }
    if (missText.length > 0) {
      const fresh = await this.inner.embed(missText)
      for (let j = 0; j < missIdx.length; j++) {
        this.put(missText[j] as string, fresh[j] ?? [])
      }
    }
    return texts.map((t) => this.cache.get(t) ?? [])
  }

  private put(key: string, vec: number[]): void {
    if (this.cache.has(key)) return
    this.cache.set(key, vec)
    while (this.cache.size > this.max) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }
}
