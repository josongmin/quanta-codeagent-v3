/**
 * HELLGATE — adversarial SearchPipeline composer proofs (ADR-0265).
 *
 * Invariants:
 *   (i)   `compose([])` returns a pipeline whose `search` resolves to
 *         Err("empty-pipeline") — never throws, never silently returns [].
 *   (ii)  Stage union (lexical | semantic | rerank | rrf | budget-gate) is
 *         exhaustive — exhaustiveness is enforced at compile-time via the
 *         `assertNever` default branch; the runtime mirror guards the typing
 *         drift (cast-through-`unknown`) so a future arm cannot ship without
 *         a code update here.
 *   (iii) `compose` is PURE — the same `stages` array yields a pipeline that
 *         produces byte-identical results on repeated invocations (modulo the
 *         caller's injected side-effects).
 *   (iv)  RRF formula is the published Cormack-2009 constant (k=60) —
 *         `score(d) = Σ 1/(k + rank_i(d))`. The composer reuses the existing
 *         `fuseByRrf` for the canonical implementation; the hellgate locks the
 *         numeric formula so a future "optimization" can't silently change the
 *         constant.
 *   (v)   `budget-gate` SHORT-CIRCUITS with Err("budget-exceeded") when the
 *         caller-supplied `usdSoFar` is already at-or-above `maxUsd`. The
 *         gate consults a CALLER-INJECTED budget probe (duck-typed, no
 *         cross-slice import) — keeps the slice fence honest.
 *   (vi)  Sub-stage errors propagate as `PipelineError` — they are NEVER
 *         swallowed (no silent partial results).
 *   (vii) `assemblePipeline` is default-OFF — this primitive returns null
 *         unless a preset is selected. The host-level search facade may still
 *         compose a separate default lexical wire; that is a distinct product
 *         contract and must not be hidden by this primitive test.
 *   (viii)`PipelineError` is a 6-arm closed union; exhaustive check at any
 *         consumer boundary triggers TS `never` on a missing arm.
 *
 * 20 adversarial cases.
 */

import { describe, expect, test } from "bun:test"
import {
  budgetAwarePipeline,
  compose,
  type Embedder,
  type LexicalSearch,
  lexicalOnlyPipeline,
  type PipelineError,
  parallelRrfPipeline,
  type Reranker,
  type SearchHit,
  type SearchQuery,
  type SemanticIndex,
  type Stage,
  semanticOnlyPipeline,
  semanticThenRerankPipeline,
} from "@/retrieval/pipeline"

const hit = (id: string, score: number, source: SearchHit["source"] = "lexical"): SearchHit => ({
  id,
  text: id,
  score,
  source,
})

const lexStub = (rows: readonly SearchHit[]): LexicalSearch => ({
  async search(_q: SearchQuery): Promise<readonly SearchHit[]> {
    return rows
  },
})

const semStub = (rows: readonly SearchHit[]): SemanticIndex => ({
  async query(_vec: readonly number[], _k: number): Promise<readonly SearchHit[]> {
    return rows
  },
})

const embStub = (vec: readonly number[]): Embedder => ({
  async embed(_text: string): Promise<readonly number[]> {
    return vec
  },
})

const rrStub: Reranker = {
  async rerank(_q: string, items: readonly SearchHit[]): Promise<readonly SearchHit[]> {
    // Reverse for a deterministic, non-identity rerank.
    return [...items].reverse().map((h, i) => ({ ...h, score: items.length - i }))
  },
}

const q = (text = "find me", k = 10): SearchQuery => ({ text, k })

