/**
 * Real-API smoke eval for Cohere reranker — ADR-0275.
 *
 * Drift detection (non-blocking, polite-skip when COHERE_API_KEY unset).
 * Model: rerank-v3.5.
 *
 * Hellgate axes (~5 cases):
 *   1. result count: 2 docs in + k=2 → 2 reranked hits out.
 *   2. relevance scores are numbers in [0, 1].
 *   3. ordering: results sorted DESC by score.
 *   4. relevance signal: the query-paraphrase candidate scores higher than
 *      the unrelated candidate (drift-detection — if Cohere ever flipped
 *      its scoring direction, this fails).
 *   5. error path: bogus model → typed RerankError (transport/auth).
 */
import { expect, test } from "bun:test"
import { createCohereReranker, defaultCohereHttp } from "@/retrieval/reranker"
import {
  assertCostCap,
  describeOnEnv,
  SMOKE_LATENCY_CAP_MS,
  SMOKE_QUERY,
  SMOKE_TOKEN_CAP,
} from "./_helpers"

// Two docs: one is a paraphrase of SMOKE_QUERY (should rank #1); the other
// is unrelated (should rank #2 with lower score).
const DOCS = [
  "A fast auburn fox leaps above the sleepy hound in a green meadow.",
  "Bicycle gears are usually made of steel or aluminum alloys for durability.",
] as const

describeOnEnv("COHERE_API_KEY", "cohere-reranker real-API smoke", () => {
  const apiKey = process.env.COHERE_API_KEY ?? ""
  const MODEL = "rerank-v3.5"

  test("HELL-COR-01: 2 docs + k=2 → 2 reranked hits", async () => {
    assertCostCap("cohere-reranker", [SMOKE_QUERY, ...DOCS], SMOKE_TOKEN_CAP)
    const r = createCohereReranker<string>({
      apiKey,
      http: defaultCohereHttp({ apiKey }),
      documentOf: (h) => h,
      model: MODEL,
    })
    const res = await r.rerank(SMOKE_QUERY, DOCS, 2)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.length).toBe(2)
  })

  test("HELL-COR-02: scores are numbers in [0, 1]", async () => {
    const r = createCohereReranker<string>({
      apiKey,
      http: defaultCohereHttp({ apiKey }),
      documentOf: (h) => h,
      model: MODEL,
    })
    const res = await r.rerank(SMOKE_QUERY, DOCS, 2)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    for (const hit of res.value) {
      expect(typeof hit.score).toBe("number")
      expect(hit.score).toBeGreaterThanOrEqual(0)
      expect(hit.score).toBeLessThanOrEqual(1)
    }
  })

  test("HELL-COR-03: results sorted DESC by score", async () => {
    const r = createCohereReranker<string>({
      apiKey,
      http: defaultCohereHttp({ apiKey }),
      documentOf: (h) => h,
      model: MODEL,
    })
    const res = await r.rerank(SMOKE_QUERY, DOCS, 2)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    for (let i = 1; i < res.value.length; i++) {
      const prev = res.value[i - 1]?.score ?? -1
      const cur = res.value[i]?.score ?? -1
      expect(prev).toBeGreaterThanOrEqual(cur)
    }
  })

  test("HELL-COR-04: relevance signal — paraphrase outranks unrelated doc", async () => {
    const r = createCohereReranker<string>({
      apiKey,
      http: defaultCohereHttp({ apiKey }),
      documentOf: (h) => h,
      model: MODEL,
    })
    const res = await r.rerank(SMOKE_QUERY, DOCS, 2)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // The fox-paraphrase doc (originalIndex 0) must come first.
    expect(res.value[0]?.originalIndex).toBe(0)
    expect(res.value[1]?.originalIndex).toBe(1)
  })

  test("HELL-COR-05: bogus model → typed RerankError", async () => {
    const r = createCohereReranker<string>({
      apiKey,
      http: defaultCohereHttp({ apiKey }),
      documentOf: (h) => h,
      model: "definitely-not-a-real-rerank-model-xxxxx",
    })
    const t0 = Date.now()
    const res = await r.rerank(SMOKE_QUERY, DOCS, 2)
    const ms = Date.now() - t0
    expect(res.ok).toBe(false)
    if (res.ok) return
    // Cohere maps unknown model → 4xx → transport (or auth on certain keys).
    expect(["transport", "auth-failed", "rate-limited"]).toContain(res.error.kind)
    // Even error paths must respect the latency cap (no hangs).
    expect(ms).toBeLessThan(SMOKE_LATENCY_CAP_MS)
  })
})
