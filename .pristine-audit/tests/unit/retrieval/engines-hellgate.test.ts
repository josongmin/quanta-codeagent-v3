/**
 * ADR-0261 — Pluggable Embedder + VectorStore registry HELLGATE.
 *
 * 25 adversarial cases across 3 sections:
 *   A. Embedder (10) — openai/voyage/cohere/ollama HTTP mocks +
 *                       headless determinism + batch + 4xx + 429 + caps
 *   B. VectorStore (10) — in-memory upsert/query + sqlite persistence +
 *                       lance + qdrant REST mocks + filter + delete +
 *                       top-k + dim-mismatch + 5-arm exhaustive + 1k docs
 *   C. Capabilities (5) — negotiate ok / dim mismatch / alg incompat /
 *                       env swap (both axes) / default-OFF byte-identical
 *
 * Every adapter is hit through its injected transport (`fetch` or
 * `Database`) — zero network, zero filesystem outside `:memory:` sqlite.
 */
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import {
  createCohereEmbedder,
  createEmbedderFromEnv,
  createHeadlessEmbedder,
  createInMemoryVectorStore,
  createLanceVectorStore,
  createOllamaEmbedder,
  createOpenAIEmbedder,
  createQdrantVectorStore,
  createSqliteVssStore,
  createStoreFromEnv,
  createVoyageEmbedder,
  EMBED_ERROR_KINDS,
  EMBED_PROVIDERS,
  type EmbedError,
  isEmbedProvider,
  isVectorStoreProvider,
  negotiateCapabilities,
  STORE_ERROR_KINDS,
  type StoreError,
  VECTOR_STORES,
} from "@/retrieval/engines/index"

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

const textResponse = (status: number, body: string): Response => new Response(body, { status })

type Recorder = {
  calls: Array<{ url: string; method: string; body: unknown }>
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
}

const recorder = (
  reply: (req: { url: string; method: string; body: unknown }) => Response,
): Recorder => {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  return {
    calls,
    fetchImpl: async (url, init) => {
      const method = (init?.method as string | undefined) ?? "GET"
      const bodyRaw = init?.body as string | undefined
      const body = bodyRaw === undefined ? undefined : JSON.parse(bodyRaw)
      const req = { url, method, body }
      calls.push(req)
      return reply(req)
    },
  }
}

// ──────────────────────────────────────────────────────────────────────────
// A. EMBEDDER (10)
// ──────────────────────────────────────────────────────────────────────────

