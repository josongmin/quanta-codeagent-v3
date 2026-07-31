/**
 * ★ CONTRACT — C5: src/memory/{ranking,dedup,eviction,consolidate}.ts.
 *   recall HARD filters (tag / freshness / supersede) cannot be bypassed by a
 *   max-vector-score decoy. Supersede CHAIN A→B→C: only C is recalled (A and
 *   B excluded even if higher-scored). Eviction 30d boundary EXACT (decay vs
 *   delete, EVICTION_DECAY=0.5); superseded + aged → deleted; archived
 *   survivors → decay (not delete). Tier caps INDEPENDENT (flood one → others
 *   not evicted; over-cap drops lowest-priority first).
 */

import { describe, expect, test } from "bun:test"
import { persistSession, recallBudgetHint, recallContext, SESSION_TAG } from "@/agent/memory"
import type { LLMPort, Message, StreamEvent } from "@/llm"
import { type EmbedderPort, InMemoryStore, type PersistentStorePort } from "@/memory"
import { DEFAULT_EVICTION_CAPS, EVICTION_DECAY, planEviction } from "@/memory/eviction"
import { rankEntries } from "@/memory/ranking"
import { EMBED_DIM, type MemoryEntry, type MemoryQuery, STALE_MAX_MS } from "@/memory/types"

/**
 * C5 — memory consolidate/evict boundary HELLGATE.
 *
 * Recall and eviction are the two seams where stale or superseded knowledge can
 * leak back into the prompt as if it were current truth. These cases attack the
 * hard guarantees: (1) a supersede CHAIN never resurrects a dead link even when
 * the dead link is textually identical and high-scoring; (2) the eviction age
 * threshold is exact (decay-not-delete at the boundary); (3) tier caps are
 * INDEPENDENT (flooding one tier never evicts another); (4) recall hard filters
 * (tags, freshness, superseded) are HARD — a high-vector-score item cannot
 * bypass them.
 */

const NOW = 1_000_000_000_000
const DAY = 24 * 60 * 60 * 1000

/** Unit embedding dominated by `axis` (cosine 1 with itself, ~0 with others). */
const vec = (axis: number): number[] => {
  const v = new Array(EMBED_DIM).fill(0)
  v[axis % EMBED_DIM] = 1
  return v
}

const entry = (over: Partial<MemoryEntry> & { id: string }): MemoryEntry => ({
  kind: "fact",
  text: "",
  tags: [],
  tier: "semantic",
  createdAt: NOW,
  ...over,
})

const ids = (r: { id: string }[]): string[] => r.map((e) => e.id)

describe("C5 hellgate — supersede CHAIN (A→B→C): only the live tail is recalled", () => {
  // A superseded-by B, B superseded-by C, C live. Every link in the chain
  // except C carries a `supersededBy`, so recall (which excludes any entry with
  // `supersededBy` set) must return ONLY C — even though A and B are textually
  // identical to the query and would otherwise score at the top.
  const buildChain = (): MemoryEntry[] => [
    entry({
      id: "A",
      text: "deploy target is us-east-1",
      embedding: vec(3),
      importance: 1, // would dominate if not filtered
      supersededBy: "B",
    }),
    entry({
      id: "B",
      text: "deploy target is us-east-1",
      embedding: vec(3),
      importance: 1,
      supersededBy: "C",
    }),
    entry({
      id: "C",
      text: "deploy target is eu-west-1",
      embedding: vec(9),
      importance: 0.5, // lower score, but it is the only live link
    }),
  ]

  test("recall returns ONLY C; A and B excluded despite identical text + max importance", () => {
    const q: MemoryQuery = { text: "deploy target is us-east-1", embedding: vec(3) }
    const out = rankEntries(buildChain(), q, NOW)
    expect(ids(out)).toEqual(["C"])
  })

  test("the dead links would have OUTSCORED C if not filtered (proves the filter, not luck)", () => {
    // Same chain but flip every link live (clear supersededBy) → A/B now top C.
    const allLive = buildChain().map((e) => {
      const { supersededBy: _drop, ...rest } = e
      return rest as MemoryEntry
    })
    const q: MemoryQuery = { text: "deploy target is us-east-1", embedding: vec(3) }
    const ranked = ids(rankEntries(allLive, q, NOW))
    // A and B (identical text + vec hit + importance 1) sit ABOVE C.
    expect(ranked.indexOf("A")).toBeLessThan(ranked.indexOf("C"))
    expect(ranked.indexOf("B")).toBeLessThan(ranked.indexOf("C"))
  })

  test("includeSuperseded:true resurrects the whole chain (escape hatch is explicit-only)", () => {
    const q: MemoryQuery = { text: "deploy target is us-east-1", embedding: vec(3) }
    const out = ids(rankEntries(buildChain(), { ...q, includeSuperseded: true }, NOW))
    expect(out.sort()).toEqual(["A", "B", "C"])
  })
})

