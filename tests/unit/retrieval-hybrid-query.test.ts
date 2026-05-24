/**
 * Unit — hybrid-query 3-stage funnel (ADR-0159 Axis E).
 *
 * Asserts: type-driven source dispatch, RRF fusion on hybrid, optional
 * final-stage rerank, limit application, no unnecessary source calls.
 */
import { describe, expect, test } from "bun:test"
import {
  identityReranker,
  RerankRegistry,
  type RetrievalCandidate,
  runHybridQuery,
} from "@/retrieval"

const c = (
  id: string,
  score = 0,
  source: RetrievalCandidate["source"] = "bm25",
): RetrievalCandidate => ({
  id,
  text: id,
  score,
  source,
})

describe("runHybridQuery", () => {
  test("type=keywords calls bm25 only", async () => {
    let bm = 0
    let em = 0
    const out = await runHybridQuery({
      query: "q",
      type: "keywords",
      bm25Source: async () => {
        bm++
        return [c("a", 1)]
      },
      embeddingSource: async () => {
        em++
        return [c("b", 2)]
      },
    })
    expect(bm).toBe(1)
    expect(em).toBe(0)
    expect(out.map((x) => x.id)).toEqual(["a"])
  })

  test("type=embeddings calls embedding only", async () => {
    let bm = 0
    let em = 0
    const out = await runHybridQuery({
      query: "q",
      type: "embeddings",
      bm25Source: async () => {
        bm++
        return [c("a", 1)]
      },
      embeddingSource: async () => {
        em++
        return [c("b", 2, "embedding")]
      },
    })
    expect(bm).toBe(0)
    expect(em).toBe(1)
    expect(out.map((x) => x.id)).toEqual(["b"])
  })

  test("type=hybrid calls both and fuses with RRF", async () => {
    const out = await runHybridQuery({
      query: "q",
      type: "hybrid",
      bm25Source: async () => [c("doc-1", 1), c("doc-2", 0.5)],
      embeddingSource: async () => [c("doc-1", 1, "embedding"), c("doc-3", 0.5, "embedding")],
    })
    // doc-1 appears in BOTH lists at rank 1 → highest RRF score
    expect(out[0]?.id).toBe("doc-1")
    expect(out[0]?.source).toBe("hybrid")
  })

  test("rerank port is applied last", async () => {
    const reversed = {
      kind: "identity" as const,
      async rerank(input: { candidates: readonly RetrievalCandidate[] }) {
        return [...input.candidates].reverse()
      },
    }
    const out = await runHybridQuery({
      query: "q",
      type: "keywords",
      bm25Source: async () => [c("a"), c("b"), c("c")],
      embeddingSource: async () => [],
      rerank: reversed,
    })
    expect(out.map((x) => x.id)).toEqual(["c", "b", "a"])
  })

  test("limit truncates at the end", async () => {
    const out = await runHybridQuery({
      query: "q",
      type: "keywords",
      bm25Source: async () => [c("a"), c("b"), c("c"), c("d")],
      embeddingSource: async () => [],
      limit: 2,
    })
    expect(out.length).toBe(2)
  })

  test("limit propagates into rerank.limit", async () => {
    let observed: number | undefined
    const r = {
      kind: "identity" as const,
      async rerank(input: { candidates: readonly RetrievalCandidate[]; limit?: number }) {
        observed = input.limit
        return input.candidates.slice(0, input.limit)
      },
    }
    await runHybridQuery({
      query: "q",
      type: "keywords",
      bm25Source: async () => [c("a"), c("b"), c("c")],
      embeddingSource: async () => [],
      rerank: r,
      limit: 2,
    })
    expect(observed).toBe(2)
  })

  test("works alongside RerankRegistry-resolved port", async () => {
    const reg = new RerankRegistry()
    reg.register(identityReranker)
    const out = await runHybridQuery({
      query: "q",
      type: "keywords",
      bm25Source: async () => [c("a"), c("b")],
      embeddingSource: async () => [],
      rerank: reg.get("identity"),
    })
    expect(out.map((x) => x.id)).toEqual(["a", "b"])
  })

  test("empty sources return []", async () => {
    const out = await runHybridQuery({
      query: "q",
      type: "hybrid",
      bm25Source: async () => [],
      embeddingSource: async () => [],
    })
    expect(out).toEqual([])
  })
})
