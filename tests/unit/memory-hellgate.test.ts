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
    const cand = [
      entry({ id: "supAt", supersededBy: "x", createdAt: NOW - STALE_MAX_MS }),
    ]
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
      entry({ id: "freshButDead", createdAt: NOW, supersededBy: "live", embedding: vec(2), importance: 1 }),
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