describe("C5 hellgate — eviction decay/delete age boundary (exactly STALE_MAX_MS)", () => {
  test("STALE_MAX_MS constant is 30 days (pins the boundary the cases probe)", () => {
    expect(STALE_MAX_MS).toBe(30 * DAY)
    expect(EVICTION_DECAY).toBe(0.5)
  })

  test("archived survivor EXACTLY at 30d ⇒ NOT decayed and NOT deleted (bucket boundary is inclusive of stale)", () => {
    // age == STALE_MAX_MS → bucketOf returns "stale" (<=), NOT "archived", so
    // shouldDecay is false; and it is not superseded so no delete. Survives clean.
    const cand = [entry({ id: "atBoundary", importance: 0.5, createdAt: NOW - STALE_MAX_MS })]
    const plan = planEviction(cand, undefined, NOW)
    expect(plan.delete).toEqual([])
    expect(plan.decay).toEqual([])
  })

  test("archived survivor 1ms PAST 30d ⇒ decayed (not deleted) — the boundary actually flips", () => {
    const cand = [entry({ id: "pastBoundary", importance: 0.5, createdAt: NOW - STALE_MAX_MS - 1 })]
    const plan = planEviction(cand, undefined, NOW)
    expect(plan.decay).toEqual(["pastBoundary"])
    expect(plan.delete).toEqual([])
  })

  test("superseded entry EXACTLY at 30d ⇒ NOT deleted (delete requires strictly > STALE_MAX_MS)", () => {
    const cand = [entry({ id: "supAt", supersededBy: "x", createdAt: NOW - STALE_MAX_MS })]
    const plan = planEviction(cand, undefined, NOW)
    // age is not > STALE_MAX_MS, so no ancient-superseded delete. It is stale
    // (not archived) so no decay either.
    expect(plan.delete).toEqual([])
    expect(plan.decay).toEqual([])
  })

  test("superseded + aged 1ms past 30d ⇒ DELETED regardless of importance/cap", () => {
    const cand = [
      entry({
        id: "supPast",
        importance: 1,
        supersededBy: "x",
        createdAt: NOW - STALE_MAX_MS - 1,
      }),
    ]
    const plan = planEviction(cand, undefined, NOW)
    expect(plan.delete).toEqual(["supPast"])
    expect(plan.decay).toEqual([])
  })
})

describe("C5 hellgate — tier caps are bounded INDEPENDENTLY", () => {
  test("flooding semantic past its cap does NOT evict any episodic entry", () => {
    const semantic = Array.from({ length: 6 }, (_, i) =>
      entry({
        id: `s${i}`,
        tier: "semantic",
        importance: i / 10, // s0 lowest, s5 highest
        createdAt: NOW,
      }),
    )
    const episodic = Array.from({ length: 3 }, (_, i) =>
      entry({ id: `e${i}`, tier: "episodic", importance: 0.01, createdAt: NOW }),
    )
    // Cap semantic at 2, leave episodic at its generous default (200).
    const plan = planEviction([...semantic, ...episodic], { semanticMax: 2 }, NOW)
    // No episodic id appears in either list — the other tier is untouched.
    for (const id of ["e0", "e1", "e2"]) {
      expect(plan.delete).not.toContain(id)
      expect(plan.decay).not.toContain(id)
    }
    // The over-cap semantic tier drops its LOWEST-value entries first (keep top 2).
    expect(plan.delete.sort()).toEqual(["s0", "s1", "s2", "s3"])
  })

  test("symmetric: flooding episodic past cap leaves semantic intact", () => {
    const episodic = Array.from({ length: 5 }, (_, i) =>
      entry({ id: `e${i}`, tier: "episodic", importance: i / 10, createdAt: NOW }),
    )
    const semantic = [
      entry({ id: "keepSem1", tier: "semantic", importance: 0.01, createdAt: NOW }),
      entry({ id: "keepSem2", tier: "semantic", importance: 0.02, createdAt: NOW }),
    ]
    const plan = planEviction([...episodic, ...semantic], { episodicMax: 1 }, NOW)
    expect(plan.delete).not.toContain("keepSem1")
    expect(plan.delete).not.toContain("keepSem2")
    // episodic keeps top-1 (e4), drops e0..e3 (lowest first).
    expect(plan.delete.sort()).toEqual(["e0", "e1", "e2", "e3"])
  })

  test("DEFAULT_EVICTION_CAPS gives semantic the larger budget (durable core)", () => {
    expect(DEFAULT_EVICTION_CAPS.semanticMax).toBeGreaterThan(DEFAULT_EVICTION_CAPS.episodicMax)
  })
})

