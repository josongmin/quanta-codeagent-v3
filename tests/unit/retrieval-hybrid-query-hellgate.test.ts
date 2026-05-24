/**
 * HELLGATE — adversarial hybrid-query funnel proofs (ADR-0159 Axis E).
 *
 * Invariants: (i) type=keywords MUST NOT call the embedding source (and
 * vice versa) — proves zero-coupling for queries that need only one
 * source; (ii) type=hybrid runs both IN PARALLEL (timing test); (iii)
 * rerank is the FINAL stage — RRF fusion happens BEFORE rerank, not
 * after; (iv) errors from EITHER source propagate to the caller (no
 * silent partial result); (v) limit is honored at the boundary even
 * when rerank shrinks the candidate set below limit.
 *
 * 12 adversarial cases.
 */

import { describe, expect, test } from "bun:test"
import {
  identityReranker,
  RerankRegistry,
  type RerankInput,
  type RerankPort,
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

describe("hybrid-query hellgate", () => {
  test("type=keywords NEVER calls embedding source", async () => {
    let embCalls = 0
    await runHybridQuery({
      query: "q",
      type: "keywords",
      bm25Source: async () => [c("a")],
      embeddingSource: async () => {
        embCalls++
        return []
      },
    })
    expect(embCalls).toBe(0)
  })

  test("type=embeddings NEVER calls bm25 source", async () => {
    let bmCalls = 0
    await runHybridQuery({
      query: "q",
      type: "embeddings",
      bm25Source: async () => {
        bmCalls++
        return []
      },
      embeddingSource: async () => [c("a", 0, "embedding")],
    })
    expect(bmCalls).toBe(0)
  })

  test("type=hybrid runs both sources concurrently (not serially)", async () => {
    let bmDone: () => void = () => {}
    let embDone: () => void = () => {}
    const bmStarted = new Promise<void>((r) => {
      bmDone = r
    })
    const embStarted = new Promise<void>((r) => {
      embDone = r
    })
    let bothInFlight = false
    const out = runHybridQuery({
      query: "q",
      type: "hybrid",
      bm25Source: async () => {
        bmDone()
        await embStarted
        bothInFlight = true
        return [c("a", 1)]
      },
      embeddingSource: async () => {
        embDone()
        await bmStarted
        return [c("b", 1, "embedding")]
      },
    })
    await out
    expect(bothInFlight).toBe(true)
  })

  test("bm25 source throwing on hybrid mode propagates (NO silent partial)", async () => {
    await expect(
      runHybridQuery({
        query: "q",
        type: "hybrid",
        bm25Source: async () => {
          throw new Error("rg failed")
        },
        embeddingSource: async () => [c("a", 0, "embedding")],
      }),
    ).rejects.toThrow("rg failed")
  })

  test("embedding source throwing on hybrid mode propagates", async () => {
    await expect(
      runHybridQuery({
        query: "q",
        type: "hybrid",
        bm25Source: async () => [c("a")],
        embeddingSource: async () => {
          throw new Error("embed failed")
        },
      }),
    ).rejects.toThrow("embed failed")
  })

  test("rerank throwing propagates (no silent fallback to unranked)", async () => {
    const throwing: RerankPort = {
      kind: "identity",
      async rerank() {
        throw new Error("rerank boom")
      },
    }
    await expect(
      runHybridQuery({
        query: "q",
        type: "keywords",
        bm25Source: async () => [c("a")],
        embeddingSource: async () => [],
        rerank: throwing,
      }),
    ).rejects.toThrow("rerank boom")
  })

  test("limit truncates AFTER rerank — rerank sees full first-stage list", async () => {
    let observed = 0
    const r: RerankPort = {
      kind: "identity",
      async rerank(input: RerankInput) {
        observed = input.candidates.length
        return input.candidates
      },
    }
    await runHybridQuery({
      query: "q",
      type: "keywords",
      bm25Source: async () => [c("a"), c("b"), c("c"), c("d")],
      embeddingSource: async () => [],
      rerank: r,
      limit: 2,
    })
    // First-stage delivers 4; rerank sees 4 with limit=2 passed through.
    expect(observed).toBe(4)
  })

  test("RRF fusion happens BEFORE rerank — rerank receives hybrid-source candidates", async () => {
    let seenSources: string[] = []
    const r: RerankPort = {
      kind: "identity",
      async rerank(input: RerankInput) {
        seenSources = input.candidates.map((c) => c.source)
        return input.candidates
      },
    }
    await runHybridQuery({
      query: "q",
      type: "hybrid",
      bm25Source: async () => [c("a", 1)],
      embeddingSource: async () => [c("b", 1, "embedding")],
      rerank: r,
    })
    // After RRF, every candidate carries source='hybrid'.
    for (const s of seenSources) expect(s).toBe("hybrid")
  })

  test("identity reranker preserves first-stage order even with limit=0", async () => {
    const out = await runHybridQuery({
      query: "q",
      type: "keywords",
      bm25Source: async () => [c("a")],
      embeddingSource: async () => [],
      rerank: identityReranker,
      limit: 0,
    })
    expect(out).toEqual([])
  })

  test("no rerank + limit=0 → empty result", async () => {
    const out = await runHybridQuery({
      query: "q",
      type: "keywords",
      bm25Source: async () => [c("a"), c("b")],
      embeddingSource: async () => [],
      limit: 0,
    })
    expect(out).toEqual([])
  })

  test("limit larger than candidates is a no-op", async () => {
    const out = await runHybridQuery({
      query: "q",
      type: "keywords",
      bm25Source: async () => [c("a")],
      embeddingSource: async () => [],
      limit: 999,
    })
    expect(out.length).toBe(1)
  })

  test("hybrid with one empty source still fuses (RRF k=60 monotone)", async () => {
    const out = await runHybridQuery({
      query: "q",
      type: "hybrid",
      bm25Source: async () => [c("a", 1), c("b", 1)],
      embeddingSource: async () => [],
    })
    expect(out.length).toBe(2)
    expect(out[0]?.id).toBe("a") // rank 0 in bm25 list
  })
})

/* ------------------------------------------------------------------ */
/* merged from retrieval-hybrid-query.test.ts */
/* ------------------------------------------------------------------ */

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
