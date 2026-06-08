// §10.6 memory routing meta + recall weighting (V1, default-OFF).
//
// Codex `MEMORY.md` FORMAT: each block carries `Task Group:` (retrieval
// grouping), `applies_to: cwd=...; reuse_rule=...` (checkout/scope boundary).
// We add optional `taskGroup` / `appliesTo` / `reuseRule` to MemoryEntry and a
// recall weighting hook that boosts entries whose routing meta matches the
// query's routing context (taskGroup / cwd). The hook is opt-in via
// `query.routing`; ABSENT => ranking is BYTE-IDENTICAL to legacy.

import { describe, expect, test } from "bun:test"
import { rankEntries, scoreEntry } from "@/memory/ranking"
import {
  EMBED_DIM,
  type MemoryEntry,
  type MemoryQuery,
  normalizeEntry,
} from "@/memory/types"

const NOW = 1_000_000_000_000

const entry = (over: Partial<MemoryEntry> & { id: string }): MemoryEntry => ({
  kind: "fact",
  text: "",
  tags: [],
  createdAt: NOW,
  ...over,
})

const ids = (r: { id: string }[]): string[] => r.map((e) => e.id)

describe("§10.6 routing meta — optional fields normalize cleanly", () => {
  test("absent meta fields stay absent after normalize (no default injected)", () => {
    const n = normalizeEntry(entry({ id: "a" }))
    expect(n.taskGroup).toBeUndefined()
    expect(n.appliesTo).toBeUndefined()
    expect(n.reuseRule).toBeUndefined()
  })

  test("present meta fields carry through normalize verbatim", () => {
    const n = normalizeEntry(
      entry({
        id: "a",
        taskGroup: "quanta-cli",
        appliesTo: { cwd: "/Users/x/quanta" },
        reuseRule: "checkout-specific; re-check branch",
      }),
    )
    expect(n.taskGroup).toBe("quanta-cli")
    expect(n.appliesTo).toEqual({ cwd: "/Users/x/quanta" })
    expect(n.reuseRule).toBe("checkout-specific; re-check branch")
  })

  test("non-string / malformed meta is dropped (no-throw, tolerant)", () => {
    const n = normalizeEntry(
      entry({
        id: "a",
        // @ts-expect-error — feed garbage like a corrupt persisted row would
        taskGroup: 42,
        // @ts-expect-error
        appliesTo: "not-an-object",
        // @ts-expect-error
        reuseRule: { nope: true },
      }),
    )
    expect(n.taskGroup).toBeUndefined()
    expect(n.appliesTo).toBeUndefined()
    expect(n.reuseRule).toBeUndefined()
  })

  test("appliesTo with non-string cwd is dropped", () => {
    const n = normalizeEntry(
      entry({
        id: "a",
        // @ts-expect-error — cwd must be a string
        appliesTo: { cwd: 99 },
      }),
    )
    expect(n.appliesTo).toBeUndefined()
  })
})

describe("§10.6 recall weighting — BYTE-IDENTICAL when routing absent", () => {
  // The default-OFF invariant: with no `query.routing`, ranking output is the
  // EXACT same order AND the EXACT same score as before, even when entries
  // carry routing meta. Meta is inert until the query opts in.
  test("entries with routing meta rank identically when query has no routing", () => {
    const cand = [
      entry({ id: "a", taskGroup: "g1", appliesTo: { cwd: "/x" }, importance: 0.5 }),
      entry({ id: "b", taskGroup: "g2", appliesTo: { cwd: "/y" }, importance: 0.5 }),
    ]
    const withoutMeta = [entry({ id: "a", importance: 0.5 }), entry({ id: "b", importance: 0.5 })]
    expect(ids(rankEntries(cand, {}, NOW))).toEqual(ids(rankEntries(withoutMeta, {}, NOW)))
  })

  test("scoreEntry is identical with vs without meta when query has no routing", () => {
    const q: MemoryQuery = { text: "hello" }
    const bare = scoreEntry(entry({ id: "a", text: "hello world" }), q, NOW)
    const withMeta = scoreEntry(
      entry({ id: "a", text: "hello world", taskGroup: "g1", appliesTo: { cwd: "/x" } }),
      q,
      NOW,
    )
    expect(withMeta).toBe(bare)
  })

  test("query.routing present but no meta on entries => no change vs no-routing", () => {
    // A routing-enabled query against entries that have NO meta must not move
    // ranks (nothing matches => zero boost), so it equals the no-routing run.
    const cand = [entry({ id: "a", importance: 0.5 }), entry({ id: "b", importance: 0.5 })]
    const routed: MemoryQuery = { routing: { taskGroup: "g1", cwd: "/x" } }
    expect(ids(rankEntries(cand, routed, NOW))).toEqual(ids(rankEntries(cand, {}, NOW)))
    expect(scoreEntry(cand[0] as MemoryEntry, routed, NOW)).toBe(
      scoreEntry(cand[0] as MemoryEntry, {}, NOW),
    )
  })
})

