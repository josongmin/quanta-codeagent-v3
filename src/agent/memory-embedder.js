import OpenAI from "openai";
import { LLMError } from "@/shared";
/** Split `items` into contiguous chunks of at most `size` (size ≥ 1). */
export const chunkBatches = (items, size) => {
    const n = Math.max(1, Math.floor(size));
    const out = [];
    for (let i = 0; i < items.length; i += n)
        out.push(items.slice(i, i + n));
    return out;
};
const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_BATCH = 96;
/**
 * OpenAI-backed embedder. Batches inputs by `batchSize`, preserves input
 * order, and wraps transport failures in {@link LLMError} so callers can
 * degrade to lexical recall uniformly. Does not pad/trim vectors —
 * dimension drift is tolerated downstream by `normalizeEntry`.
 */
export class OpenAIEmbedder {
    client;
    model;
    batchSize;
    /** `client` is an injectable seam (defaults to a real OpenAI client). */
    constructor(opts, client) {
        this.model = opts.model ?? DEFAULT_MODEL;
        this.batchSize = opts.batchSize ?? DEFAULT_BATCH;
        this.client =
            client ??
                new OpenAI({
                    apiKey: opts.apiKey,
                    baseURL: opts.baseURL,
                });
    }
    async embed(texts) {
        if (texts.length === 0)
            return [];
        const out = [];
        for (const batch of chunkBatches(texts, this.batchSize)) {
            try {
                const res = await this.client.embeddings.create({
                    model: this.model,
                    input: batch,
                });
                for (const d of res.data)
                    out.push(d.embedding);
            }
            catch (e) {
                throw new LLMError(`OpenAI embeddings failed: ${e.message}`, {
                    cause: e,
                });
            }
        }
        return out;
    }
}
/** Offline embedder: one empty vector per input (downstream drops them). */
export class NullEmbedder {
    async embed(texts) {
        return texts.map(() => []);
    }
}
/**
 * Memoising wrapper over any {@link EmbedderPort}. Cache is keyed by exact
 * input text; misses are delegated in a single batched call for only the
 * uncached texts. Simple FIFO eviction at `max` entries.
 */
export class CachingEmbedder {
    inner;
    max;
    cache = new Map();
    constructor(inner, max = 2000) {
        this.inner = inner;
        this.max = max;
    }
    async embed(texts) {
        if (texts.length === 0)
            return [];
        const missIdx = [];
        const missText = [];
        for (let i = 0; i < texts.length; i++) {
            if (!this.cache.has(texts[i])) {
                missIdx.push(i);
                missText.push(texts[i]);
            }
        }
        if (missText.length > 0) {
            const fresh = await this.inner.embed(missText);
            for (let j = 0; j < missIdx.length; j++) {
                this.put(missText[j], fresh[j] ?? []);
            }
        }
        return texts.map((t) => this.cache.get(t) ?? []);
    }
    put(key, vec) {
        if (this.cache.has(key))
            return;
        this.cache.set(key, vec);
        while (this.cache.size > this.max) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined)
                break;
            this.cache.delete(oldest);
        }
    }
}
