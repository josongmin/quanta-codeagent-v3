/**
 * HELLGATE — Reranker port + Cohere/Voyage REST adapters + identity (ADR-0262).
 *
 * Invariants:
 *   - `Reranker` is a CLOSED port distinct from the slice-internal `RerankPort`
 *     (vendor concerns, Result-shaped failures, generic element type).
 *   - identity (default) is byte-identical pass-through.
 *   - Cohere / Voyage adapters inject HTTP — slice never imports a vendor SDK.
 *   - Boundary REFUSES empty query / too-many-docs / k=0 / empty hits BEFORE
 *     any HTTP call (vendors charge per request).
 *   - `originalIndex` is always the index in the INPUT `hits` array.
 *   - registry returns the provider named by `QUANTA_RERANKER` env (no silent
 *     fallback).
 *   - `RerankError` 5-arm union is exhaustively switchable.
 *
 * 15 adversarial cases — HELL-RR-01 through HELL-RR-15.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  type CohereHttp,
  type CohereRerankResponse,
  createCohereReranker,
  createRerankerFromEnv,
  createVoyageReranker,
  headlessReranker,
  identityReranker,
  type RerankError,
  type RerankedHit,
  type Reranker,
  type RerankerCapabilities,
  type VoyageHttp,
  type VoyageRerankResponse,
} from "@/retrieval/reranker"
import { assertNever } from "@/shared"

// ── shared test fixtures ───────────────────────────────────────────────────

interface Doc {
  readonly id: string
  readonly body: string
}

const docs = (n: number): Doc[] =>
  Array.from({ length: n }, (_, i) => ({ id: `d${i}`, body: `doc-${i}` }))

const fakeCohereHttp = (
  resp: CohereRerankResponse | { status: number } | { throw: Error },
  observed: { body?: unknown; calls: number },
): CohereHttp => ({
  async rerank(body) {
    observed.calls += 1
    observed.body = body
    if ("throw" in resp) throw resp.throw
    if ("status" in resp) {
      const e = new Error(`HTTP ${resp.status}`) as Error & { status: number }
      e.status = resp.status
      throw e
    }
    return resp
  },
})

const fakeVoyageHttp = (
  resp: VoyageRerankResponse | { status: number } | { throw: Error },
  observed: { body?: unknown; calls: number },
): VoyageHttp => ({
  async rerank(body) {
    observed.calls += 1
    observed.body = body
    if ("throw" in resp) throw resp.throw
    if ("status" in resp) {
      const e = new Error(`HTTP ${resp.status}`) as Error & { status: number }
      e.status = resp.status
      throw e
    }
    return resp
  },
})

const docFor = (h: Doc): string => h.body

// ── HELL-RR-01 identity preserves order/score ──────────────────────────────

describe("HELL-RR-01 identity reranker pass-through", () => {
  test("returns hits in input order with originalIndex 0..n-1 and score=1", async () => {
    const hits = docs(3)
    const r = identityReranker<Doc>()
    const result = await r.rerank("anything", hits, 3)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.value.length).toBe(3)
    for (let i = 0; i < 3; i++) {
      const v = result.value[i]
      expect(v).toBeDefined()
      if (!v) throw new Error("unreachable")
      expect(v.originalIndex).toBe(i)
      expect(v.hit.id).toBe(`d${i}`)
      expect(v.score).toBe(1)
    }
  })
})

// ── HELL-RR-02 cohere reorders by score ────────────────────────────────────

describe("HELL-RR-02 cohere mock reorders by score", () => {
  test("highest-relevance index first", async () => {
    const hits = docs(3)
    const observed = { calls: 0 }
    const http = fakeCohereHttp(
      {
        results: [
          { index: 2, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.5 },
          { index: 1, relevance_score: 0.1 },
        ],
      },
      observed,
    )
    const r = createCohereReranker<Doc>({ apiKey: "k", http, documentOf: docFor })
    const result = await r.rerank("query", hits, 3)
    expect(observed.calls).toBe(1)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.value.map((v) => v.originalIndex)).toEqual([2, 0, 1])
    expect(result.value.map((v) => v.score)).toEqual([0.9, 0.5, 0.1])
    expect(result.value.map((v) => v.hit.id)).toEqual(["d2", "d0", "d1"])
  })
})

// ── HELL-RR-03 voyage reorders by score ────────────────────────────────────

describe("HELL-RR-03 voyage mock reorders by score", () => {
  test("descending relevance preserved by adapter", async () => {
    const hits = docs(3)
    const observed = { calls: 0 }
    const http = fakeVoyageHttp(
      {
        data: [
          { index: 1, relevance_score: 0.95 },
          { index: 2, relevance_score: 0.42 },
          { index: 0, relevance_score: 0.11 },
        ],
      },
      observed,
    )
    const r = createVoyageReranker<Doc>({ apiKey: "k", http, documentOf: docFor })
    const result = await r.rerank("q", hits, 3)
    expect(observed.calls).toBe(1)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.value.map((v) => v.originalIndex)).toEqual([1, 2, 0])
  })
})

// ── HELL-RR-04 k=0 short-circuits without HTTP ────────────────────────────

describe("HELL-RR-04 k=0 returns empty without HTTP", () => {
  test("cohere does not call the network", async () => {
    const observed = { calls: 0 }
    const http = fakeCohereHttp({ results: [] }, observed)
    const r = createCohereReranker<Doc>({ apiKey: "k", http, documentOf: docFor })
    const result = await r.rerank("q", docs(5), 0)
    expect(observed.calls).toBe(0)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.value).toEqual([])
  })
  test("voyage does not call the network", async () => {
    const observed = { calls: 0 }
    const http = fakeVoyageHttp({ data: [] }, observed)
    const r = createVoyageReranker<Doc>({ apiKey: "k", http, documentOf: docFor })
    const result = await r.rerank("q", docs(5), 0)
    expect(observed.calls).toBe(0)
    expect(result.ok).toBe(true)
  })
})

// ── HELL-RR-05 k > hits.length returns all hits ───────────────────────────

describe("HELL-RR-05 k > hits.length returns all hits", () => {
  test("identity clamps and returns the input length", async () => {
    const hits = docs(2)
    const result = await identityReranker<Doc>().rerank("q", hits, 99)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.value.length).toBe(2)
  })
  test("cohere passes its top_n clamped to hits.length", async () => {
    const observed: { body?: unknown; calls: number } = { calls: 0 }
    const http = fakeCohereHttp(
      {
        results: [
          { index: 0, relevance_score: 0.7 },
          { index: 1, relevance_score: 0.3 },
        ],
      },
      observed,
    )
    const r = createCohereReranker<Doc>({ apiKey: "k", http, documentOf: docFor })
    const result = await r.rerank("q", docs(2), 99)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.value.length).toBe(2)
    const body = observed.body as { top_n?: number }
    expect(body.top_n).toBe(2)
  })
})

// ── HELL-RR-06 originalIndex accurate ─────────────────────────────────────

describe("HELL-RR-06 originalIndex always refers to input index", () => {
  test("post-sort order does not corrupt originalIndex", async () => {
    const hits = docs(4)
    const observed = { calls: 0 }
    const http = fakeCohereHttp(
      {
        results: [
          { index: 3, relevance_score: 0.99 },
          { index: 0, relevance_score: 0.5 },
          { index: 2, relevance_score: 0.3 },
          { index: 1, relevance_score: 0.1 },
        ],
      },
      observed,
    )
    const r = createCohereReranker<Doc>({ apiKey: "k", http, documentOf: docFor })
    const result = await r.rerank("q", hits, 4)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    for (const v of result.value) {
      expect(hits[v.originalIndex]?.id).toBe(v.hit.id)
    }
  })
})

// ── HELL-RR-07 4xx auth → auth-failed ─────────────────────────────────────

describe("HELL-RR-07 4xx auth maps to RerankError auth-failed", () => {
  test("cohere 401 → auth-failed", async () => {
    const observed = { calls: 0 }
    const http = fakeCohereHttp({ status: 401 }, observed)
    const r = createCohereReranker<Doc>({ apiKey: "k", http, documentOf: docFor })
    const result = await r.rerank("q", docs(1), 1)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error.kind).toBe("auth-failed")
  })
  test("voyage 403 → auth-failed", async () => {
    const observed = { calls: 0 }
    const http = fakeVoyageHttp({ status: 403 }, observed)
    const r = createVoyageReranker<Doc>({ apiKey: "k", http, documentOf: docFor })
    const result = await r.rerank("q", docs(1), 1)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error.kind).toBe("auth-failed")
  })
})

// ── HELL-RR-08 429 → rate-limited ─────────────────────────────────────────

describe("HELL-RR-08 429 maps to rate-limited", () => {
  test("cohere 429 → rate-limited", async () => {
    const observed = { calls: 0 }
    const http = fakeCohereHttp({ status: 429 }, observed)
    const r = createCohereReranker<Doc>({ apiKey: "k", http, documentOf: docFor })
    const result = await r.rerank("q", docs(1), 1)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error.kind).toBe("rate-limited")
  })
})

// ── HELL-RR-09 empty/whitespace query → empty-query, no HTTP ─────────────

describe("HELL-RR-09 empty/whitespace query refused at boundary", () => {
  test("cohere empty query: no HTTP, empty-query error", async () => {
    const observed = { calls: 0 }
    const http = fakeCohereHttp({ results: [] }, observed)
    const r = createCohereReranker<Doc>({ apiKey: "k", http, documentOf: docFor })
    const result = await r.rerank("", docs(2), 2)
    expect(observed.calls).toBe(0)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error.kind).toBe("empty-query")
  })
  test("cohere whitespace-only query: no HTTP, empty-query error", async () => {
    const observed = { calls: 0 }
    const http = fakeCohereHttp({ results: [] }, observed)
    const r = createCohereReranker<Doc>({ apiKey: "k", http, documentOf: docFor })
    const result = await r.rerank("   \t\n ", docs(2), 2)
    expect(observed.calls).toBe(0)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error.kind).toBe("empty-query")
  })
})

// ── HELL-RR-10 empty hits → ok([]), no HTTP ──────────────────────────────

describe("HELL-RR-10 empty hits returns ok([]) without HTTP", () => {
  test("cohere", async () => {
    const observed = { calls: 0 }
    const http = fakeCohereHttp({ results: [] }, observed)
    const r = createCohereReranker<Doc>({ apiKey: "k", http, documentOf: docFor })
    const result = await r.rerank("q", [], 5)
    expect(observed.calls).toBe(0)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.value).toEqual([])
  })
  test("voyage", async () => {
    const observed = { calls: 0 }
    const http = fakeVoyageHttp({ data: [] }, observed)
    const r = createVoyageReranker<Doc>({ apiKey: "k", http, documentOf: docFor })
    const result = await r.rerank("q", [], 5)
    expect(observed.calls).toBe(0)
    expect(result.ok).toBe(true)
  })
})

// ── HELL-RR-11 capabilities round-trip ────────────────────────────────────

describe("HELL-RR-11 capabilities expose provider/model/limits", () => {
  test("identity caps", () => {
    const caps = identityReranker<Doc>().capabilities()
    expect(caps.provider).toBe("identity")
    expect(typeof caps.model).toBe("string")
    expect(caps.maxDocsPerCall).toBeGreaterThan(0)
    expect(caps.maxInputTokens).toBeGreaterThan(0)
  })
  test("cohere caps", () => {
    const observed = { calls: 0 }
    const http = fakeCohereHttp({ results: [] }, observed)
    const r = createCohereReranker<Doc>({ apiKey: "k", http, documentOf: docFor })
    const caps = r.capabilities()
    expect(caps.provider).toBe("cohere")
    expect(caps.model).toBe("rerank-v3.5")
    expect(caps.maxDocsPerCall).toBeGreaterThan(0)
    expect(caps.maxInputTokens).toBeGreaterThan(0)
  })
  test("voyage caps", () => {
    const observed = { calls: 0 }
    const http = fakeVoyageHttp({ data: [] }, observed)
    const r = createVoyageReranker<Doc>({ apiKey: "k", http, documentOf: docFor })
    const caps = r.capabilities()
    expect(caps.provider).toBe("voyage")
    expect(caps.model).toBe("rerank-2")
    expect(caps.maxDocsPerCall).toBeGreaterThan(0)
    expect(caps.maxInputTokens).toBeGreaterThan(0)
  })
})

// ── HELL-RR-12 maxDocsPerCall exceeded → too-many-docs ────────────────────

describe("HELL-RR-12 maxDocsPerCall enforcement", () => {
  test("cohere refuses oversized request without HTTP", async () => {
    const observed = { calls: 0 }
    const http = fakeCohereHttp({ results: [] }, observed)
    const r = createCohereReranker<Doc>({
      apiKey: "k",
      http,
      documentOf: docFor,
      maxDocsPerCall: 4,
    })
    const result = await r.rerank("q", docs(5), 5)
    expect(observed.calls).toBe(0)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error.kind).toBe("too-many-docs")
  })
})

// ── HELL-RR-13 registry env swap ──────────────────────────────────────────

describe("HELL-RR-13 createRerankerFromEnv picks provider", () => {
  const originalEnv = process.env.QUANTA_RERANKER
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.QUANTA_RERANKER
    else process.env.QUANTA_RERANKER = originalEnv
  })
  test("identity selected", () => {
    process.env.QUANTA_RERANKER = "identity"
    const r = createRerankerFromEnv<Doc>({ documentOf: docFor })
    expect(r.capabilities().provider).toBe("identity")
  })
  test("headless selected (no apiKey needed)", () => {
    process.env.QUANTA_RERANKER = "headless"
    const r = createRerankerFromEnv<Doc>({ documentOf: docFor })
    expect(r.capabilities().provider).toBe("headless")
  })
  test("cohere selected when env says cohere and apiKey present", () => {
    process.env.QUANTA_RERANKER = "cohere"
    const observed = { calls: 0 }
    const r = createRerankerFromEnv<Doc>({
      documentOf: docFor,
      cohereApiKey: "k",
      cohereHttp: fakeCohereHttp({ results: [] }, observed),
    })
    expect(r.capabilities().provider).toBe("cohere")
  })
  test("voyage selected", () => {
    process.env.QUANTA_RERANKER = "voyage"
    const observed = { calls: 0 }
    const r = createRerankerFromEnv<Doc>({
      documentOf: docFor,
      voyageApiKey: "k",
      voyageHttp: fakeVoyageHttp({ data: [] }, observed),
    })
    expect(r.capabilities().provider).toBe("voyage")
  })
  test("unknown env value falls back to identity (no silent vendor swap)", () => {
    process.env.QUANTA_RERANKER = "fictional-provider"
    const r = createRerankerFromEnv<Doc>({ documentOf: docFor })
    expect(r.capabilities().provider).toBe("identity")
  })
})

// ── HELL-RR-14 default (no env) → identity, byte-identical ───────────────

describe("HELL-RR-14 default-OFF identity byte-identical pass-through", () => {
  const originalEnv = process.env.QUANTA_RERANKER
  beforeEach(() => {
    delete process.env.QUANTA_RERANKER
  })
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.QUANTA_RERANKER
    else process.env.QUANTA_RERANKER = originalEnv
  })
  test("createRerankerFromEnv() with no env yields identity", async () => {
    const r = createRerankerFromEnv<Doc>({ documentOf: docFor })
    expect(r.capabilities().provider).toBe("identity")
    const hits = docs(4)
    const result = await r.rerank("anything", hits, 4)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    // Byte-identical: same hit object references, same input order.
    for (let i = 0; i < 4; i++) {
      const v = result.value[i]
      expect(v).toBeDefined()
      if (!v) throw new Error("unreachable")
      expect(v.hit).toBe(hits[i] as Doc)
      expect(v.originalIndex).toBe(i)
    }
  })
})

// ── HELL-RR-15 RerankError 5-arm exhaustive switch ───────────────────────

describe("HELL-RR-15 RerankError 5-arm exhaustive", () => {
  test("switch covers every kind, fail-compile otherwise", () => {
    const describeError = (e: RerankError): string => {
      switch (e.kind) {
        case "auth-failed":
          return "auth"
        case "rate-limited":
          return "rl"
        case "empty-query":
          return "eq"
        case "too-many-docs":
          return "tmd"
        case "transport":
          return "tx"
        default:
          return assertNever(e)
      }
    }
    expect(describeError({ kind: "auth-failed" })).toBe("auth")
    expect(describeError({ kind: "rate-limited" })).toBe("rl")
    expect(describeError({ kind: "empty-query" })).toBe("eq")
    expect(describeError({ kind: "too-many-docs", limit: 10, given: 11 })).toBe("tmd")
    expect(describeError({ kind: "transport", message: "boom" })).toBe("tx")
  })
})

// ── Bonus: headless deterministic stub stays deterministic ────────────────

describe("headless reranker is deterministic", () => {
  test("same input → same output across instances", async () => {
    const a = headlessReranker<Doc>()
    const b = headlessReranker<Doc>()
    const hits = docs(5)
    const r1 = await a.rerank("query", hits, 5)
    const r2 = await b.rerank("query", hits, 5)
    expect(r1.ok && r2.ok).toBe(true)
    if (!r1.ok || !r2.ok) throw new Error("unreachable")
    expect(r1.value.map((v) => v.originalIndex)).toEqual(r2.value.map((v) => v.originalIndex))
  })
})

// Type-level proof: `Reranker<T>` shape and `RerankedHit<T>` payload
// generic. These never run; they fail at compile time if the public types
// drift away from the contract.
const _typeShape = (r: Reranker<Doc>): RerankerCapabilities => r.capabilities()
const _hitShape = (h: RerankedHit<Doc>): Doc => h.hit
void _typeShape
void _hitShape