describe("C5 hellgate — recall HARD filters cannot be bypassed by score", () => {
  test("tag filter is HARD: a max-vector-score item with a non-matching tag is excluded", () => {
    const cand = [
      // Perfect vector hit + huge importance, but WRONG tag → must be excluded.
      entry({ id: "loud", tags: ["home"], embedding: vec(4), importance: 1 }),
      // Weak everything, but RIGHT tag → must be the only survivor.
      entry({ id: "tagged", tags: ["work"], importance: 0.1 }),
    ]
    const q: MemoryQuery = { tags: ["work"], embedding: vec(4) }
    expect(ids(rankEntries(cand, q, NOW))).toEqual(["tagged"])
  })

  test("freshness filter does NOT resurrect a superseded item (supersede dominates freshness)", () => {
    const cand = [
      // Fresh AND requested freshness bucket, BUT superseded → excluded.
      entry({
        id: "freshButDead",
        createdAt: NOW,
        supersededBy: "live",
        embedding: vec(2),
        importance: 1,
      }),
      // Also fresh, live → the only survivor.
      entry({ id: "live", createdAt: NOW, embedding: vec(2), importance: 0.1 }),
    ]
    const q: MemoryQuery = { freshness: ["fresh"], embedding: vec(2) }
    expect(ids(rankEntries(cand, q, NOW))).toEqual(["live"])
  })

  test("freshness is HARD: a top-scoring stale item is excluded when only 'fresh' is requested", () => {
    const cand = [
      entry({ id: "staleLoud", createdAt: NOW - 2 * DAY, embedding: vec(5), importance: 1 }),
      entry({ id: "freshQuiet", createdAt: NOW, importance: 0.1 }),
    ]
    // age 2d → "stale" bucket; requesting only "fresh" must drop staleLoud.
    const q: MemoryQuery = { freshness: ["fresh"], embedding: vec(5) }
    expect(ids(rankEntries(cand, q, NOW))).toEqual(["freshQuiet"])
  })

  test("combined: tag + supersede + freshness filters all hold against a single max-score decoy", () => {
    const cand = [
      // Decoy: perfect vector, importance 1, fresh — but wrong tag AND superseded.
      entry({
        id: "decoy",
        tags: ["home"],
        embedding: vec(6),
        importance: 1,
        createdAt: NOW,
        supersededBy: "z",
      }),
      entry({ id: "survivor", tags: ["work"], embedding: vec(6), importance: 0.2, createdAt: NOW }),
    ]
    const q: MemoryQuery = { tags: ["work"], freshness: ["fresh"], embedding: vec(6) }
    expect(ids(rankEntries(cand, q, NOW))).toEqual(["survivor"])
  })
})

/* ------------------------------------------------------------------ */
/* merged from memory.test.ts */
/* ------------------------------------------------------------------ */

const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
})
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })

/**
 * Fixed epoch for deterministic wall-clock arithmetic in eviction/freshness
 * tests. The memory module's `archived` boundary lives at exactly 40 days
 * past `createdAt`; with a real `Date.now()`, CI clock skew or a slow setup
 * could nudge entries across that boundary. Pinning both ends to `TEST_NOW`
 * (and injecting it via the `now` deps seam) makes the threshold unambiguous.
 */
const TEST_NOW = 1_700_000_000_000
const fixedNow = (): number => TEST_NOW

/** Deterministic 1536-vec derived from a string hash (stable per text). */
const fakeVec = (text: string): number[] => {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = (h ^ text.charCodeAt(i)) * 16777619
  const out = new Array<number>(EMBED_DIM)
  for (let i = 0; i < EMBED_DIM; i++) {
    h = (h ^ (h << 13)) >>> 0
    out[i] = ((h % 2000) - 1000) / 1000
  }
  return out
}

/** FakeEmbedder: deterministic per-text vectors; optionally always throws. */
const fakeEmbedder = (opts?: { throws?: boolean }): EmbedderPort => ({
  embed: async (texts: string[]) => {
    if (opts?.throws) throw new Error("embed down")
    return texts.map(fakeVec)
  },
})

/** FakeLLM: streams `out` as one text_delta + message_stop, or throws. */
const fakeLLM = (out: string | { throw: true }): LLMPort => ({
  stream(): AsyncIterable<StreamEvent> {
    return {
      async *[Symbol.asyncIterator]() {
        if (typeof out !== "string") throw new Error("llm down")
        yield { type: "text_delta", delta: out }
        yield { type: "message_stop", stop_reason: "end_turn" }
      },
    }
  },
})

/** Wrap a store so update() always throws (reinforcement robustness test). */
const throwingUpdate = (inner: PersistentStorePort): PersistentStorePort => ({
  save: (e) => inner.save(e),
  update: () => Promise.reject(new Error("update boom")),
  delete: (id) => inner.delete(id),
  get: (id) => inner.get(id),
  all: () => inner.all(),
  recall: (q) => inner.recall(q),
})

