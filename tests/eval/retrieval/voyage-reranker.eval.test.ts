/**
 * Real-API smoke eval for Voyage reranker — ADR-0275.
 *
 * Drift detection (non-blocking, polite-skip when VOYAGE_API_KEY unset).
 * Model: rerank-2.
 *
 * Hellgate axes (~5 cases):
 *   1. result count: 2 docs in + k=2 → 2 reranked hits out.
 *   2. relevance scores are numbers (Voyage relevance_score is unbounded
 *      but consistently scaled — we only assert numeric + finite).
 *   3. ordering: results sorted DESC by score.
 *   4. relevance signal: paraphrase doc outranks unrelated doc.
 *   5. error path: bogus model → typed RerankError.
 */
import { expect, test } from "bun:test"
import { createVoyageReranker, defaultVoyageHttp } from "@/retrieval/reranker"
import {
  assertCostCap,
  describeOnEnv,
  SMOKE_LATENCY_CAP_MS,
  SMOKE_QUERY,
  SMOKE_TOKEN_CAP,
} from "./_helpers"

const DOCS = [
  "A fast auburn fox leaps above the sleepy hound in a green meadow.",
  "Bicycle gears are usually made of steel or aluminum alloys for durability.",
] as const

describeOnEnv("VOYAGE_API_KEY", "voyage-reranker real-API smoke", () => {
  const apiKey = process.env.VOYAGE_API_KEY ?? ""
  const MODEL = "rerank-2"

  test("HELL-VOR-01: 2 docs + k=2 → 2 reranked hits", async () => {
    assertCostCap("voyage-reranker", [SMOKE_QUERY, ...DOCS], SMOKE_TOKEN_CAP)
    const r = createVoyageReranker<string>({
      apiKey,
      http: defaultVoyageHttp({ apiKey }),
      documentOf: (h) => h,
      model: MODEL,
    })
    const res = await r.rerank(SMOKE_QUERY, DOCS, 2)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.length).toBe(2)
  })

  test("HELL-VOR-02: scores are finite numbers", async () => {
    const r = createVoyageReranker<string>({
      apiKey,
      http: defaultVoyageHttp({ apiKey }),
      documentOf: (h) => h,
      model: MODEL,
    })
    const res = await r.rerank(SMOKE_QUERY, DOCS, 2)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    for (const hit of res.value) {
      expect(typeof hit.score).toBe("number")
      expect(Number.isFinite(hit.score)).toBe(true)
    }
  })

  test("HELL-VOR-03: results sorted DESC by score", async () => {
    const r = createVoyageReranker<string>({
      apiKey,
      http: defaultVoyageHttp({ apiKey }),
      documentOf: (h) => h,
      model: MODEL,
    })
    const res = await r.rerank(SMOKE_QUERY, DOCS, 2)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    for (let i = 1; i < res.value.length; i++) {
      const prev = res.value[i - 1]?.score ?? Number.NEGATIVE_INFINITY
      const cur = res.value[i]?.score ?? Number.NEGATIVE_INFINITY
      expect(prev).toBeGreaterThanOrEqual(cur)
    }
  })

  test("HELL-VOR-04: relevance signal — paraphrase outranks unrelated doc", async () => {
    const r = createVoyageReranker<string>({
      apiKey,
      http: defaultVoyageHttp({ apiKey }),
      documentOf: (h) => h,
      model: MODEL,
    })
    const res = await r.rerank(SMOKE_QUERY, DOCS, 2)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value[0]?.originalIndex).toBe(0)
    expect(res.value[1]?.originalIndex).toBe(1)
  })

  test("HELL-VOR-05: bogus model → typed RerankError", async () => {
    const r = createVoyageReranker<string>({
      apiKey,
      http: defaultVoyageHttp({ apiKey }),
      documentOf: (h) => h,
      model: "definitely-not-a-real-rerank-model-xxxxx",
    })
    const t0 = Date.now()
    const res = await r.rerank(SMOKE_QUERY, DOCS, 2)
    const ms = Date.now() - t0
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(["transport", "auth-failed", "rate-limited"]).toContain(res.error.kind)
    expect(ms).toBeLessThan(SMOKE_LATENCY_CAP_MS)
  })
})
