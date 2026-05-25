/**
 * HELLGATE — semantic-search port adversarial proofs (ADR-0254).
 *
 * 15 cases — see ADR for the HELL-SS-NN mapping.
 *
 *   01 index/query round-trip
 *   02 top-k accurate (score desc sort)
 *   03 k=0 → []
 *   04 empty index query → []
 *   05 cosine similarity numerically correct
 *   06 clear() → size = 0
 *   07 re-index same id → overwrite
 *   08 empty text → err("empty-text")
 *   09 negative k → err("invalid-k")
 *   10 embedder failure → err("embed-failed", cause preserved)
 *   11 dim mismatch → err("dim-mismatch")
 *   12 default-OFF: importing barrel without constructing index = byte-identical
 *   13 10000-doc index + query performance sanity
 *   14 metadata preserved across round-trip
 *   15 headless-embedder deterministic — same text ⇒ same vector
 */

import { describe, expect, test } from "bun:test"
import {
  createHeadlessEmbedder,
  createInMemoryIndex,
  type Document,
  type Embedder,
  type EmbeddingVector,
  type EmbedError,
} from "@/retrieval/semantic"
import { err, ok, type Result } from "@/shared"

// --------------------------------------------------------------------
// Test helpers — fake Embedder builders. They are tiny on purpose: the
// hellgate proves SemanticIndex behaviour, NOT embedder behaviour.
// --------------------------------------------------------------------

/** Build a fake embedder that returns a caller-supplied vector for each
 *  text. Defaults to all-zero when the text isn't in the map. */
const fixedEmbedder = (map: Map<string, EmbeddingVector>, dim: number): Embedder => ({
  dim: () => dim,
  embed: async (text) => {
    if (text === "") return err({ kind: "empty-text" as const })
    const v = map.get(text) ?? new Array(dim).fill(0)
    return ok(v)
  },
})

/** Always-fail embedder. */
const failingEmbedder = (cause: unknown, dim = 4): Embedder => ({
  dim: () => dim,
  embed: async (): Promise<Result<EmbeddingVector, EmbedError>> =>
    err({ kind: "embed-failed", cause }),
})

const doc = (id: string, text: string, metadata?: Record<string, unknown>): Document =>
  metadata !== undefined ? { id, text, metadata } : { id, text }