describe("recallContext", () => {
  test("lexical-only recall, formatted block", async () => {
    const store = new InMemoryStore([
      { id: "a", kind: "fact", text: "uses Postgres 16", tags: [], createdAt: 1 },
    ])
    const out = await recallContext({ store }, "database")
    expect(out).toBe("## Memory hints (routing hints only — not proof)\n- (fact) uses Postgres 16")
  })

  test("with embedder embeds the query (still recalls)", async () => {
    const store = new InMemoryStore([
      { id: "a", kind: "fact", text: "uses Postgres 16", tags: [], createdAt: 1 },
    ])
    const out = await recallContext({ store, embedder: fakeEmbedder() }, "db engine")
    expect(out).toContain("- (fact) uses Postgres 16")
  })

  test("embedder throwing degrades to lexical (no throw)", async () => {
    const store = new InMemoryStore([{ id: "a", kind: "fact", text: "x", tags: [], createdAt: 1 }])
    const out = await recallContext({ store, embedder: fakeEmbedder({ throws: true }) }, "q")
    expect(out).toContain("- (fact) x")
  })

  test("empty primary (tiers filter) falls back to SESSION_TAG", async () => {
    const store = new InMemoryStore([
      {
        id: "s1",
        kind: "decision",
        tier: "episodic",
        text: "decided on Bun",
        tags: [SESSION_TAG],
        createdAt: 1,
      },
    ])
    // Primary restricted to semantic → empty; fallback (tags, no tier) finds it.
    const out = await recallContext({ store }, "anything", { tiers: ["semantic"] })
    expect(out).toBe(
      "## Memory hints (routing hints only — not proof)\n- (decision) decided on Bun",
    )
  })

  test("empty store → null", async () => {
    const out = await recallContext({ store: new InMemoryStore() }, "q")
    expect(out).toBeNull()
  })

  test("reinforcement bumps accessCount and importance", async () => {
    const store = new InMemoryStore([
      { id: "a", kind: "fact", text: "t", tags: [], createdAt: 1, importance: 0.5, accessCount: 2 },
    ])
    await recallContext({ store }, "t")
    const e = await store.get("a")
    expect(e?.accessCount).toBe(3)
    expect(e?.importance).toBeCloseTo(0.52, 5)
    expect(typeof e?.lastAccessedAt).toBe("number")
  })

  test("reinforcement failure does not break recall", async () => {
    const inner = new InMemoryStore([{ id: "a", kind: "fact", text: "t", tags: [], createdAt: 1 }])
    const out = await recallContext({ store: throwingUpdate(inner) }, "t")
    expect(out).toContain("- (fact) t")
  })

  test("onStats: fires once with recalled count + lexical (embedded=false)", async () => {
    const store = new InMemoryStore([
      { id: "a", kind: "fact", text: "uses Postgres 16", tags: [], createdAt: 1 },
    ])
    const seen: import("@/agent/memory-stats").RecallStats[] = []
    const out = await recallContext({ store, onStats: (s) => seen.push(s) }, "database")
    expect(out).toBe("## Memory hints (routing hints only — not proof)\n- (fact) uses Postgres 16")
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ recalled: 1, embedded: false, fellBack: false })
  })

  test("onStats: embedded=true when an embedder produced the query vector", async () => {
    const store = new InMemoryStore([
      { id: "a", kind: "fact", text: "uses Postgres 16", tags: [], createdAt: 1 },
    ])
    const seen: import("@/agent/memory-stats").RecallStats[] = []
    await recallContext({ store, embedder: fakeEmbedder(), onStats: (s) => seen.push(s) }, "db")
    expect(seen).toHaveLength(1)
    expect(seen[0]?.embedded).toBe(true)
  })

  test("onStats: embedder throwing → embedded=false (lexical degrade)", async () => {
    const store = new InMemoryStore([{ id: "a", kind: "fact", text: "x", tags: [], createdAt: 1 }])
    const seen: import("@/agent/memory-stats").RecallStats[] = []
    await recallContext(
      { store, embedder: fakeEmbedder({ throws: true }), onStats: (s) => seen.push(s) },
      "q",
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.embedded).toBe(false)
  })

  test("onStats: fellBack=true when SESSION_TAG fallback path is taken", async () => {
    const store = new InMemoryStore([
      {
        id: "s1",
        kind: "decision",
        tier: "episodic",
        text: "decided on Bun",
        tags: [SESSION_TAG],
        createdAt: 1,
      },
    ])
    const seen: import("@/agent/memory-stats").RecallStats[] = []
    const out = await recallContext({ store, onStats: (s) => seen.push(s) }, "anything", {
      tiers: ["semantic"],
    })
    expect(out).toBe(
      "## Memory hints (routing hints only — not proof)\n- (decision) decided on Bun",
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ recalled: 1, embedded: false, fellBack: true })
  })

  test("onStats: empty store → recalled 0, fires once, returns null", async () => {
    const seen: import("@/agent/memory-stats").RecallStats[] = []
    const out = await recallContext(
      { store: new InMemoryStore(), onStats: (s) => seen.push(s) },
      "q",
    )
    expect(out).toBeNull()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ recalled: 0, embedded: false, fellBack: true })
  })

  test("onStats: an observer throw never escapes recallContext", async () => {
    const store = new InMemoryStore([{ id: "a", kind: "fact", text: "t", tags: [], createdAt: 1 }])
    const out = await recallContext(
      {
        store,
        onStats: () => {
          throw new Error("observer boom")
        },
      },
      "t",
    )
    expect(out).toContain("- (fact) t")
  })

  test("text truncated to 600 chars + ellipsis", async () => {
    const long = "x".repeat(700)
    const store = new InMemoryStore([{ id: "a", kind: "fact", text: long, tags: [], createdAt: 1 }])
    const out = await recallContext({ store }, "x")
    expect(out).toBe(
      `## Memory hints (routing hints only — not proof)\n- (fact) ${"x".repeat(600)}…`,
    )
  })
})

