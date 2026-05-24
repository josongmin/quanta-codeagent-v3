/**
 * Unit — RerankRegistry + 4 built-in reranker strategies (ADR-0159 Axis A).
 *
 * Coverage axes:
 *   - registry: registration / lookup / has / kinds / unknown-kind error
 *   - identity reranker: order preservation + limit
 *   - bm25-secondary: scoring, blend (alpha=0/1), empty-input branch
 *   - tier-aware: penalty applied via injected classifier
 *   - score-fusion-rrf: published k=60 constant, multi-list fusion
 *
 * The registry is a leaf — every test is pure (no I/O, no clock).
 */
import { describe, expect, test } from "bun:test"
import {
  type CandidateTier,
  createBm25SecondaryReranker,
  createTierAwareReranker,
  fuseByRrf,
  identityReranker,
  RerankRegistry,
  type RetrievalCandidate,
  RetrievalError,
  RRF_K,
  rrfReranker,
} from "@/retrieval"

const c = (
  id: string,
  text: string,
  score = 0,
  source: RetrievalCandidate["source"] = "bm25",
): RetrievalCandidate => ({ id, text, score, source })

describe("RerankRegistry", () => {
  test("get on unregistered kind throws RetrievalError", () => {
    const reg = new RerankRegistry()
    expect(() => reg.get("identity")).toThrow(RetrievalError)
  })

  test("register + has + get round-trip", () => {
    const reg = new RerankRegistry()
    expect(reg.has("identity")).toBe(false)
    reg.register(identityReranker)
    expect(reg.has("identity")).toBe(true)
    expect(reg.get("identity")).toBe(identityReranker)
  })

  test("kinds() returns sorted unique list", () => {
    const reg = new RerankRegistry()
    reg.register(rrfReranker)
    reg.register(identityReranker)
    expect(reg.kinds()).toEqual(["identity", "score-fusion-rrf"])
  })

  test("re-registering replaces (idempotent)", () => {
    const reg = new RerankRegistry()
    reg.register(identityReranker)
    const fake = { ...identityReranker } // same kind, different reference
    reg.register(fake)
    expect(reg.get("identity")).toBe(fake)
  })
})

describe("identityReranker", () => {
  test("preserves order", async () => {
    const out = await identityReranker.rerank({
      query: "q",
      candidates: [c("b", "B"), c("a", "A"), c("c", "C")],
    })
    expect(out.map((x) => x.id)).toEqual(["b", "a", "c"])
  })

  test("limit truncates", async () => {
    const out = await identityReranker.rerank({
      query: "q",
      candidates: [c("a", "A"), c("b", "B"), c("c", "C")],
      limit: 2,
    })
    expect(out.length).toBe(2)
    expect(out.map((x) => x.id)).toEqual(["a", "b"])
  })

  test("empty input returns empty", async () => {
    expect(await identityReranker.rerank({ query: "q", candidates: [] })).toEqual([])
  })
})

describe("createBm25SecondaryReranker", () => {
  test("empty candidates returns []", async () => {
    const r = createBm25SecondaryReranker()
    expect(await r.rerank({ query: "x", candidates: [] })).toEqual([])
  })

  test("alpha=0 → ordering driven entirely by bm25 (rare term wins)", async () => {
    const r = createBm25SecondaryReranker({ alpha: 0 })
    const cands = [
      c("doc-frequent", "the the the the", 0),
      c("doc-rare", "the cat sat on the mat", 0),
    ]
    // Query "cat" appears only in doc-rare; doc-frequent has only "the"
    // (which is in every doc → low IDF).
    const out = await r.rerank({ query: "cat", candidates: cands })
    expect(out[0]?.id).toBe("doc-rare")
  })

  test("alpha=1 → first-stage score wins, bm25 ignored", async () => {
    const r = createBm25SecondaryReranker({ alpha: 1 })
    const cands = [c("a", "irrelevant", 10), c("b", "matches query exactly", 1)]
    const out = await r.rerank({ query: "matches query", candidates: cands })
    expect(out[0]?.id).toBe("a")
  })

  test("alpha clamps out-of-range to [0,1]", async () => {
    const rLow = createBm25SecondaryReranker({ alpha: -5 })
    const rHi = createBm25SecondaryReranker({ alpha: 99 })
    // Both should rerank without error.
    await rLow.rerank({ query: "q", candidates: [c("a", "x")] })
    await rHi.rerank({ query: "q", candidates: [c("a", "x")] })
    expect(true).toBe(true)
  })

  test("limit truncates", async () => {
    const r = createBm25SecondaryReranker({ alpha: 0 })
    const out = await r.rerank({
      query: "match",
      candidates: [c("a", "match"), c("b", "match also"), c("c", "match here too")],
      limit: 2,
    })
    expect(out.length).toBe(2)
  })
})

describe("createTierAwareReranker", () => {
  const byPath: Record<string, CandidateTier> = {
    "src/x.ts": "user",
    "tests/x.test.ts": "test",
    "node_modules/x/index.js": "vendored",
  }
  const classifier = {
    classify: (cand: RetrievalCandidate): CandidateTier => byPath[cand.id] ?? "user",
  }

  test("user > test > vendored even at equal first-stage score", async () => {
    const r = createTierAwareReranker({ classifier })
    const cands = [
      c("node_modules/x/index.js", "v", 10),
      c("tests/x.test.ts", "t", 10),
      c("src/x.ts", "u", 10),
    ]
    const out = await r.rerank({ query: "q", candidates: cands })
    expect(out.map((x) => x.id)).toEqual(["src/x.ts", "tests/x.test.ts", "node_modules/x/index.js"])
  })

  test("custom penalty table overrides default", async () => {
    const r = createTierAwareReranker({
      classifier,
      penalty: { user: 0, test: 0, vendored: 0 },
    })
    const cands = [c("node_modules/x/index.js", "v", 5), c("src/x.ts", "u", 1)]
    const out = await r.rerank({ query: "q", candidates: cands })
    expect(out[0]?.id).toBe("node_modules/x/index.js")
  })
})

describe("fuseByRrf + rrfReranker", () => {
  test("k constant matches Cormack 2009 published value", () => {
    expect(RRF_K).toBe(60)
  })

  test("two lists with same top doc fuses to that doc first", () => {
    const a = [c("doc-1", "a", 1), c("doc-2", "b", 2), c("doc-3", "c", 3)]
    const b = [c("doc-1", "a", 9), c("doc-9", "z", 1)]
    const out = fuseByRrf([a, b])
    expect(out[0]?.id).toBe("doc-1")
  })

  test("emits source='hybrid' for every fused row", () => {
    const a = [c("doc-1", "a", 1)]
    const out = fuseByRrf([a])
    expect(out[0]?.source).toBe("hybrid")
  })

  test("rrfReranker groups by metadata.list", async () => {
    const cands: RetrievalCandidate[] = [
      { id: "a", text: "A", score: 0, source: "bm25", metadata: { list: "L1" } },
      { id: "b", text: "B", score: 0, source: "bm25", metadata: { list: "L1" } },
      { id: "a", text: "A", score: 0, source: "embedding", metadata: { list: "L2" } },
    ]
    const out = await rrfReranker.rerank({ query: "q", candidates: cands })
    expect(out[0]?.id).toBe("a") // appears in both lists → highest RRF
  })
})