describe("engines / A. Embedder", () => {
  test("A1: openai mock — POST /embeddings, vectors[i] aligned, tokenCount", async () => {
    const rec = recorder(() =>
      jsonResponse(200, {
        data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
        usage: { total_tokens: 7 },
      }),
    )
    const emb = createOpenAIEmbedder({ apiKey: "sk-test", fetchImpl: rec.fetchImpl })
    const r = await emb.embed(["hello", "world"])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.vectors).toEqual([
        [0.1, 0.2],
        [0.3, 0.4],
      ])
      expect(r.value.tokenCount).toBe(7)
      expect(r.value.modelTag).toBe("openai:text-embedding-3-small")
    }
    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0]?.url).toBe("https://api.openai.com/v1/embeddings")
    expect(rec.calls[0]?.method).toBe("POST")
  })

  test("A2: voyage mock — POST /embeddings shape, modelTag voyage:*", async () => {
    const rec = recorder(() => jsonResponse(200, { data: [{ embedding: [1, 2, 3] }] }))
    const emb = createVoyageEmbedder({ apiKey: "vk-test", fetchImpl: rec.fetchImpl })
    const r = await emb.embed("hi")
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.vectors).toEqual([[1, 2, 3]])
      expect(r.value.modelTag).toBe("voyage:voyage-3")
    }
    expect(rec.calls[0]?.url).toBe("https://api.voyageai.com/v1/embeddings")
  })

  test("A3: cohere mock — POST /embed, embeddings[][] aligned to texts", async () => {
    const rec = recorder(() =>
      jsonResponse(200, {
        embeddings: [
          [0.5, 0.6],
          [0.7, 0.8],
        ],
        meta: { billed_units: { input_tokens: 4 } },
      }),
    )
    const emb = createCohereEmbedder({ apiKey: "ck-test", fetchImpl: rec.fetchImpl })
    const r = await emb.embed(["a", "b"])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.vectors).toEqual([
        [0.5, 0.6],
        [0.7, 0.8],
      ])
      expect(r.value.tokenCount).toBe(4)
      expect(r.value.modelTag).toBe("cohere:embed-english-v3.0")
    }
    expect((rec.calls[0]?.body as { texts: string[] }).texts).toEqual(["a", "b"])
    expect(rec.calls[0]?.url).toBe("https://api.cohere.com/v1/embed")
  })

  test("A4: ollama mock — POST /api/embeddings ONCE per input (sequential)", async () => {
    let n = 0
    const rec = recorder(() => {
      n += 1
      return jsonResponse(200, { embedding: [n, n, n] })
    })
    const emb = createOllamaEmbedder({ fetchImpl: rec.fetchImpl })
    const r = await emb.embed(["a", "b", "c"])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.vectors).toEqual([
        [1, 1, 1],
        [2, 2, 2],
        [3, 3, 3],
      ])
      expect(r.value.modelTag).toBe("ollama:nomic-embed-text")
    }
    expect(rec.calls).toHaveLength(3)
    expect(rec.calls[0]?.url).toBe("http://localhost:11434/api/embeddings")
  })

  test("A5: headless deterministic — same input → byte-identical vector twice", async () => {
    const emb = createHeadlessEmbedder({ dim: 16 })
    const a = await emb.embed("hello")
    const b = await emb.embed("hello")
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.value.vectors[0]).toEqual(b.value.vectors[0])
      expect(a.value.vectors[0]?.length).toBe(16)
      // Different input → different vector (overwhelmingly probable for dim=16)
      const c = await emb.embed("hellz")
      if (c.ok) expect(a.value.vectors[0]).not.toEqual(c.value.vectors[0])
    }
  })

  test("A6: batch input — array of N strings yields N aligned vectors", async () => {
    const rec = recorder(() =>
      jsonResponse(200, {
        data: [{ embedding: [1] }, { embedding: [2] }, { embedding: [3] }],
      }),
    )
    const emb = createOpenAIEmbedder({ apiKey: "k", fetchImpl: rec.fetchImpl })
    const r = await emb.embed(["x", "y", "z"])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.vectors).toEqual([[1], [2], [3]])
    expect((rec.calls[0]?.body as { input: string[] }).input).toEqual(["x", "y", "z"])
  })

  test("A7: 4xx http error → http-error arm with status + body", async () => {
    const rec = recorder(() => textResponse(403, "Forbidden"))
    const emb = createOpenAIEmbedder({ apiKey: "k", fetchImpl: rec.fetchImpl })
    const r = await emb.embed("hi")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("http-error")
      if (r.error.kind === "http-error") {
        expect(r.error.status).toBe(403)
        expect(r.error.body).toBe("Forbidden")
      }
    }
  })

  test("A8: 429 rate-limited → rate-limited arm + retry-after parsed", async () => {
    const rec = recorder(() => textResponse(429, "Too Many Requests"))
    // Add retry-after via a custom response
    const rec2 = recorder(
      () => new Response("ratelimited", { status: 429, headers: { "retry-after": "2" } }),
    )
    const emb = createOpenAIEmbedder({ apiKey: "k", fetchImpl: rec.fetchImpl })
    const r = await emb.embed("hi")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("rate-limited")
    const emb2 = createOpenAIEmbedder({ apiKey: "k", fetchImpl: rec2.fetchImpl })
    const r2 = await emb2.embed("hi")
    expect(r2.ok).toBe(false)
    if (!r2.ok && r2.error.kind === "rate-limited") expect(r2.error.retryAfterMs).toBe(2000)
  })

  test("A9: capabilities() round-trip — dim/batch/modelTag/maxInputBytes", async () => {
    const emb = createOpenAIEmbedder({ apiKey: "k", model: "text-embedding-3-large" })
    const caps = await emb.capabilities()
    expect(caps.dim).toBe(3072)
    expect(caps.batchSize).toBeGreaterThan(0)
    expect(caps.modelTag).toBe("openai:text-embedding-3-large")
    expect(caps.maxInputBytes).toBeGreaterThan(0)

    // headless honors custom dim
    const h = createHeadlessEmbedder({ dim: 256, modelTag: "headless:test" })
    const hc = await h.capabilities()
    expect(hc.dim).toBe(256)
    expect(hc.modelTag).toBe("headless:test")
  })

  test("A10: 7-arm EmbedError exhaustive — every kind reachable", () => {
    const seen = new Set<EmbedError["kind"]>()
    const errors: EmbedError[] = [
      { kind: "missing-api-key", provider: "openai" },
      { kind: "http-error", status: 500, body: "" },
      { kind: "rate-limited" },
      { kind: "invalid-response", detail: "x" },
      { kind: "aborted" },
      { kind: "input-too-large", bytes: 99999, cap: 100 },
      { kind: "network", detail: "x" },
    ]
    for (const e of errors) seen.add(e.kind)
    for (const k of EMBED_ERROR_KINDS) expect(seen.has(k)).toBe(true)
    expect(seen.size).toBe(EMBED_ERROR_KINDS.length)
    // Missing API key path on the real adapter
    const apiKeyMissingPromise = createOpenAIEmbedder({ apiKey: undefined }).embed("x")
    return apiKeyMissingPromise.then((r) => {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.kind).toBe("missing-api-key")
    })
  })
})