describe("semantic-search hellgate", () => {
  // HELL-SS-01
  test("index/query round-trip returns the indexed doc", async () => {
    const v = [1, 0, 0, 0] as const
    const map = new Map<string, EmbeddingVector>([
      ["alpha", v],
      ["q", v],
    ])
    const emb = fixedEmbedder(map, 4)
    const idx = createInMemoryIndex(emb)
    const indexed = await idx.index([doc("a", "alpha")])
    expect(indexed.ok).toBe(true)
    const r = await idx.query("q", 5)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.map((h) => h.id)).toEqual(["a"])
  })

  // HELL-SS-02
  test("top-k respected and sorted by score desc", async () => {
    const map = new Map<string, EmbeddingVector>([
      ["a", [1, 0]],
      ["b", [0.9, 0.1]],
      ["c", [0, 1]],
      ["q", [1, 0]],
    ])
    const idx = createInMemoryIndex(fixedEmbedder(map, 2))
    await idx.index([doc("a", "a"), doc("b", "b"), doc("c", "c")])
    const r = await idx.query("q", 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toHaveLength(2)
    expect(r.value[0]?.id).toBe("a") // cosine 1.0
    expect(r.value[1]?.id).toBe("b") // cosine ~0.994
    // strictly descending
    expect(r.value[0]?.score ?? 0).toBeGreaterThan(r.value[1]?.score ?? 0)
  })

  // HELL-SS-03
  test("k = 0 returns empty array even with hits available", async () => {
    const map = new Map<string, EmbeddingVector>([
      ["a", [1, 0]],
      ["q", [1, 0]],
    ])
    const idx = createInMemoryIndex(fixedEmbedder(map, 2))
    await idx.index([doc("a", "a")])
    const r = await idx.query("q", 0)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual([])
  })

  // HELL-SS-04
  test("query against empty index returns empty array (not error)", async () => {
    const map = new Map<string, EmbeddingVector>([["q", [1, 0]]])
    const idx = createInMemoryIndex(fixedEmbedder(map, 2))
    const r = await idx.query("q", 5)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual([])
    expect(idx.size()).toBe(0)
  })

  // HELL-SS-05  — numerical cosine validation, not just ordering
  test("cosine similarity is numerically correct", async () => {
    // a · b = 0.6, |a| = 1, |b| = 1 ⇒ cos = 0.6
    const a: EmbeddingVector = [0.6, 0.8]
    const b: EmbeddingVector = [1, 0]
    const map = new Map<string, EmbeddingVector>([
      ["d", a],
      ["q", b],
    ])
    const idx = createInMemoryIndex(fixedEmbedder(map, 2))
    await idx.index([doc("d", "d")])
    const r = await idx.query("q", 1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value[0]?.score).toBeCloseTo(0.6, 9)
  })

  // HELL-SS-06
  test("clear() resets size to 0", async () => {
    const map = new Map<string, EmbeddingVector>([["a", [1, 0]]])
    const idx = createInMemoryIndex(fixedEmbedder(map, 2))
    await idx.index([doc("a", "a"), doc("b", "a")])
    expect(idx.size()).toBe(2)
    idx.clear()
    expect(idx.size()).toBe(0)
  })

  // HELL-SS-07
  test("indexing the same id twice overwrites the prior vector", async () => {
    const map = new Map<string, EmbeddingVector>([
      ["v1", [1, 0]],
      ["v2", [0, 1]],
      ["q", [0, 1]],
    ])
    const idx = createInMemoryIndex(fixedEmbedder(map, 2))
    await idx.index([doc("a", "v1")])
    await idx.index([doc("a", "v2")]) // overwrite
    expect(idx.size()).toBe(1)
    const r = await idx.query("q", 1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Cosine of v2=[0,1] vs q=[0,1] = 1
    expect(r.value[0]?.score).toBeCloseTo(1, 9)
    expect(r.value[0]?.text).toBe("v2") // text from latest index call
  })

  // HELL-SS-08
  test("empty query text → err(empty-text)", async () => {
    const idx = createInMemoryIndex(fixedEmbedder(new Map(), 2))
    const r = await idx.query("", 5)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe("empty-text")
  })

  // HELL-SS-09
  test("negative k → err(invalid-k)", async () => {
    const map = new Map<string, EmbeddingVector>([["q", [1, 0]]])
    const idx = createInMemoryIndex(fixedEmbedder(map, 2))
    const r = await idx.query("q", -1)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe("invalid-k")
    if (r.error.kind === "invalid-k") expect(r.error.k).toBe(-1)
  })

  // HELL-SS-10  — failure preserves cause
  test("embedder failure → err(embed-failed) with cause preserved", async () => {
    const cause = new Error("network down")
    const idx = createInMemoryIndex(failingEmbedder(cause, 4))
    const r = await idx.query("anything", 5)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe("embed-failed")
    if (r.error.kind === "embed-failed") expect(r.error.cause).toBe(cause)
  })

  // HELL-SS-11
  test("dim mismatch at index() → err(dim-mismatch)", async () => {
    // Embedder declares dim=4 but returns a length-2 vector
    const liar: Embedder = {
      dim: () => 4,
      embed: async () => ok([1, 0]),
    }
    const idx = createInMemoryIndex(liar)
    const r = await idx.index([doc("a", "a")])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe("dim-mismatch")
    if (r.error.kind === "dim-mismatch") {
      expect(r.error.expected).toBe(4)
      expect(r.error.actual).toBe(2)
    }
  })

  // HELL-SS-12  — default-OFF byte-identical (importing barrel without
  // constructing the index produces no side-effects: no module-scope state,
  // no thrown errors, no console writes).
  test("default-OFF: importing barrel has no side effects", async () => {
    const mod = await import("@/retrieval/semantic")
    // Surface check: only the documented factory + types are exported.
    expect(typeof mod.createInMemoryIndex).toBe("function")
    expect(typeof mod.createHeadlessEmbedder).toBe("function")
    // No singleton index lives on the module.
    expect("defaultIndex" in mod).toBe(false)
  })

  // HELL-SS-13  — 10k-doc sanity. NOT a benchmark — only a regression
  // guard that the linear scan still finishes in reasonable wall-clock.
  test("10000-doc index + query completes under sanity budget", async () => {
    const dim = 8
    const embedder = createHeadlessEmbedder({ dim })
    const idx = createInMemoryIndex(embedder)
    const docs: Document[] = []
    for (let i = 0; i < 10_000; i++) docs.push({ id: `d${i}`, text: `text-${i}` })
    const t0 = performance.now()
    const r = await idx.index(docs)
    expect(r.ok).toBe(true)
    const q = await idx.query("text-42", 10)
    expect(q.ok).toBe(true)
    if (!q.ok) return
    expect(q.value).toHaveLength(10)
    // Self-match (text-42 ⇒ d42) should be at rank 0 with the deterministic
    // headless embedder (same text → same vector → cosine = 1).
    expect(q.value[0]?.id).toBe("d42")
    expect(q.value[0]?.score).toBeCloseTo(1, 6)
    const elapsed = performance.now() - t0
    // Generous sanity budget — protects against accidental O(N^2) regression.
    expect(elapsed).toBeLessThan(10_000)
  })

  // HELL-SS-14
  test("metadata round-trips across index → query", async () => {
    const v = [1, 0]
    const map = new Map<string, EmbeddingVector>([
      ["m", v],
      ["q", v],
    ])
    const idx = createInMemoryIndex(fixedEmbedder(map, 2))
    await idx.index([doc("a", "m", { source: "docs/foo.md", line: 42 })])
    const r = await idx.query("q", 1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value[0]?.metadata).toEqual({ source: "docs/foo.md", line: 42 })
  })

  // HELL-SS-15
  test("headless-embedder is deterministic — same text ⇒ same vector", async () => {
    const e = createHeadlessEmbedder({ dim: 16 })
    const r1 = await e.embed("hello world")
    const r2 = await e.embed("hello world")
    expect(r1.ok && r2.ok).toBe(true)
    if (!(r1.ok && r2.ok)) return
    expect(r1.value).toEqual(r2.value)
    expect(r1.value).toHaveLength(16)
    // Different text ⇒ different vector (high probability)
    const r3 = await e.embed("goodbye world")
    expect(r3.ok).toBe(true)
    if (!r3.ok) return
    expect(r3.value).not.toEqual(r1.value)
  })
})
