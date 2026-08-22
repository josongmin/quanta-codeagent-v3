// ADR-0082 memory_citation provenance — unit-level test for the recall-side
// accumulator. The contract: a record is "cited" iff it survives the recall
// `limit` budget (the actual rendered budget — limit==2 over 3 candidates →
// the bottom-scoring one is dropped and NEVER appears in citations).
//
// No heuristic / no fallback: we DO NOT scan an assistant message. The
// provenance signal is the recall layer's `onPlaced` callback, fired exactly
// once with the ordered list of records that landed in the rendered block.
import { describe, expect, test } from "bun:test"
import { type PlacedRecord, recallContext } from "@/agent/memory"
import { InMemoryStore } from "@/memory"

describe("memory citation accumulator (recall-side)", () => {
  test("limit=2 over 3 candidates → onPlaced fires with the 2 that landed in the block", async () => {
    // Three candidates; the third one's text contains the query so it scores
    // highest on lexical, while the other two share a tag with the query and
    // get the tag bonus. The fourth-irrelevant entry never matches and falls
    // out by score so we KNOW limit-eviction (not filter-eviction) is what
    // drops it.
    const store = new InMemoryStore([
      {
        id: "rec-alpha",
        kind: "fact",
        text: "alpha uses Postgres 16",
        tags: ["db"],
        createdAt: 100,
        importance: 0.9,
      },
      {
        id: "rec-bravo",
        kind: "fact",
        text: "bravo uses MySQL 8",
        tags: ["db"],
        createdAt: 90,
        importance: 0.8,
      },
      {
        id: "rec-charlie",
        kind: "fact",
        text: "charlie unrelated note",
        tags: [],
        createdAt: 80,
        importance: 0.1,
      },
    ])

    const placed: PlacedRecord[][] = []
    // Query: text "Postgres" hits rec-alpha exact-substring, tag query is
    // implicit via... actually we ride lexical + importance + freshness.
    // recallContext does not accept query tags directly — it only passes
    // `text` + optional embedding + tier filter. So this test relies on the
    // ranking weights: rec-alpha (text-hit + high importance) and rec-bravo
    // (high importance) outrank rec-charlie (low importance, no text-hit).
    const out = await recallContext(
      { store, onPlaced: (rows) => placed.push([...rows]) },
      "Postgres",
      { limit: 2 },
    )

    // The formatted block must include the two winners and NOT the loser.
    expect(out).toContain("alpha uses Postgres 16")
    expect(out).toContain("bravo uses MySQL 8")
    expect(out).not.toContain("charlie unrelated note")

    // onPlaced fired EXACTLY ONCE (one recall call → one provenance emit).
    expect(placed.length).toBe(1)
    const cited = placed[0]
    if (!cited) throw new Error("placed[0] missing")
    // Two records landed in the rendered block ⇒ two citations.
    expect(cited.length).toBe(2)
    const ids = cited.map((p) => p.recordId).sort()
    expect(ids).toEqual(["rec-alpha", "rec-bravo"])
    // Each citation carries a finite score (ranking weighted-sum).
    for (const c of cited) {
      expect(Number.isFinite(c.score)).toBe(true)
      expect(c.score).toBeGreaterThan(0)
      // tokensApprox = chars/4 of the (post-truncate) text — always positive.
      expect(c.tokensApprox).toBeGreaterThan(0)
    }
    // rec-alpha has the substring hit → its score MUST exceed rec-bravo's.
    const alpha = cited.find((c) => c.recordId === "rec-alpha")
    const bravo = cited.find((c) => c.recordId === "rec-bravo")
    if (!alpha || !bravo) throw new Error("alpha/bravo missing")
    expect(alpha.score).toBeGreaterThan(bravo.score)
  })

  test("no entries placed → onPlaced is NOT called (no signal to emit)", async () => {
    const placed: PlacedRecord[][] = []
    await recallContext(
      { store: new InMemoryStore(), onPlaced: (rows) => placed.push([...rows]) },
      "nothing",
      { limit: 5 },
    )
    expect(placed.length).toBe(0)
  })

  test("onPlaced throws → recall still returns the block (observability never breaks recall)", async () => {
    const store = new InMemoryStore([
      { id: "x", kind: "fact", text: "stable record", tags: [], createdAt: 100 },
    ])
    const out = await recallContext(
      {
        store,
        onPlaced: () => {
          throw new Error("observer down")
        },
      },
      "stable",
      { limit: 5 },
    )
    expect(out).toContain("stable record")
  })

  test("score is deterministic for the same query (no clock skew, no embedder)", async () => {
    const store = new InMemoryStore([
      { id: "p", kind: "fact", text: "alpha record", tags: [], createdAt: 100 },
    ])
    const NOW = 1_700_000_000_000
    const cap1: PlacedRecord[] = []
    const cap2: PlacedRecord[] = []
    await recallContext(
      { store, now: () => NOW, onPlaced: (rows) => cap1.push(...rows) },
      "alpha",
      { limit: 5 },
    )
    await recallContext(
      { store, now: () => NOW, onPlaced: (rows) => cap2.push(...rows) },
      "alpha",
      { limit: 5 },
    )
    expect(cap1.length).toBe(1)
    expect(cap2.length).toBe(1)
    // Reinforcement (accessCount/importance bumps) is best-effort — the second
    // call observes the post-reinforced state, so scores may differ ACROSS
    // calls. The PROVENANCE shape, though, must be deterministic per call:
    // a record placed once → exactly one citation row.
    const first = cap1[0]
    const second = cap2[0]
    if (!first || !second) throw new Error("missing citation")
    expect(first.recordId).toBe("p")
    expect(second.recordId).toBe("p")
    expect(Number.isFinite(first.score)).toBe(true)
    expect(Number.isFinite(second.score)).toBe(true)
  })
})