// ──────────────────────────────────────────────────────────────────────────
// B. VECTORSTORE (10)
// ──────────────────────────────────────────────────────────────────────────

describe("engines / B. VectorStore", () => {
  test("B1: in-memory upsert + query top-k cosine ordering", async () => {
    const store = createInMemoryVectorStore({ dim: 2 })
    const up = await store.upsert([
      { id: "a", vector: [1, 0] },
      { id: "b", vector: [0, 1] },
      { id: "c", vector: [0.9, 0.1] },
    ])
    expect(up.ok).toBe(true)
    const r = await store.query([1, 0], 2)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.map((h) => h.id)).toEqual(["a", "c"])
      expect(r.value[0]?.score).toBeCloseTo(1.0, 5)
    }
  })

  test("B2: sqlite persistence — second open sees the upserted rows", async () => {
    const db = new Database(":memory:")
    const s = createSqliteVssStore({ db })
    await s.upsert([
      { id: "1", vector: [1, 0, 0] },
      { id: "2", vector: [0, 1, 0] },
    ])
    // Build a second store-port over the same db handle — must see both rows
    const s2 = createSqliteVssStore({ db })
    const r = await s2.query([1, 0, 0], 5)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.length).toBe(2)
      expect(r.value[0]?.id).toBe("1")
    }
    expect(s2.capabilities().persistent).toBe(true)
  })

  test("B3: lance REST mock — POST upsert/query, normalise hits", async () => {
    const rec = recorder((req) => {
      if (req.url.endsWith("/upsert")) return jsonResponse(200, { ok: true })
      if (req.url.endsWith("/query")) {
        return jsonResponse(200, {
          hits: [
            { id: "x", score: 0.9, metadata: { lang: "ts" } },
            { id: "y", score: 0.7 },
          ],
        })
      }
      return jsonResponse(404, {})
    })
    const s = createLanceVectorStore({
      baseURL: "http://lance.test",
      table: "docs",
      fetchImpl: rec.fetchImpl,
    })
    await s.upsert([
      { id: "x", vector: [1, 0] },
      { id: "y", vector: [0, 1] },
    ])
    const r = await s.query([1, 0], 2)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value[0]?.id).toBe("x")
      expect(r.value[0]?.metadata?.lang).toBe("ts")
      expect(r.value[1]?.id).toBe("y")
    }
    expect(rec.calls[0]?.url).toBe("http://lance.test/v1/table/docs/upsert")
  })

  test("B4: qdrant REST mock — PUT points, POST search, normalise result", async () => {
    const rec = recorder((req) => {
      if (req.url.endsWith("/points") && req.method === "PUT")
        return jsonResponse(200, { result: { status: "ok" } })
      if (req.url.endsWith("/points/search")) {
        return jsonResponse(200, {
          result: [
            { id: "a", score: 0.95, payload: { tag: "good" } },
            { id: 42, score: 0.5 },
          ],
        })
      }
      return jsonResponse(404, {})
    })
    const s = createQdrantVectorStore({
      collection: "c1",
      fetchImpl: rec.fetchImpl,
      apiKey: "qd-test",
    })
    await s.upsert([{ id: "a", vector: [1, 0], metadata: { tag: "good" } }])
    const r = await s.query([1, 0], 3)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value[0]?.id).toBe("a")
      expect(r.value[1]?.id).toBe("42") // numeric id coerced
      expect(r.value[0]?.metadata?.tag).toBe("good")
    }
    expect(rec.calls[0]?.url).toBe("http://localhost:6333/collections/c1/points")
  })

  test("B5: filter equals — non-matching docs excluded", async () => {
    const store = createInMemoryVectorStore({ dim: 2 })
    await store.upsert([
      { id: "a", vector: [1, 0], metadata: { lang: "ts" } },
      { id: "b", vector: [1, 0], metadata: { lang: "py" } },
    ])
    const r = await store.query([1, 0], 5, { equals: { lang: "ts" } })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toHaveLength(1)
      expect(r.value[0]?.id).toBe("a")
    }
  })

  test("B6: delete by id — present id removed, absent id → not-found arm", async () => {
    const store = createInMemoryVectorStore({ dim: 1 })
    await store.upsert([{ id: "a", vector: [1] }])
    const ok1 = await store.delete(["a"])
    expect(ok1.ok).toBe(true)
    const r = await store.query([1], 5)
    if (r.ok) expect(r.value).toHaveLength(0)
    const notFound = await store.delete(["ghost"])
    expect(notFound.ok).toBe(false)
    if (!notFound.ok) {
      expect(notFound.error.kind).toBe("not-found")
      if (notFound.error.kind === "not-found") expect(notFound.error.id).toBe("ghost")
    }
  })

  test("B7: top-k truncation exact — query 10 with k=3 returns 3 highest", async () => {
    const store = createInMemoryVectorStore({ dim: 2 })
    const docs = Array.from({ length: 10 }, (_, i) => ({
      id: `d${i}`,
      vector: [Math.cos((i / 10) * Math.PI), Math.sin((i / 10) * Math.PI)],
    }))
    await store.upsert(docs)
    const r = await store.query([1, 0], 3)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toHaveLength(3)
      // Scores must be non-increasing
      const scores = r.value.map((h) => h.score)
      for (let i = 1; i < scores.length; i += 1) {
        expect(scores[i]).toBeLessThanOrEqual(scores[i - 1] as number)
      }
    }
  })

  test("B8: dim mismatch on second upsert → dim-mismatch arm", async () => {
    const store = createInMemoryVectorStore()
    await store.upsert([{ id: "a", vector: [1, 0, 0] }])
    const bad = await store.upsert([{ id: "b", vector: [1, 0] }])
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.error.kind).toBe("dim-mismatch")
      if (bad.error.kind === "dim-mismatch") {
        expect(bad.error.expected).toBe(3)
        expect(bad.error.got).toBe(2)
      }
    }
    // Same on query
    const badQ = await store.query([1, 0], 1)
    expect(badQ.ok).toBe(false)
    if (!badQ.ok) expect(badQ.error.kind).toBe("dim-mismatch")
  })

  test("B9: 5-arm StoreError exhaustive — every arm constructible", () => {
    const seen = new Set<StoreError["kind"]>()
    const errors: StoreError[] = [
      { kind: "dim-mismatch", expected: 1, got: 2 },
      { kind: "not-found", id: "x" },
      { kind: "http-error", status: 500, body: "" },
      { kind: "network", detail: "x" },
      { kind: "invalid-response", detail: "x" },
    ]
    for (const e of errors) seen.add(e.kind)
    for (const k of STORE_ERROR_KINDS) expect(seen.has(k)).toBe(true)
    expect(seen.size).toBe(STORE_ERROR_KINDS.length)
  })

  test("B10: 1000 doc performance — upsert+query completes well under 1s", async () => {
    const store = createInMemoryVectorStore({ dim: 8 })
    const docs = Array.from({ length: 1000 }, (_, i) => ({
      id: `d${i}`,
      vector: Array.from({ length: 8 }, (_, j) => Math.sin(i * 0.13 + j * 0.27)),
    }))
    const t0 = performance.now()
    const up = await store.upsert(docs)
    expect(up.ok).toBe(true)
    const r = await store.query([1, 0, 0, 0, 0, 0, 0, 0], 10)
    const elapsed = performance.now() - t0
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toHaveLength(10)
    expect(elapsed).toBeLessThan(1000)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// C. CAPABILITIES + REGISTRY (5)
// ──────────────────────────────────────────────────────────────────────────

describe("engines / C. Capabilities + Registry", () => {
  test("C1: negotiateCapabilities ok — dim ≤ store.maxDim, cosine", () => {
    const r = negotiateCapabilities(
      { dim: 768, maxInputBytes: 1024, batchSize: 32, modelTag: "x" },
      { distMetric: "cosine", maxDim: 4096, persistent: true },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.dim).toBe(768)
      expect(r.value.distMetric).toBe("cosine")
      expect(r.value.persistent).toBe(true)
    }
  })

  test("C2: negotiateCapabilities dim-exceeds-store error", () => {
    const r = negotiateCapabilities(
      { dim: 5000, maxInputBytes: 1024, batchSize: 32, modelTag: "x" },
      { distMetric: "cosine", maxDim: 4096, persistent: true },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("dim-exceeds-store")
      if (r.error.kind === "dim-exceeds-store") {
        expect(r.error.dim).toBe(5000)
        expect(r.error.storeMax).toBe(4096)
      }
    }
  })

  test("C3: negotiateCapabilities alg-incompatible (future metric)", () => {
    const r = negotiateCapabilities(
      { dim: 8, maxInputBytes: 1024, batchSize: 1, modelTag: "x" },
      // forcibly bypass type to simulate a future non-cosine engine
      { distMetric: "dot" as unknown as "cosine", maxDim: 4096, persistent: false },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("alg-incompatible")
  })

  test("C4: registry env swap — both axes hit every provider listed", () => {
    expect(EMBED_PROVIDERS).toEqual(["openai", "voyage", "cohere", "ollama", "headless"])
    expect(VECTOR_STORES).toEqual(["in-memory", "sqlite", "lance", "qdrant"])
    for (const p of EMBED_PROVIDERS) expect(isEmbedProvider(p)).toBe(true)
    for (const p of VECTOR_STORES) expect(isVectorStoreProvider(p)).toBe(true)
    expect(isEmbedProvider("nope")).toBe(false)
    expect(isVectorStoreProvider("nope")).toBe(false)

    // Embedder: headless requires no key, openai requires (the key arrives on embed()).
    const e = createEmbedderFromEnv({ QUANTA_EMBED_PROVIDER: "headless" })
    expect(e).not.toBeNull()
    // Store: in-memory needs no deps; sqlite is null without deps.
    const s = createStoreFromEnv({ QUANTA_VECTOR_STORE: "in-memory" })
    expect(s).not.toBeNull()
    const sqliteNoDeps = createStoreFromEnv({ QUANTA_VECTOR_STORE: "sqlite" })
    expect(sqliteNoDeps).toBeNull()
    const db = new Database(":memory:")
    const sqliteWithDeps = createStoreFromEnv({ QUANTA_VECTOR_STORE: "sqlite" }, { sqlite: { db } })
    expect(sqliteWithDeps).not.toBeNull()
  })

  test("C5: default-OFF byte-identical — unset env returns null on both axes", () => {
    const e = createEmbedderFromEnv({})
    const s = createStoreFromEnv({})
    expect(e).toBeNull()
    expect(s).toBeNull()
    // Unknown provider string → also null (no throw)
    const eU = createEmbedderFromEnv({ QUANTA_EMBED_PROVIDER: "xxx" })
    const sU = createStoreFromEnv({ QUANTA_VECTOR_STORE: "xxx" })
    expect(eU).toBeNull()
    expect(sU).toBeNull()
  })
})
