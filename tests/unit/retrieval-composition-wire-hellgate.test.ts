/**
 * Hellgate — retrieval composition wire (ADR-0159 wire Phases A-D).
 *
 * Adversarial coverage on the composition-root assembler + memory/localize
 * bridges. The retrieval slice itself (rerank registry / hybrid funnel /
 * commit embedder) is tested under `tests/unit/retrieval-*.test.ts` — this
 * file covers the WIRE: builder edge cases, default-OFF discipline,
 * structural assignability into `AgentConfig.retrievalStack`, abort/error
 * propagation, and bridge identity behavior when the stack is absent.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import type { MemoryEntry, MemoryQuery } from "@/memory"
import {
  type CandidateTier,
  identityReranker,
  RerankRegistry,
  type RetrievalCandidate,
  RetrievalError,
  type TierClassifierPort,
} from "@/retrieval"
import {
  buildRetrievalStackCore,
  DEFAULT_RETRIEVAL_RERANKER,
  type LexicalHit,
  lexicalHitsToCandidates,
  RETRIEVAL_BUILTIN_RERANKERS,
  type RetrievalStack,
  rankWithRetrievalStack,
  runLocalizeHybrid,
} from "@/runner/assemble"

const entry = (id: string, text: string, extra?: Partial<MemoryEntry>): MemoryEntry => ({
  id,
  kind: "fact",
  text,
  tags: [],
  createdAt: 1_700_000_000_000,
  ...extra,
})

// ─── Phase A — builder edge cases ────────────────────────────────────────

describe("buildRetrievalStackCore — default-OFF discipline", () => {
  test("undefined input returns undefined", () => {
    expect(buildRetrievalStackCore(undefined)).toBeUndefined()
  })

  test("missing enabled returns undefined (no allocation)", () => {
    expect(buildRetrievalStackCore({})).toBeUndefined()
  })

  test("enabled=false returns undefined", () => {
    expect(buildRetrievalStackCore({ enabled: false })).toBeUndefined()
  })

  test("enabled truthy non-boolean STILL gated (strict === true)", () => {
    // Defensive: a poorly-projected env value like "1" or 1 must NOT enable.
    // The builder strict-equals `true` so only the typed bool flips it on.
    // biome-ignore lint/suspicious/noExplicitAny: adversarial coercion test
    expect(buildRetrievalStackCore({ enabled: 1 as any })).toBeUndefined()
    // biome-ignore lint/suspicious/noExplicitAny: adversarial coercion test
    expect(buildRetrievalStackCore({ enabled: "true" as any })).toBeUndefined()
    // biome-ignore lint/suspicious/noExplicitAny: adversarial coercion test
    expect(buildRetrievalStackCore({ enabled: null as any })).toBeUndefined()
  })
})

describe("buildRetrievalStackCore — opt-in shape", () => {
  test("enabled=true returns stack with identity default", () => {
    const s = buildRetrievalStackCore({ enabled: true })
    expect(s).toBeDefined()
    expect(s?.defaultReranker.kind).toBe(DEFAULT_RETRIEVAL_RERANKER)
    expect(s?.embedding).toBeUndefined()
    expect(s?.commitEmbedder).toBeUndefined()
  })

  test("registry contains the builtin set", () => {
    const s = buildRetrievalStackCore({ enabled: true })
    expect(s?.registry).toBeInstanceOf(RerankRegistry)
    const kinds = s?.registry.kinds() ?? []
    for (const builtin of RETRIEVAL_BUILTIN_RERANKERS) {
      expect(kinds).toContain(builtin)
    }
  })

  test("tier-aware NOT registered without classifier (closed by default)", () => {
    const s = buildRetrievalStackCore({ enabled: true })
    expect(s?.registry.has("tier-aware")).toBe(false)
    expect(() => s?.registry.get("tier-aware")).toThrow(RetrievalError)
  })

  test("tier-aware registered when classifier supplied", () => {
    const classifier: TierClassifierPort = {
      classify: (): CandidateTier => "user",
    }
    const s = buildRetrievalStackCore({ enabled: true, tierClassifier: classifier })
    expect(s?.registry.has("tier-aware")).toBe(true)
  })

  test("defaultReranker = bm25-secondary when promoted", () => {
    const s = buildRetrievalStackCore({ enabled: true, defaultReranker: "bm25-secondary" })
    expect(s?.defaultReranker.kind).toBe("bm25-secondary")
  })

  test("unregistered defaultReranker kind throws RetrievalError", () => {
    // tier-aware is unregistered without a classifier ⇒ promoting it should
    // throw at construction (loud) rather than silently fall back to identity.
    expect(() => buildRetrievalStackCore({ enabled: true, defaultReranker: "tier-aware" })).toThrow(
      RetrievalError,
    )
  })
})

// ─── Phase B — memory bridge identity / wire ────────────────────────────

describe("rankWithRetrievalStack — bridge identity + wire", () => {
  const candidates: MemoryEntry[] = [
    entry("a", "alpha note"),
    entry("b", "beta note"),
    entry("c", "gamma note"),
  ]
  const query: MemoryQuery = { text: "note" }

  test("stack=undefined returns rankEntries verbatim (byte-identical)", async () => {
    const out = await rankWithRetrievalStack(candidates, query, 1_700_000_001_000, undefined)
    // rankEntries hits all 3 (text "note" appears in every entry).
    expect(out.length).toBe(3)
    expect(out.map((e) => e.id).sort()).toEqual(["a", "b", "c"])
  })

  test("stack present routes through defaultReranker.rerank", async () => {
    let rerankCalled = false
    const fakeStack: RetrievalStack = {
      registry: new RerankRegistry(),
      defaultReranker: {
        kind: "identity",
        async rerank(input) {
          rerankCalled = true
          return [...input.candidates].reverse()
        },
      },
    }
    const out = await rankWithRetrievalStack(candidates, query, 1_700_000_001_000, fakeStack)
    expect(rerankCalled).toBe(true)
    expect(out.length).toBe(3)
  })

  test("empty candidates skip rerank pass (no allocation)", async () => {
    let rerankCalled = false
    const fakeStack: RetrievalStack = {
      registry: new RerankRegistry(),
      defaultReranker: {
        kind: "identity",
        async rerank() {
          rerankCalled = true
          return []
        },
      },
    }
    const out = await rankWithRetrievalStack([], query, 1_700_000_001_000, fakeStack)
    expect(out).toEqual([])
    expect(rerankCalled).toBe(false)
  })

  test("reranker that emits malformed ids is gracefully filtered", async () => {
    const fakeStack: RetrievalStack = {
      registry: new RerankRegistry(),
      defaultReranker: {
        kind: "identity",
        async rerank(input) {
          // Return a candidate with an id that does NOT exist in the input
          // — the bridge MUST drop it (defensive) instead of crashing.
          return [
            ...input.candidates,
            { id: "ghost", text: "g", score: 0, source: "external" as const },
          ]
        },
      },
    }
    const out = await rankWithRetrievalStack(candidates, query, 1_700_000_001_000, fakeStack)
    expect(out.every((e) => ["a", "b", "c"].includes(e.id))).toBe(true)
  })
})

// ─── Phase C — localize bridge identity / wire ───────────────────────────

describe("runLocalizeHybrid — bridge identity + wire", () => {
  const hits: LexicalHit[] = [
    { file: "src/x.ts", line: 10, text: "alpha" },
    { file: "src/y.ts", line: 20, text: "beta" },
  ]
  const bm25Source = async (): Promise<readonly LexicalHit[]> => hits

  test("lexicalHitsToCandidates preserves order + injects ordinal score", () => {
    const cands = lexicalHitsToCandidates(hits)
    expect(cands.length).toBe(2)
    expect(cands[0]?.id).toBe("src/x.ts:10")
    expect(cands[0]?.score).toBeGreaterThan(cands[1]?.score ?? Number.POSITIVE_INFINITY)
  })

  test("stack=undefined returns lexical candidates (identity wire)", async () => {
    const out = await runLocalizeHybrid({
      query: "alpha",
      type: "keywords",
      bm25Source,
    })
    expect(out.length).toBe(2)
    expect(out.map((c) => c.id)).toEqual(["src/x.ts:10", "src/y.ts:20"])
  })

  test("stack present routes through runHybridQuery + reranker", async () => {
    let rerankCalls = 0
    const fakeStack: RetrievalStack = {
      registry: new RerankRegistry(),
      defaultReranker: {
        kind: "identity",
        async rerank(input) {
          rerankCalls++
          return [...input.candidates].reverse()
        },
      },
    }
    const out = await runLocalizeHybrid({
      query: "alpha",
      type: "keywords",
      bm25Source,
      stack: fakeStack,
    })
    expect(rerankCalls).toBe(1)
    expect(out.map((c) => c.id)).toEqual(["src/y.ts:20", "src/x.ts:10"])
  })

  test("hybrid type with no embedding source uses empty list (well-defined)", async () => {
    const fakeStack: RetrievalStack = {
      registry: new RerankRegistry(),
      defaultReranker: identityReranker,
    }
    const out = await runLocalizeHybrid({
      query: "alpha",
      type: "hybrid",
      bm25Source,
      stack: fakeStack,
    })
    // BM25 results fuse with empty embedding ⇒ output is BM25 reranked by
    // RRF; identity rerank means we keep that order.
    expect(out.length).toBe(2)
  })
})

// ─── Phase D — structural assignability into AgentConfig ─────────────────

describe("AgentConfig.retrievalStack — structural wire", () => {
  test("RetrievalStack is assignable to AgentConfig.retrievalStack slot", () => {
    const stack = buildRetrievalStackCore({ enabled: true })
    if (stack === undefined) throw new Error("builder must return when enabled")
    // Structural assignability — drift in either side trips tsc.
    const slot: AgentConfig["retrievalStack"] = stack
    expect(slot?.defaultReranker.kind).toBe("identity")
    expect(slot?.registry).toBeInstanceOf(RerankRegistry)
  })

  test("AgentConfig.retrievalStack accepts a minimal handle (only required fields)", () => {
    const minimal: AgentConfig["retrievalStack"] = {
      registry: new RerankRegistry(),
      defaultReranker: identityReranker,
    }
    expect(minimal?.embedding).toBeUndefined()
    expect(minimal?.commitEmbedder).toBeUndefined()
  })
})

// ─── Cross-cutting — abort + concurrent + cascade ────────────────────────

describe("retrieval composition — cross-cutting hellgate", () => {
  test("concurrent buildRetrievalStackCore calls are independent (no singleton)", () => {
    const a = buildRetrievalStackCore({ enabled: true })
    const b = buildRetrievalStackCore({ enabled: true })
    // Distinct registries — re-registering on one MUST NOT affect the other.
    expect(a?.registry).not.toBe(b?.registry)
    a?.registry.register({
      kind: "identity",
      async rerank() {
        return []
      },
    })
    expect(b?.registry.get("identity")).toBe(identityReranker) // unchanged
  })

  test("bm25Alpha override threads to the registered bm25-secondary", async () => {
    const s = buildRetrievalStackCore({ enabled: true, bm25Alpha: 1 })
    expect(s?.registry.has("bm25-secondary")).toBe(true)
    // alpha=1 ⇒ first-stage score wins regardless of bm25.
    const port = s?.registry.get("bm25-secondary")
    if (!port) throw new Error("expected bm25-secondary registered")
    const cands: RetrievalCandidate[] = [
      { id: "x", text: "irrelevant", score: 10, source: "bm25" },
      { id: "y", text: "match query exactly", score: 1, source: "bm25" },
    ]
    const out = await port.rerank({ query: "match query", candidates: cands })
    expect(out[0]?.id).toBe("x") // alpha=1 ⇒ score=10 wins
  })

  test("rerank port throw cascades to bridge consumer (no swallow)", async () => {
    const throwingStack: RetrievalStack = {
      registry: new RerankRegistry(),
      defaultReranker: {
        kind: "identity",
        async rerank() {
          throw new Error("vendor down")
        },
      },
    }
    const candidates = [entry("a", "alpha note")]
    await expect(
      rankWithRetrievalStack(candidates, { text: "note" }, 1_700_000_001_000, throwingStack),
    ).rejects.toThrow("vendor down")
  })

  test("commitCacheMax override threads into createCommitEmbedder", () => {
    const fakeEmbedding = {
      vendor: "openai" as const,
      model: "fake",
      async embed(): Promise<readonly (readonly number[])[]> {
        return []
      },
    }
    const fakeGit = {
      async log(): Promise<readonly never[]> {
        return []
      },
    }
    const s = buildRetrievalStackCore({
      enabled: true,
      embedding: fakeEmbedding,
      gitLog: fakeGit,
      commitCacheMax: 7,
    })
    expect(s?.commitEmbedder).toBeDefined()
    expect(s?.commitEmbedder?.cacheSize()).toBe(0) // fresh
  })

  test("commitEmbedder NOT wired when gitLog absent", () => {
    const fakeEmbedding = {
      vendor: "openai" as const,
      model: "fake",
      async embed(): Promise<readonly (readonly number[])[]> {
        return []
      },
    }
    const s = buildRetrievalStackCore({ enabled: true, embedding: fakeEmbedding })
    expect(s?.commitEmbedder).toBeUndefined()
  })
})
