/**
 * HELLGATE — adversarial multi-vendor embedding port proofs (ADR-0159 Axis D).
 *
 * Invariants: (i) every vendor adapter exposes the SAME EmbeddingPort shape
 * with its own `vendor` discriminator; (ii) the 6 type-level stubs throw
 * RetrievalError synchronously when embed() is called — they MUST NOT hang,
 * MUST NOT return [], MUST NOT silently fall back to another vendor;
 * (iii) the 2 runtime adapters (openai + voyage) preserve batch order and
 * empty-input short-circuit; (iv) HTTP error wrapped in LLMError; (v) all
 * 8 vendor strings in the EmbeddingVendor union have a working factory.
 *
 * 13 adversarial cases.
 */
import { describe, expect, test } from "bun:test"
import {
  createCohereEmbedder,
  createGeminiEmbedder,
  createMoonshotEmbedder,
  createNvidiaEmbedder,
  createOpenAIEmbedder,
  createVoyageEmbedder,
  createXaiEmbedder,
  createZaiEmbedder,
  type EmbeddingPort,
  type EmbeddingsHttp,
  type EmbeddingVendor,
  RetrievalError,
  type VoyageHttp,
} from "@/retrieval"
import { LLMError } from "@/shared"

const fakeOpenAIHttp = (calls: string[][]): EmbeddingsHttp => ({
  async embeddingsCreate(body) {
    calls.push([...body.input])
    return { data: body.input.map((s) => ({ embedding: [s.length] })) }
  },
})

const fakeVoyageHttp = (calls: string[][]): VoyageHttp => ({
  async embeddingsCreate(body) {
    calls.push([...body.input])
    return { data: body.input.map((s) => ({ embedding: [s.length, 7] })) }
  },
})

describe("multi-vendor embedding hellgate", () => {
  test("all 8 stub factories construct without throwing", () => {
    expect(createCohereEmbedder({ apiKey: "k" })).toBeDefined()
    expect(createGeminiEmbedder({ apiKey: "k" })).toBeDefined()
    expect(createXaiEmbedder({ apiKey: "k" })).toBeDefined()
    expect(createMoonshotEmbedder({ apiKey: "k" })).toBeDefined()
    expect(createNvidiaEmbedder({ apiKey: "k" })).toBeDefined()
    expect(createZaiEmbedder({ apiKey: "k" })).toBeDefined()
    expect(createOpenAIEmbedder({ apiKey: "k", http: fakeOpenAIHttp([]) })).toBeDefined()
    expect(createVoyageEmbedder({ apiKey: "k", http: fakeVoyageHttp([]) })).toBeDefined()
  })

  test("every vendor reports the SAME vendor string as expected", () => {
    const pairs: Array<[EmbeddingPort, EmbeddingVendor]> = [
      [createOpenAIEmbedder({ apiKey: "k", http: fakeOpenAIHttp([]) }), "openai"],
      [createVoyageEmbedder({ apiKey: "k", http: fakeVoyageHttp([]) }), "voyage"],
      [createCohereEmbedder({ apiKey: "k" }), "cohere"],
      [createGeminiEmbedder({ apiKey: "k" }), "gemini"],
      [createXaiEmbedder({ apiKey: "k" }), "xai"],
      [createMoonshotEmbedder({ apiKey: "k" }), "moonshot"],
      [createNvidiaEmbedder({ apiKey: "k" }), "nvidia"],
      [createZaiEmbedder({ apiKey: "k" }), "zai"],
    ]
    for (const [port, v] of pairs) {
      expect(port.vendor).toBe(v)
    }
  })

  test("cohere stub embed() throws RetrievalError, NEVER returns silently", async () => {
    const e = createCohereEmbedder({ apiKey: "k" })
    await expect(e.embed(["x"])).rejects.toBeInstanceOf(RetrievalError)
  })

  test("gemini stub embed() throws RetrievalError", async () => {
    await expect(createGeminiEmbedder({ apiKey: "k" }).embed(["x"])).rejects.toBeInstanceOf(
      RetrievalError,
    )
  })

  test("xai stub embed() throws RetrievalError", async () => {
    await expect(createXaiEmbedder({ apiKey: "k" }).embed(["x"])).rejects.toBeInstanceOf(
      RetrievalError,
    )
  })

  test("moonshot stub embed() throws RetrievalError", async () => {
    await expect(createMoonshotEmbedder({ apiKey: "k" }).embed(["x"])).rejects.toBeInstanceOf(
      RetrievalError,
    )
  })

  test("nvidia stub embed() throws RetrievalError", async () => {
    await expect(createNvidiaEmbedder({ apiKey: "k" }).embed(["x"])).rejects.toBeInstanceOf(
      RetrievalError,
    )
  })

  test("zai stub embed() throws RetrievalError", async () => {
    await expect(createZaiEmbedder({ apiKey: "k" }).embed(["x"])).rejects.toBeInstanceOf(
      RetrievalError,
    )
  })

  test("openai: empty input short-circuits without an HTTP call", async () => {
    const calls: string[][] = []
    const e = createOpenAIEmbedder({ apiKey: "k", http: fakeOpenAIHttp(calls) })
    expect(await e.embed([])).toEqual([])
    expect(calls.length).toBe(0)
  })

  test("voyage: empty input short-circuits without an HTTP call", async () => {
    const calls: string[][] = []
    const e = createVoyageEmbedder({ apiKey: "k", http: fakeVoyageHttp(calls) })
    expect(await e.embed([])).toEqual([])
    expect(calls.length).toBe(0)
  })

  test("openai: HTTP throwing wraps in LLMError", async () => {
    const e = createOpenAIEmbedder({
      apiKey: "k",
      http: {
        async embeddingsCreate() {
          throw new Error("ECONNRESET")
        },
      },
    })
    await expect(e.embed(["x"])).rejects.toBeInstanceOf(LLMError)
  })

  test("voyage: HTTP throwing wraps in LLMError", async () => {
    const e = createVoyageEmbedder({
      apiKey: "k",
      http: {
        async embeddingsCreate() {
          throw new Error("403")
        },
      },
    })
    await expect(e.embed(["x"])).rejects.toBeInstanceOf(LLMError)
  })

  test("openai: batchSize=2 over 5 inputs → 3 batch calls in input order", async () => {
    const calls: string[][] = []
    const e = createOpenAIEmbedder({
      apiKey: "k",
      batchSize: 2,
      http: fakeOpenAIHttp(calls),
    })
    const out = await e.embed(["a", "bb", "ccc", "dddd", "e"])
    expect(calls).toEqual([["a", "bb"], ["ccc", "dddd"], ["e"]])
    expect(out).toEqual([[1], [2], [3], [4], [1]])
  })

  test("voyage: batchSize=3 over 7 inputs → 3 batch calls, last has 1 item", async () => {
    const calls: string[][] = []
    const e = createVoyageEmbedder({
      apiKey: "k",
      batchSize: 3,
      http: fakeVoyageHttp(calls),
    })
    await e.embed(["a", "b", "c", "d", "e", "f", "g"])
    expect(calls.length).toBe(3)
    expect(calls[2]?.length).toBe(1)
  })
})