describe("recall-budget visibility (truncation disclosure)", () => {
  /** Build N distinct fact entries so the ranker scans N but the limit caps K. */
  const seedN = (n: number): InMemoryStore =>
    new InMemoryStore(
      Array.from({ length: n }, (_, i) => ({
        id: `m${i}`,
        kind: "fact" as const,
        // Shared substring so every entry is a lexical hit for the query → all
        // N are genuine candidates (not filtered out before the limit applies).
        text: `database note ${i}`,
        tags: [],
        createdAt: 1 + i,
      })),
    )

  test("over-limit: block carries the 'recalled K of N' disclosure with correct K/N", async () => {
    // 8 candidates, limit 3 → K=3 injected, N=8 scanned ⇒ truncated.
    const out = await recallContext({ store: seedN(8) }, "database", { limit: 3 })
    expect(out).not.toBeNull()
    const block = out as string
    // Disclosure present, exact K/N, and the memory_search nudge.
    expect(block).toContain("(recalled 3 of 8 candidate memories — use memory_search for more)")
    // Exactly K rendered entry lines (the disclosure is not an entry line).
    const entryLines = block.split("\n").filter((l) => l.startsWith("- (fact)"))
    expect(entryLines).toHaveLength(3)
    // Trust-ladder framing intact (single H2, not duplicated).
    expect(block.match(/## Memory hints/g)).toHaveLength(1)
    expect(block).toContain("routing hints only — not proof")
    // The disclosure rides UNDER the H2 (inside the one hint frame), at the tail.
    expect(block.endsWith("use memory_search for more)")).toBe(true)
  })

  test("no-noise control: when candidates ≤ limit, NO disclosure line", async () => {
    // 3 candidates, limit 5 → K=N=3 ⇒ everything fit ⇒ no disclosure, and the
    // block is byte-identical to the legacy shape (no trailing budget line).
    const out = await recallContext({ store: seedN(3) }, "database", { limit: 5 })
    expect(out).not.toBeNull()
    const block = out as string
    expect(block).not.toContain("candidate memories")
    expect(block).not.toContain("memory_search")
    expect(block.split("\n").filter((l) => l.startsWith("- (fact)"))).toHaveLength(3)
  })

  test("boundary: candidates EXACTLY equal to limit ⇒ no disclosure (only N>K)", async () => {
    // 4 candidates, limit 4 → K=N=4 ⇒ no truncation ⇒ no line (strict >).
    const out = await recallContext({ store: seedN(4) }, "database", { limit: 4 })
    expect(out as string).not.toContain("candidate memories")
  })

  test("teeth: recallBudgetHint emits ONLY when scanned > injected", () => {
    // The exact disclosure the renderer appends — removing/altering this line
    // (the teeth) flips the over-limit assertion above to red.
    expect(recallBudgetHint(3, 8)).toBe(
      "(recalled 3 of 8 candidate memories — use memory_search for more)",
    )
    // Fits / boundary / over-fit ⇒ undefined (no noise).
    expect(recallBudgetHint(5, 3)).toBeUndefined()
    expect(recallBudgetHint(4, 4)).toBeUndefined()
    expect(recallBudgetHint(0, 0)).toBeUndefined()
  })

  test("ranking weights/limit unchanged: K honors the requested limit verbatim", async () => {
    // Adversarial control — confirm the fix did not alter the cap: with limit 2
    // over 8 candidates, EXACTLY 2 entries are injected and N is reported as 8.
    const out = (await recallContext({ store: seedN(8) }, "database", { limit: 2 })) as string
    expect(out.split("\n").filter((l) => l.startsWith("- (fact)"))).toHaveLength(2)
    expect(out).toContain("(recalled 2 of 8 candidate memories — use memory_search for more)")
  })
})

describe("persistSession", () => {
  test("heuristic path (no llm) persists final assistant text", async () => {
    const store = new InMemoryStore()
    await persistSession(
      { store },
      { sessionId: "s1", finalMessages: [user("hi"), assistant("Final decision: ship it.")] },
    )
    const all = await store.all()
    expect(all).toHaveLength(1)
    expect(all[0]?.text).toBe("Final decision: ship it.")
    expect(all[0]?.tags).toContain(SESSION_TAG)
  })

  test("no assistant text → no-op", async () => {
    const store = new InMemoryStore()
    await persistSession({ store }, { sessionId: "s1", finalMessages: [user("hi")] })
    expect((await store.all()).length).toBe(0)
  })

  test("distill path (FakeLLM JSON array) inserts records", async () => {
    const store = new InMemoryStore()
    const json = JSON.stringify([
      {
        kind: "fact",
        tier: "semantic",
        text: "uses Bun runtime",
        tags: ["stack"],
        importance: 0.9,
      },
    ])
    await persistSession(
      { store, llm: fakeLLM(json) },
      { sessionId: "s2", finalMessages: [user("q"), assistant("done")] },
    )
    const all = await store.all()
    expect(all).toHaveLength(1)
    expect(all[0]?.text).toBe("uses Bun runtime")
    expect(all[0]?.kind).toBe("fact")
  })

  test("re-running a session updates rather than duplicates (deterministic id)", async () => {
    const store = new InMemoryStore()
    const input = { sessionId: "s3", finalMessages: [user("q"), assistant("stable summary")] }
    await persistSession({ store }, input)
    await persistSession({ store }, input)
    // Second run: exact-text dupe → heuristic skip. Still one entry.
    expect((await store.all()).length).toBe(1)
  })

  test("heuristic skip on exact-text dupe", async () => {
    const store = new InMemoryStore([
      { id: "old", kind: "decision", text: "ship it", tags: [SESSION_TAG], createdAt: 1 },
    ])
    await persistSession({ store }, { sessionId: "s4", finalMessages: [assistant("ship it")] })
    expect((await store.all()).length).toBe(1)
  })

  test("LLM merge op updates target, does not save candidate", async () => {
    const store = new InMemoryStore([
      {
        id: "old",
        kind: "fact",
        text: "alpha beta gamma delta",
        tags: [],
        createdAt: TEST_NOW,
      },
    ])
    const op = JSON.stringify({
      action: "merge",
      intoId: "old",
      text: "alpha beta gamma delta merged",
      tags: ["db"],
      importance: 0.8,
    })
    await persistSession(
      { store, llm: fakeLLM(op), distill: false, now: fixedNow },
      { sessionId: "s5", finalMessages: [assistant("alpha beta gamma delta epsilon")] },
    )
    const all = await store.all()
    expect(all).toHaveLength(1)
    expect(all[0]?.text).toBe("alpha beta gamma delta merged")
    expect(all[0]?.importance).toBeCloseTo(0.8, 5)
  })

  test("LLM supersede op saves candidate and marks old superseded", async () => {
    const store = new InMemoryStore([
      { id: "old", kind: "fact", text: "one two three four five", tags: [], createdAt: TEST_NOW },
    ])
    const op = JSON.stringify({ action: "supersede", oldId: "old" })
    await persistSession(
      { store, llm: fakeLLM(op), distill: false, now: fixedNow },
      { sessionId: "s6", finalMessages: [assistant("one two three four six")] },
    )
    const all = await store.all()
    expect(all).toHaveLength(2)
    const old = all.find((e) => e.id === "old")
    expect(old?.supersededBy).toBeDefined()
  })

  test("LLM skip op persists nothing", async () => {
    const store = new InMemoryStore([
      { id: "old", kind: "fact", text: "uses postgres database thing", tags: [], createdAt: 1 },
    ])
    await persistSession(
      { store, llm: fakeLLM('{"action":"skip"}'), distill: false },
      { sessionId: "s7", finalMessages: [assistant("uses postgres database stuff")] },
    )
    expect((await store.all()).length).toBe(1)
  })

  test("eviction deletes cap-overflow entries", async () => {
    const seed: MemoryEntry[] = []
    for (let i = 0; i < 6; i++) {
      seed.push({
        id: `e${i}`,
        kind: "fact",
        tier: "episodic",
        text: `entry ${i}`,
        tags: [],
        createdAt: 1000 + i,
        importance: 0.1,
      })
    }
    const store = new InMemoryStore(seed)
    await persistSession(
      { store, evictionCaps: { episodicMax: 2 } },
      { sessionId: "s8", finalMessages: [assistant("a fresh distinct summary line")] },
    )
    const all = await store.all()
    const episodic = all.filter((e) => e.tier === "episodic")
    expect(episodic.length).toBeLessThanOrEqual(2)
  })

  test("eviction decays archived low-value survivors", async () => {
    const old = TEST_NOW - 40 * 24 * 60 * 60 * 1000 // 40d → archived
    const store = new InMemoryStore([
      {
        id: "arch",
        kind: "fact",
        tier: "semantic",
        text: "old archived knowledge",
        tags: [],
        createdAt: old,
        importance: 0.8,
      },
    ])
    await persistSession(
      { store, now: fixedNow },
      { sessionId: "s9", finalMessages: [assistant("an unrelated brand new summary")] },
    )
    const e = await store.get("arch")
    expect(e?.importance).toBeCloseTo(0.4, 5) // 0.8 * EVICTION_DECAY(0.5)
  })

  test("onStats: heuristic path reports distilled+inserted exactly once", async () => {
    const store = new InMemoryStore()
    const seen: import("@/agent/memory-stats").PersistStats[] = []
    await persistSession(
      { store, onStats: (s) => seen.push(s) },
      { sessionId: "ps1", finalMessages: [user("hi"), assistant("a distinct heuristic line")] },
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      distilled: 1,
      inserted: 1,
      merged: 0,
      superseded: 0,
      skipped: 0,
    })
  })

  test("onStats: no-records path still fires once (all zero)", async () => {
    const store = new InMemoryStore()
    const seen: import("@/agent/memory-stats").PersistStats[] = []
    await persistSession(
      { store, onStats: (s) => seen.push(s) },
      { sessionId: "ps2", finalMessages: [user("hi")] },
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.distilled).toBe(0)
    expect(seen[0]?.inserted).toBe(0)
  })

  test("onStats: distill path reports distilled+inserted", async () => {
    const store = new InMemoryStore()
    const json = JSON.stringify([
      {
        kind: "fact",
        tier: "semantic",
        text: "uses Bun runtime",
        tags: ["stack"],
        importance: 0.9,
      },
    ])
    const seen: import("@/agent/memory-stats").PersistStats[] = []
    await persistSession(
      { store, llm: fakeLLM(json), onStats: (s) => seen.push(s) },
      { sessionId: "ps3", finalMessages: [user("q"), assistant("done")] },
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ distilled: 1, inserted: 1 })
  })

  test("onStats: skip op increments skipped", async () => {
    const store = new InMemoryStore([
      { id: "old", kind: "fact", text: "uses postgres database thing", tags: [], createdAt: 1 },
    ])
    const seen: import("@/agent/memory-stats").PersistStats[] = []
    await persistSession(
      { store, llm: fakeLLM('{"action":"skip"}'), distill: false, onStats: (s) => seen.push(s) },
      { sessionId: "ps4", finalMessages: [assistant("uses postgres database stuff")] },
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ inserted: 0, skipped: 1 })
  })

  test("onStats: merge op increments merged", async () => {
    const store = new InMemoryStore([
      { id: "old", kind: "fact", text: "alpha beta gamma delta", tags: [], createdAt: TEST_NOW },
    ])
    const op = JSON.stringify({
      action: "merge",
      intoId: "old",
      text: "alpha beta gamma delta merged",
      tags: ["db"],
      importance: 0.8,
    })
    const seen: import("@/agent/memory-stats").PersistStats[] = []
    await persistSession(
      { store, llm: fakeLLM(op), distill: false, onStats: (s) => seen.push(s), now: fixedNow },
      { sessionId: "ps5", finalMessages: [assistant("alpha beta gamma delta epsilon")] },
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ merged: 1, inserted: 0 })
  })

  test("onStats: supersede op increments superseded", async () => {
    const store = new InMemoryStore([
      { id: "old", kind: "fact", text: "one two three four five", tags: [], createdAt: TEST_NOW },
    ])
    const op = JSON.stringify({ action: "supersede", oldId: "old" })
    const seen: import("@/agent/memory-stats").PersistStats[] = []
    await persistSession(
      { store, llm: fakeLLM(op), distill: false, onStats: (s) => seen.push(s), now: fixedNow },
      { sessionId: "ps6", finalMessages: [assistant("one two three four six")] },
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ superseded: 1, inserted: 0 })
  })

  test("onStats: eviction sweep reports deleted", async () => {
    const seed: MemoryEntry[] = []
    for (let i = 0; i < 6; i++) {
      seed.push({
        id: `e${i}`,
        kind: "fact",
        tier: "episodic",
        text: `entry ${i}`,
        tags: [],
        createdAt: 1000 + i,
        importance: 0.1,
      })
    }
    const store = new InMemoryStore(seed)
    const seen: import("@/agent/memory-stats").PersistStats[] = []
    await persistSession(
      { store, evictionCaps: { episodicMax: 2 }, onStats: (s) => seen.push(s) },
      { sessionId: "ps7", finalMessages: [assistant("a fresh distinct summary line")] },
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.deleted).toBeGreaterThan(0)
  })

  test("onStats: eviction sweep reports decayed", async () => {
    const old = TEST_NOW - 40 * 24 * 60 * 60 * 1000
    const store = new InMemoryStore([
      {
        id: "arch",
        kind: "fact",
        tier: "semantic",
        text: "old archived knowledge",
        tags: [],
        createdAt: old,
        importance: 0.8,
      },
    ])
    const seen: import("@/agent/memory-stats").PersistStats[] = []
    await persistSession(
      { store, onStats: (s) => seen.push(s), now: fixedNow },
      { sessionId: "ps8", finalMessages: [assistant("an unrelated brand new summary")] },
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.decayed).toBeGreaterThan(0)
  })

  test("onStats: fires once (best-effort) even when store blows up", async () => {
    const boomStore: PersistentStorePort = {
      save: () => Promise.reject(new Error("save boom")),
      update: () => Promise.reject(new Error("update boom")),
      delete: () => Promise.reject(new Error("delete boom")),
      get: () => Promise.reject(new Error("get boom")),
      all: () => Promise.reject(new Error("all boom")),
      recall: () => Promise.reject(new Error("recall boom")),
    }
    const seen: import("@/agent/memory-stats").PersistStats[] = []
    await persistSession(
      { store: boomStore, onStats: (s) => seen.push(s) },
      { sessionId: "ps9", finalMessages: [assistant("text")] },
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.distilled).toBe(1)
    expect(seen[0]?.inserted).toBe(0)
  })

  test("onStats: an observer throw never escapes persistSession", async () => {
    const store = new InMemoryStore()
    await expect(
      persistSession(
        {
          store,
          onStats: () => {
            throw new Error("observer boom")
          },
        },
        { sessionId: "ps10", finalMessages: [assistant("a line")] },
      ),
    ).resolves.toBeUndefined()
  })

  // C10: persistSession used to call store.all() once PER distilled record
  // (in findNearDuplicates) PLUS once in the eviction sweep — O(records+1)
  // full-store scans. It now hoists ONE snapshot and mirrors ops into it.
  describe("C10: store.all() is O(1) per persistSession (not O(records))", () => {
    /** Wrap a store, counting all() calls; everything else passes through. */
    const countingAll = (
      inner: PersistentStorePort,
    ): { store: PersistentStorePort; count: () => number } => {
      let n = 0
      return {
        count: () => n,
        store: {
          save: (e) => inner.save(e),
          update: (id, p) => inner.update(id, p),
          delete: (id) => inner.delete(id),
          get: (id) => inner.get(id),
          all: () => {
            n++
            return inner.all()
          },
          recall: (q) => inner.recall(q),
        },
      }
    }

    test("multi-record distill: exactly ONE store.all() regardless of record count", async () => {
      const json = JSON.stringify([
        { kind: "fact", tier: "semantic", text: "alpha one fact line", tags: [], importance: 0.6 },
        { kind: "fact", tier: "semantic", text: "beta two fact line", tags: [], importance: 0.6 },
        {
          kind: "fact",
          tier: "semantic",
          text: "gamma three fact line",
          tags: [],
          importance: 0.6,
        },
        {
          kind: "decision",
          tier: "episodic",
          text: "delta four decision",
          tags: [],
          importance: 0.6,
        },
      ])
      const { store, count } = countingAll(new InMemoryStore())
      await persistSession(
        { store, llm: fakeLLM(json) },
        { sessionId: "c10a", finalMessages: [user("q"), assistant("done")] },
      )
      // 4 records: old code = 4 (dedup) + 1 (sweep) = 5 scans. New code = 1.
      expect(count()).toBe(1)
    })

    test("single-record path: still exactly ONE store.all()", async () => {
      const { store, count } = countingAll(new InMemoryStore())
      await persistSession(
        { store },
        { sessionId: "c10b", finalMessages: [assistant("a single distinct summary")] },
      )
      expect(count()).toBe(1)
    })

    // Outcome-equivalence: the hoisted-snapshot impl must produce the SAME
    // observable store state the old per-record-rescan impl did. The decisive
    // correctness case is intra-run dedup: a record inserted mid-loop must be
    // visible to a LATER record's findNearDuplicates (old code saw it via the
    // fresh store.all(); new code must see it via the mirrored snapshot push).
    // If the mirror were dropped, the 2nd identical record would wrongly
    // insert → 2 entries instead of 1. That divergence is what we pin.
    const normalized = async (s: PersistentStorePort) =>
      (await s.all())
        .map(
          (e) =>
            `${e.id}|${e.text}|${[...(e.tags ?? [])].sort().join(",")}|${e.importance ?? ""}|${e.supersededBy ?? ""}`,
        )
        .sort()

    test("outcome-equivalence: intra-run dedup — 2nd identical record skips the mid-loop insert", async () => {
      const json = JSON.stringify([
        {
          kind: "fact",
          tier: "semantic",
          text: "one identical durable line",
          tags: ["x"],
          importance: 0.7,
        },
        {
          kind: "fact",
          tier: "semantic",
          text: "one identical durable line",
          tags: ["x"],
          importance: 0.7,
        },
        {
          kind: "fact",
          tier: "semantic",
          text: "a clearly different second line",
          tags: ["y"],
          importance: 0.7,
        },
      ])
      const store = new InMemoryStore()
      await persistSession(
        { store, llm: fakeLLM(json) },
        { sessionId: "c10c", finalMessages: [user("q"), assistant("done")] },
      )
      const all = await store.all()
      // 1st identical inserted; 2nd identical skipped (saw the 1st via the
      // mirrored snapshot); the distinct 3rd inserted → exactly 2 entries.
      expect(all).toHaveLength(2)
      expect(all.filter((e) => e.text === "one identical durable line")).toHaveLength(1)
      expect(all.some((e) => e.text === "a clearly different second line")).toBe(true)
    })

    test("outcome-equivalence: re-run is idempotent (deterministic-id skip) — final state byte-identical", async () => {
      const input = {
        sessionId: "c10d",
        finalMessages: [user("q"), assistant("stable persisted body line")],
      }
      const once = new InMemoryStore()
      await persistSession({ store: once }, input)
      const afterFirst = await normalized(once)
      await persistSession({ store: once }, input) // re-run: exact-text dupe → skip
      const afterSecond = await normalized(once)
      expect(afterSecond).toEqual(afterFirst) // no duplication, no drift
      expect(afterSecond).toHaveLength(1)
    })

    test("outcome-equivalence: merge/supersede outcomes unchanged vs pre-C10 expectations", async () => {
      // Mirrors the existing merge + supersede single-record tests; pins that
      // the snapshot mirroring did not perturb the consolidation outcome.
      const mStore = new InMemoryStore([
        {
          id: "old",
          kind: "fact",
          text: "alpha beta gamma delta",
          tags: [],
          createdAt: TEST_NOW,
        },
      ])
      await persistSession(
        {
          store: mStore,
          llm: fakeLLM(
            JSON.stringify({
              action: "merge",
              intoId: "old",
              text: "alpha beta gamma delta merged",
              tags: ["db"],
              importance: 0.8,
            }),
          ),
          distill: false,
          now: fixedNow,
        },
        { sessionId: "c10e", finalMessages: [assistant("alpha beta gamma delta epsilon")] },
      )
      const m = await mStore.all()
      expect(m).toHaveLength(1)
      expect(m[0]?.text).toBe("alpha beta gamma delta merged")
      expect(m[0]?.importance).toBeCloseTo(0.8, 5)

      const sStore = new InMemoryStore([
        {
          id: "old",
          kind: "fact",
          text: "one two three four five",
          tags: [],
          createdAt: TEST_NOW,
        },
      ])
      await persistSession(
        {
          store: sStore,
          llm: fakeLLM(JSON.stringify({ action: "supersede", oldId: "old" })),
          distill: false,
          now: fixedNow,
        },
        { sessionId: "c10f", finalMessages: [assistant("one two three four six")] },
      )
      const s = await sStore.all()
      expect(s).toHaveLength(2)
      expect(s.find((e) => e.id === "old")?.supersededBy).toBeDefined()
    })
  })

  test("never throws when distill/store blow up", async () => {
    const boomStore: PersistentStorePort = {
      save: () => Promise.reject(new Error("save boom")),
      update: () => Promise.reject(new Error("update boom")),
      delete: () => Promise.reject(new Error("delete boom")),
      get: () => Promise.reject(new Error("get boom")),
      all: () => Promise.reject(new Error("all boom")),
      recall: () => Promise.reject(new Error("recall boom")),
    }
    await expect(
      persistSession(
        { store: boomStore, llm: fakeLLM({ throw: true }) },
        { sessionId: "s10", finalMessages: [assistant("text")] },
      ),
    ).resolves.toBeUndefined()
  })
})