describe("§10.6 recall weighting — boosts on match (opt-in)", () => {
  test("taskGroup match boosts an entry above an equal-but-unmatched peer", () => {
    const cand = [
      entry({ id: "match", taskGroup: "quanta-cli", importance: 0.5 }),
      entry({ id: "other", taskGroup: "semantica", importance: 0.5 }),
    ]
    const q: MemoryQuery = { routing: { taskGroup: "quanta-cli" } }
    expect(ids(rankEntries(cand, q, NOW))).toEqual(["match", "other"])
    // sanity: equal without routing (tie → id desc: "other" > "match")
    expect(ids(rankEntries(cand, {}, NOW))).toEqual(["other", "match"])
  })

  test("appliesTo.cwd EXACT match boosts; mismatch does not", () => {
    const cand = [
      entry({ id: "here", appliesTo: { cwd: "/Users/x/quanta" }, importance: 0.5 }),
      entry({ id: "elsewhere", appliesTo: { cwd: "/Users/x/other" }, importance: 0.5 }),
    ]
    const q: MemoryQuery = { routing: { cwd: "/Users/x/quanta" } }
    expect(ids(rankEntries(cand, q, NOW))[0]).toBe("here")
  })

  test("cwd FAMILY prefix match boosts (checkout family, weaker than exact)", () => {
    // Codex 'cwd family' — a subdir of the memory's cwd is the same family.
    const cand = [
      entry({ id: "exact", appliesTo: { cwd: "/Users/x/quanta" }, importance: 0.5 }),
      entry({ id: "family", appliesTo: { cwd: "/Users/x/quanta" }, importance: 0.5 }),
      entry({ id: "unrelated", appliesTo: { cwd: "/etc" }, importance: 0.5 }),
    ]
    // query cwd is a subdir of /Users/x/quanta => family match for both, but
    // 'unrelated' gets no boost and sinks.
    const q: MemoryQuery = { routing: { cwd: "/Users/x/quanta/src/memory" } }
    const out = ids(rankEntries(cand, q, NOW))
    expect(out[out.length - 1]).toBe("unrelated")
  })

  test("combined taskGroup + cwd match outranks a single-signal match", () => {
    const cand = [
      entry({ id: "both", taskGroup: "g", appliesTo: { cwd: "/x" }, importance: 0.5 }),
      entry({ id: "groupOnly", taskGroup: "g", appliesTo: { cwd: "/y" }, importance: 0.5 }),
      entry({ id: "cwdOnly", taskGroup: "h", appliesTo: { cwd: "/x" }, importance: 0.5 }),
    ]
    const q: MemoryQuery = { routing: { taskGroup: "g", cwd: "/x" } }
    expect(ids(rankEntries(cand, q, NOW))[0]).toBe("both")
  })

  test("routing boost never reorders past a dominant vector hit (refines, not dominates)", () => {
    const vec = (axis: number): number[] => {
      const v = new Array(EMBED_DIM).fill(0)
      v[axis] = 1
      return v
    }
    const cand = [
      entry({ id: "vec", embedding: vec(3), importance: 0.5 }),
      entry({ id: "routed", taskGroup: "g", appliesTo: { cwd: "/x" }, importance: 0.5 }),
    ]
    const q: MemoryQuery = { embedding: vec(3), routing: { taskGroup: "g", cwd: "/x" } }
    // vector contributes up to W_VEC=10; routing boost must be smaller so the
    // vector hit stays on top.
    expect(ids(rankEntries(cand, q, NOW))[0]).toBe("vec")
  })

  test("routing weighting is deterministic & pure (same inputs => same order)", () => {
    const cand = [
      entry({ id: "a", taskGroup: "g", importance: 0.5 }),
      entry({ id: "b", taskGroup: "h", importance: 0.5 }),
    ]
    const q: MemoryQuery = { routing: { taskGroup: "g" } }
    const r1 = ids(rankEntries(cand, q, NOW))
    const r2 = ids(rankEntries(cand, q, NOW))
    expect(r1).toEqual(r2)
  })
})
