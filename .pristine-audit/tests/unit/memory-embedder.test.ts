import { describe, expect, test } from "bun:test"
import {
  CachingEmbedder,
  chunkBatches,
  type EmbeddingsClient,
  NullEmbedder,
  OpenAIEmbedder,
} from "@/agent/memory-embedder"
import type { EmbedderPort } from "@/memory"
import { LLMError } from "@/shared"

/** Fake OpenAI embeddings client: deterministic vector = [len, batchIndex]. */
const fakeClient = (calls: string[][]): EmbeddingsClient => ({
  embeddings: {
    async create(body) {
      calls.push(body.input)
      return { data: body.input.map((s, i) => ({ embedding: [s.length, i] })) }
    },
  },
})

describe("chunkBatches", () => {
  test("contiguous chunks, order preserved, size floored to >=1", () => {
    expect(chunkBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunkBatches([1, 2, 3], 0)).toEqual([[1], [2], [3]])
    expect(chunkBatches([], 4)).toEqual([])
  })
})

describe("OpenAIEmbedder", () => {
  test("empty input → [] without calling client", async () => {
    const calls: string[][] = []
    const e = new OpenAIEmbedder({ apiKey: "k" }, fakeClient(calls))
    expect(await e.embed([])).toEqual([])
    expect(calls.length).toBe(0)
  })

  test("batches by batchSize, preserves global input order", async () => {
    const calls: string[][] = []
    const e = new OpenAIEmbedder({ apiKey: "k", batchSize: 2 }, fakeClient(calls))
    const out = await e.embed(["a", "bb", "ccc", "dddd", "e"])
    expect(calls).toEqual([["a", "bb"], ["ccc", "dddd"], ["e"]])
    // [len, idx-within-batch]
    expect(out).toEqual([
      [1, 0],
      [2, 1],
      [3, 0],
      [4, 1],
      [1, 0],
    ])
  })

  test("transport error wrapped in LLMError with cause", async () => {
    const boom: EmbeddingsClient = {
      embeddings: {
        async create() {
          throw new Error("ECONNRESET")
        },
      },
    }
    const e = new OpenAIEmbedder({ apiKey: "k" }, boom)
    await expect(e.embed(["x"])).rejects.toBeInstanceOf(LLMError)
    try {
      await e.embed(["x"])
    } catch (err) {
      expect((err as LLMError).code).toBe("llm")
      expect((err as { cause?: Error }).cause).toBeInstanceOf(Error)
    }
  })

  test("does not pad/trim returned vectors", async () => {
    const odd: EmbeddingsClient = {
      embeddings: {
        async create() {
          return { data: [{ embedding: [1, 2, 3] }] }
        },
      },
    }
    const e = new OpenAIEmbedder({ apiKey: "k" }, odd)
    expect(await e.embed(["q"])).toEqual([[1, 2, 3]])
  })
})

describe("NullEmbedder", () => {
  test("one empty vector per input", async () => {
    expect(await new NullEmbedder().embed(["a", "b"])).toEqual([[], []])
    expect(await new NullEmbedder().embed([])).toEqual([])
  })
})

describe("CachingEmbedder", () => {
  const counting = (): EmbedderPort & { calls: string[][] } => {
    const calls: string[][] = []
    return {
      calls,
      async embed(texts) {
        calls.push(texts)
        return texts.map((t) => [t.length])
      },
    }
  }

  test("misses delegated once for only uncached texts, order preserved", async () => {
    const inner = counting()
    const c = new CachingEmbedder(inner)
    expect(await c.embed(["a", "bb"])).toEqual([[1], [2]])
    // second call: "a" cached, only "ccc" delegated
    expect(await c.embed(["a", "ccc", "bb"])).toEqual([[1], [3], [2]])
    expect(inner.calls).toEqual([["a", "bb"], ["ccc"]])
  })

  test("empty input short-circuits", async () => {
    const inner = counting()
    const c = new CachingEmbedder(inner)
    expect(await c.embed([])).toEqual([])
    expect(inner.calls.length).toBe(0)
  })

  test("FIFO eviction at max", async () => {
    const inner = counting()
    const c = new CachingEmbedder(inner, 2)
    await c.embed(["a"])
    await c.embed(["b"])
    await c.embed(["c"]) // evicts "a"
    await c.embed(["a", "b", "c"])
    // "a" was evicted → re-embedded; "b","c" still cached
    expect(inner.calls).toEqual([["a"], ["b"], ["c"], ["a"]])
  })
})