describe("pipeline composer hellgate", () => {
  test("HELL-PI-01 lexical-only preset returns lex source hits", async () => {
    const pipe = lexicalOnlyPipeline({ lex: lexStub([hit("a", 0.9), hit("b", 0.5)]) })
    const r = await pipe.search(q())
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.length).toBe(2)
    expect(r.value[0]?.id).toBe("a")
    expect(r.value.every((h) => h.source === "lexical")).toBe(true)
  })

  test("HELL-PI-02 semantic-only preset embeds then queries", async () => {
    const pipe = semanticOnlyPipeline({
      sem: semStub([hit("x", 0.8, "semantic"), hit("y", 0.4, "semantic")]),
      embedder: embStub([0.1, 0.2, 0.3]),
    })
    const r = await pipe.search(q())
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value[0]?.id).toBe("x")
    expect(r.value.every((h) => h.source === "semantic")).toBe(true)
  })

  test("HELL-PI-03 RRF lex+sem fuses both pipeline results", async () => {
    const pipe = parallelRrfPipeline({
      lex: lexStub([hit("a", 0.9), hit("b", 0.5)]),
      sem: semStub([hit("c", 0.8, "semantic"), hit("a", 0.4, "semantic")]),
      embedder: embStub([0.1]),
    })
    const r = await pipe.search(q())
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    const ids = r.value.map((h) => h.id)
    // 'a' appears in both lists (rank 1 in lex, rank 2 in sem) -> highest RRF score.
    expect(ids).toContain("a")
    expect(ids).toContain("b")
    expect(ids).toContain("c")
    expect(ids[0]).toBe("a")
    expect(r.value[0]?.source).toBe("fused")
  })

  test("HELL-PI-04 RRF formula uses Cormack-2009 k=60 (canonical)", async () => {
    const pipe = parallelRrfPipeline({
      lex: lexStub([hit("a", 0.9), hit("b", 0.5)]),
      sem: semStub([hit("a", 0.8, "semantic"), hit("b", 0.4, "semantic")]),
      embedder: embStub([0]),
    })
    const r = await pipe.search(q())
    if (!r.ok) throw new Error("unreachable")
    const a = r.value.find((h) => h.id === "a")
    const b = r.value.find((h) => h.id === "b")
    // a: rank 1 in both -> 2 * 1/(60+1) = 2/61
    // b: rank 2 in both -> 2 * 1/(60+2) = 2/62
    expect(a?.score).toBeCloseTo(2 / 61, 10)
    expect(b?.score).toBeCloseTo(2 / 62, 10)
  })

  test("HELL-PI-05 semantic-then-rerank chains reranker over semantic source", async () => {
    const pipe = semanticThenRerankPipeline({
      sem: semStub([
        hit("a", 0.9, "semantic"),
        hit("b", 0.7, "semantic"),
        hit("c", 0.5, "semantic"),
      ]),
      embedder: embStub([1]),
      reranker: rrStub,
    })
    const r = await pipe.search(q())
    if (!r.ok) throw new Error("unreachable")
    // rrStub reverses -> c, b, a with descending scores.
    expect(r.value.map((h) => h.id)).toEqual(["c", "b", "a"])
  })

  test("HELL-PI-06 budget-gate ABOVE limit -> Err('budget-exceeded')", async () => {
    const inner: Stage = { kind: "lexical", impl: lexStub([hit("a", 0.9)]) }
    const pipe = budgetAwarePipeline({
      inner,
      maxUsd: 1.0,
      probe: { usdSoFar: () => 1.5 },
    })
    const r = await pipe.search(q())
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("budget-exceeded")
  })

  test("HELL-PI-07 budget-gate UNDER limit -> passes through", async () => {
    const inner: Stage = { kind: "lexical", impl: lexStub([hit("a", 0.9)]) }
    const pipe = budgetAwarePipeline({
      inner,
      maxUsd: 1.0,
      probe: { usdSoFar: () => 0.25 },
    })
    const r = await pipe.search(q())
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.length).toBe(1)
  })

  test("HELL-PI-08 nested rrf — rrf(lex, rrf(sem1, sem2)) fuses transitively", async () => {
    const stages: Stage[] = [
      {
        kind: "rrf",
        inputs: [
          { kind: "lexical", impl: lexStub([hit("a", 0.9), hit("d", 0.1)]) },
          {
            kind: "rrf",
            inputs: [
              {
                kind: "semantic",
                impl: semStub([hit("b", 0.8, "semantic"), hit("a", 0.5, "semantic")]),
                embedder: embStub([0]),
              },
              {
                kind: "semantic",
                impl: semStub([hit("c", 0.7, "semantic"), hit("a", 0.4, "semantic")]),
                embedder: embStub([0]),
              },
            ],
          },
        ],
      },
    ]
    const pipe = compose(stages)
    const r = await pipe.search(q())
    if (!r.ok) throw new Error("unreachable")
    const ids = r.value.map((h) => h.id)
    expect(ids).toContain("a")
    expect(ids).toContain("b")
    expect(ids).toContain("c")
    expect(ids).toContain("d")
    expect(ids[0]).toBe("a")
  })

  test("HELL-PI-09 compose([]) -> Err('empty-pipeline')", async () => {
    const pipe = compose([])
    const r = await pipe.search(q())
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("empty-pipeline")
  })

  test("HELL-PI-10 sub-stage error propagates as PipelineError", async () => {
    const throwing: LexicalSearch = {
      async search(): Promise<readonly SearchHit[]> {
        throw new Error("bm25 index unavailable")
      },
    }
    const pipe = compose([{ kind: "lexical", impl: throwing }])
    const r = await pipe.search(q())
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("stage-failed")
    if (r.error.kind === "stage-failed") {
      expect(r.error.stage).toBe("lexical")
      expect(String(r.error.cause)).toContain("bm25 index unavailable")
    }
  })

  test("HELL-PI-11 k=0 -> empty result (no work done)", async () => {
    const pipe = compose([{ kind: "lexical", impl: lexStub([hit("a", 0.9)]) }])
    const r = await pipe.search({ text: "x", k: 0 })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value).toEqual([])
  })

  test("HELL-PI-12 Stage 5-kind exhaustive — unknown arm -> Err('unknown-stage')", async () => {
    // Cast through unknown — proves the RUNTIME mirror of the compile-time
    // exhaustive check fires when typings drift.
    const bogus = { kind: "telepathic" } as unknown as Stage
    const pipe = compose([bogus])
    const r = await pipe.search(q())
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("unknown-stage")
  })

  test("HELL-PI-13 compose is PURE — same stages produce same results", async () => {
    const stages: Stage[] = [{ kind: "lexical", impl: lexStub([hit("a", 0.9), hit("b", 0.5)]) }]
    const r1 = await compose(stages).search(q())
    const r2 = await compose(stages).search(q())
    expect(r1).toEqual(r2)
  })

  test("HELL-PI-14 assemblePipeline primitive is default-OFF when no preset is selected", async () => {
    // The previous test grepped a deleted absolute worktree path, so it stayed
    // green after the real runner began importing this module. Pin the actual
    // contract instead: host-level lexical search is separately tested at
    // HELL-IDX-22, while this lower-level composer must not self-enable.
    const { assemblePipeline } = await import("@/runner/assemble/pipeline")
    expect(assemblePipeline({})).toBeNull()
    expect(assemblePipeline({ QUANTA_PIPELINE: "" })).toBeNull()
  })

  test("HELL-PI-15 PipelineError is a 6-arm closed exhaustive union", () => {
    // Compile-time + runtime mirror: any future arm must be added here too.
    const arms: PipelineError["kind"][] = [
      "empty-pipeline",
      "unknown-stage",
      "stage-failed",
      "budget-exceeded",
      "invalid-config",
      "no-results",
    ]
    expect(arms.length).toBe(6)
    // exhaustive switch — TS `never` if an arm is missing.
    const cover = (e: PipelineError): string => {
      switch (e.kind) {
        case "empty-pipeline":
          return "a"
        case "unknown-stage":
          return "b"
        case "stage-failed":
          return "c"
        case "budget-exceeded":
          return "d"
        case "invalid-config":
          return "e"
        case "no-results":
          return "f"
      }
    }
    expect(cover({ kind: "empty-pipeline" })).toBe("a")
  })

  test("HELL-PI-16 RRF k cap is applied at the boundary", async () => {
    const big = Array.from({ length: 50 }, (_, i) => hit(`a${i}`, 0.5))
    const pipe = parallelRrfPipeline({
      lex: lexStub(big),
      sem: semStub(big.map((h) => ({ ...h, source: "semantic" as const }))),
      embedder: embStub([0]),
    })
    const r = await pipe.search({ text: "x", k: 7 })
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.length).toBe(7)
  })

  test("HELL-PI-17 semantic + cache integration mock — cache hit avoids embed", async () => {
    let embedCalls = 0
    const embedder: Embedder = {
      async embed(_t: string) {
        embedCalls++
        return [0.1]
      },
    }
    const cache = new Map<string, readonly number[]>([["q1", [0.99]]])
    const pipe = compose([
      {
        kind: "semantic",
        impl: semStub([hit("z", 0.5, "semantic")]),
        embedder,
        cache: { get: (k) => cache.get(k), set: (k, v) => cache.set(k, v) },
      },
    ])
    const r = await pipe.search({ text: "q1", k: 5 })
    expect(r.ok).toBe(true)
    expect(embedCalls).toBe(0)
  })

  test("HELL-PI-18 semantic + batcher integration mock — batcher receives the embed call", async () => {
    let batchCalls = 0
    const batcher = {
      async embedBatched(
        texts: readonly string[],
        embedder: Embedder,
      ): Promise<readonly (readonly number[])[]> {
        batchCalls++
        return Promise.all(texts.map((t) => embedder.embed(t)))
      },
    }
    const pipe = compose([
      {
        kind: "semantic",
        impl: semStub([hit("z", 0.5, "semantic")]),
        embedder: embStub([0.1]),
        batcher,
      },
    ])
    const r = await pipe.search({ text: "q1", k: 5 })
    expect(r.ok).toBe(true)
    expect(batchCalls).toBe(1)
  })

  test("HELL-PI-19 1000-doc + multi-stage performance sanity (< 200ms)", async () => {
    const big = Array.from({ length: 1000 }, (_, i) => hit(`d${i}`, Math.random()))
    const pipe = parallelRrfPipeline({
      lex: lexStub(big),
      sem: semStub(big.map((h) => ({ ...h, source: "semantic" as const }))),
      embedder: embStub([0]),
    })
    const t0 = Date.now()
    const r = await pipe.search({ text: "q", k: 20 })
    const dt = Date.now() - t0
    expect(r.ok).toBe(true)
    expect(dt).toBeLessThan(200)
  })

  test("HELL-PI-20 all 5 presets execute with their minimal default args", async () => {
    const lex = lexStub([hit("a", 0.9)])
    const sem = semStub([hit("a", 0.9, "semantic")])
    const emb = embStub([0.1])
    const presets = [
      lexicalOnlyPipeline({ lex }),
      semanticOnlyPipeline({ sem, embedder: emb }),
      parallelRrfPipeline({ lex, sem, embedder: emb }),
      semanticThenRerankPipeline({ sem, embedder: emb, reranker: rrStub }),
      budgetAwarePipeline({
        inner: { kind: "lexical", impl: lex },
        maxUsd: 1,
        probe: { usdSoFar: () => 0 },
      }),
    ]
    for (const pipe of presets) {
      const r = await pipe.search(q())
      expect(r.ok).toBe(true)
    }
  })
})
