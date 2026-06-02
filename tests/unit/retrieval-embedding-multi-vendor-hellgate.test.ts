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

  test("openai: caller AbortSignal is forwarded to every HTTP batch", async () => {
    const received: Array<AbortSignal | undefined> = []
    const ac = new AbortController()
    const e = createOpenAIEmbedder({
      apiKey: "k",
      batchSize: 2,
      http: {
        async embeddingsCreate(body, opts) {
          received.push(opts?.signal)
          return { data: body.input.map((s) => ({ embedding: [s.length] })) }
        },
      },
    })
    await e.embed(["a", "bb", "ccc"], { signal: ac.signal })
    expect(received).toHaveLength(2)
    expect(received.every((signal) => signal === ac.signal)).toBe(true)
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

  test("voyage: pre-aborted signal short-circuits before HTTP and stays AbortError", async () => {
    let called = false
    const ac = new AbortController()
    ac.abort("stop now")
    const e = createVoyageEmbedder({
      apiKey: "k",
      http: {
        async embeddingsCreate() {
          called = true
          return { data: [] }
        },
      },
    })
    let caught: unknown
    try {
      await e.embed(["x"], { signal: ac.signal })
    } catch (err) {
      caught = err
    }
    expect(called).toBe(false)
    expect((caught as Error | undefined)?.name).toBe("AbortError")
  })

  // =========================================================================
  // ADVERSARIAL — Phase E hellgate hardening (round 3)
  //
  // 7+ multi-vendor cascading / corruption / dimension-mismatch scenarios.
  // The contract tests above pin per-vendor invariants; these target the
  // failure modes that show up when callers wire a fallback chain across
  // vendors (a 429 from vendor A + a 429 from vendor B should NOT silently
  // return [], a dimension mismatch should fail loudly, etc.).
  // =========================================================================

  test("[E1][adversarial] cascading vendor A 429 + vendor B 429 — all-vendor-down explicit, no silent []", async () => {
    // Attack: a caller wires a fallback chain (openai → voyage). Both
    // exhaust quota with 429. The caller MUST get an explicit throw from
    // each vendor (not a silent empty array masquerading as "no
    // embeddings needed"). We assert the boundary: each call throws
    // LLMError, and the caller's catch surfaces it.
    const openai = createOpenAIEmbedder({
      apiKey: "k",
      http: {
        async embeddingsCreate() {
          throw new Error("429 Too Many Requests")
        },
      },
    })
    const voyage = createVoyageEmbedder({
      apiKey: "k",
      http: {
        async embeddingsCreate() {
          throw new Error("429 quota exceeded")
        },
      },
    })
    // A simulated fallback chain — caller-written wrapper.
    const tryChain = async (vendors: EmbeddingPort[], texts: string[]): Promise<string> => {
      for (const v of vendors) {
        try {
          await v.embed(texts)
          return "succeeded"
        } catch (e) {
          if (!(e instanceof LLMError)) throw e
          // continue to next vendor
        }
      }
      return "all-down"
    }
    const result = await tryChain([openai, voyage], ["a", "b"])
    expect(result).toBe("all-down")
  })

  test("[E2][adversarial] vendor returns NaN values in embedding — passed through (caller validates)", async () => {
    // Attack: a vendor's wire response contains NaN (some providers
    // legitimately return NaN for empty inputs; others have buggy
    // floating-point pipelines). The adapter is a TRANSPORT — it does NOT
    // sanitize. The vector with NaN is returned verbatim so the caller
    // (vector index, cosine-sim) can detect + reject. Silent sanitization
    // would let bad data poison the index without operator awareness.
    const e = createOpenAIEmbedder({
      apiKey: "k",
      http: {
        async embeddingsCreate(body) {
          return { data: body.input.map(() => ({ embedding: [Number.NaN, 0.5, 1.0] })) }
        },
      },
    })
    const out = await e.embed(["x"])
    expect(out.length).toBe(1)
    const v = out[0]
    expect(v).toBeDefined()
    if (v !== undefined) {
      expect(Number.isNaN(v[0])).toBe(true)
      expect(v[1]).toBe(0.5)
    }
  })

  test("[E3][adversarial] vendor returns dimension mismatch across batches (1536 vs 3072) — passed through verbatim", async () => {
    // Attack: a vendor switches model version mid-call (rolling deploy)
    // and batch 1 returns 1536-dim, batch 2 returns 3072-dim. The adapter
    // MUST surface BOTH vectors as-is so the caller's index can detect
    // the dimension mismatch and reject. We assert the vectors are
    // delivered in input order with their original dimensions.
    let callCount = 0
    const e = createOpenAIEmbedder({
      apiKey: "k",
      batchSize: 2,
      http: {
        async embeddingsCreate(body) {
          callCount += 1
          // batch 1: 1536-dim; batch 2: 3072-dim
          const dim = callCount === 1 ? 1536 : 3072
          return { data: body.input.map(() => ({ embedding: new Array(dim).fill(0) })) }
        },
      },
    })
    const out = await e.embed(["a", "b", "c", "d"])
    expect(out.length).toBe(4)
    expect(out[0]?.length).toBe(1536)
    expect(out[1]?.length).toBe(1536)
    expect(out[2]?.length).toBe(3072)
    expect(out[3]?.length).toBe(3072)
  })

  test("[E4][adversarial] vendor returns FEWER vectors than inputs (truncation) — caller can detect length mismatch", async () => {
    // Attack: a vendor's wire returns only 2 vectors for 3 inputs (silent
    // truncation, e.g. content-policy filter dropped one). The adapter
    // MUST NOT pad / interpolate; the caller sees out.length !== input.length
    // and can recover. Pinning this contract.
    const e = createOpenAIEmbedder({
      apiKey: "k",
      http: {
        async embeddingsCreate() {
          return { data: [{ embedding: [1] }, { embedding: [2] }] }
        },
      },
    })
    const out = await e.embed(["a", "b", "c"])
    // Adapter is byte-faithful — 2 vectors out for 3 inputs in.
    expect(out.length).toBe(2)
  })

  test("[E5][adversarial] vendor throws non-Error (string thrown) — wrapped to LLMError without leaking message", async () => {
    // Attack: a vendor SDK throws a string ("auth failed: sk-LEAK").
    // The catch site must NOT interpolate the raw thrown value into the
    // wrapper message (String(e) would surface the secret). The adapter
    // routes non-Error throws through safeVendorErrMessage(), which emits
    // a generic label and keeps the raw value only on `cause`. We pin
    // behavior: caller gets an LLMError; secret is NOT in the wrapped
    // message.
    const secret = "sk-LEAKED-VENDOR-STRING-THROW-1234"
    const e = createOpenAIEmbedder({
      apiKey: "k",
      http: {
        async embeddingsCreate(): Promise<never> {
          // Deliberate adversarial — vendor SDKs sometimes throw non-Error.
          throw `auth failed: ${secret}`
        },
      },
    })
    await expect(e.embed(["x"])).rejects.toBeInstanceOf(LLMError)
    try {
      await e.embed(["x"])
    } catch (err) {
      const msg = (err as Error).message
      // The non-Error throw is wrapped with a generic label, so the leaked
      // credential never appears in the wrapper message. Pinning that the
      // leak does NOT surface.
      expect(msg.includes(secret)).toBe(false)
    }
  })

  test("[E6][adversarial] 8 stub vendors fail with RetrievalError code (NEVER swallow / NEVER hang)", async () => {
    // Attack: a fallback-chain wires the 8 vendors round-robin. The 6
    // type-level stubs MUST throw deterministically (not hang, not silently
    // return []) so the caller's fallback advances. We assert each stub
    // throws RetrievalError on first call, with a bounded wait.
    const stubs = [
      createCohereEmbedder({ apiKey: "k" }),
      createGeminiEmbedder({ apiKey: "k" }),
      createXaiEmbedder({ apiKey: "k" }),
      createMoonshotEmbedder({ apiKey: "k" }),
      createNvidiaEmbedder({ apiKey: "k" }),
      createZaiEmbedder({ apiKey: "k" }),
    ]
    const t0 = performance.now()
    for (const s of stubs) {
      let caught: unknown
      try {
        await s.embed(["x"])
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(RetrievalError)
    }
    const dt = performance.now() - t0
    // 6 synchronous throws — must complete in <100ms (NO hang).
    expect(dt).toBeLessThan(100)
  })

  test("[E7][adversarial] 100-concurrent embed() on one adapter — no state corruption, byte-faithful output", async () => {
    // Attack: a state leak in the adapter (e.g. shared `out` array across
    // calls) would cause concurrent calls to interleave results. We
    // assert each concurrent invocation gets its own correct answer.
    const e = createOpenAIEmbedder({
      apiKey: "k",
      http: {
        async embeddingsCreate(body) {
          return { data: body.input.map((s) => ({ embedding: [s.length] })) }
        },
      },
    })
    const calls = Array.from({ length: 100 }, async (_, i) => {
      const input = [`call-${i}`, `xx${i}`]
      const out = await e.embed(input)
      return { i, out, input }
    })
    const results = await Promise.all(calls)
    for (const { out, input } of results) {
      // Each output vector reports the length of its corresponding input.
      expect(out.length).toBe(2)
      expect(out[0]?.[0]).toBe(input[0]?.length)
      expect(out[1]?.[0]).toBe(input[1]?.length)
    }
  })

  test("[E8][adversarial] vendor returns malformed body (missing 'data' key) — LLMError, not silent crash", async () => {
    // Attack: an upstream proxy mangles the JSON envelope. data.map throws
    // TypeError. The adapter catch wraps to LLMError so the caller gets
    // a typed error (NOT an unhandled TypeError up the stack).
    const e = createOpenAIEmbedder({
      apiKey: "k",
      http: {
        async embeddingsCreate() {
          // biome-ignore lint/suspicious/noExplicitAny: deliberate adversarial wire-shape mismatch.
          return {} as any
        },
      },
    })
    await expect(e.embed(["x"])).rejects.toBeInstanceOf(LLMError)
  })

  test("[E9][adversarial] huge batch (10,000 inputs) chunks correctly, output order preserved", async () => {
    // Attack: a caller hands a 10k-input batch. The adapter chunks at
    // batchSize=96 (default), 105 wire calls. We MUST preserve input
    // order across all chunks — a state bug (out-of-order Promise.all
    // collapse) would silently shuffle vectors and corrupt the index.
    let totalSeen = 0
    const e = createOpenAIEmbedder({
      apiKey: "k",
      batchSize: 100,
      http: {
        async embeddingsCreate(body) {
          totalSeen += body.input.length
          // Echo back input.length per vector so we can verify order.
          return { data: body.input.map((s) => ({ embedding: [s.length] })) }
        },
      },
    })
    const inputs = Array.from({ length: 10_000 }, (_, i) => "x".repeat((i % 50) + 1))
    const out = await e.embed(inputs)
    expect(out.length).toBe(10_000)
    expect(totalSeen).toBe(10_000)
    // Spot-check: out[i][0] === inputs[i].length for sampled indices.
    for (const i of [0, 1, 50, 99, 100, 5_000, 9_999]) {
      expect(out[i]?.[0]).toBe(inputs[i]?.length)
    }
  })
})
